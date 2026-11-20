//! The network task shared by the chat UI and the headless commands: the account connection
//! (chat traffic) and the device connection (sync between our own devices), the paced sync
//! outbox, linking and the history copy.
use crate::devices::{self, Effects, HxRuntime, Keys};
use crate::engine::{self, Shown};
use crate::relay::{Event, Relay};
use crate::store::Store;
use crate::{now_ms, Error, Result};
use miga_core::identity::Identity;
use miga_core::sync::{Tomb, TombKind};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::time::{interval, sleep, timeout};

/// The sync outbox sends one frame per 400 ms (the relay allows 30 sends per 10 s).
const OUTBOX_MS: u64 = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conn {
    Connecting,
    Online,
    Offline,
}

/// What to do locally once the relay confirms a frame (`sent`).
#[derive(Debug, Clone)]
pub enum After {
    Sent,
    Edit { msg_id: String, text: String, ts: i64 },
    Delete { msg_id: String },
    Nothing,
}

#[derive(Debug)]
pub enum Cmd {
    /// A frame for the account connection.
    Send {
        peer: String,
        id: String,
        body: String,
        after: After,
    },
    /// A sync message (`None` = every other device).
    Sync(Option<String>, Value),
    /// Live typing frame (ephemeral).
    Live {
        peer: String,
        body: String,
    },
    AddDevice,
    CancelLink,
    RemoveDevice(String),
    CopyHistory(String),
    /// Leave the account on this device and erase all local data.
    EraseSelf,
    /// Encrypt, upload and send a file with a caption.
    SendFile {
        peer: String,
        path: String,
        caption: String,
    },
    /// Download and decrypt an attachment into the files folder.
    Fetch {
        peer: String,
        id: String,
    },
    /// Internal: an upload finished.
    Uploaded {
        peer: String,
        caption: String,
        att: Box<miga_core::attach::Att>,
    },
}

#[derive(Debug)]
pub enum HubEvent {
    Conn(Conn),
    /// The stored conversation with `peer` changed. `shown` is set for a new incoming message.
    Changed {
        peer: String,
        shown: Option<Shown>,
    },
    Notice(String),
    /// A link code is on offer.
    Link {
        code: String,
        expires: i64,
    },
    LinkEnded(String),
    Devices,
    /// History copy progress `(done, total)`; `done == total` at the end.
    Progress(u64, u64),
    /// A chat counts as read up to this time (another device read it, or it is old history).
    Read(String, f64),
    /// This device was removed; local data is gone.
    Erased,
    /// The relay confirmed one of our frames.
    Confirmed(String),
    Live {
        from: String,
        text: String,
    },
    /// An attachment was saved to this path.
    FileReady {
        peer: String,
        id: String,
        path: String,
    },
    /// Every sync message queued so far has left.
    Drained,
}

struct Hub {
    store: Arc<Store>,
    keys: Keys,
    url: String,
    tx: UnboundedSender<HubEvent>,
    outbox: VecDeque<(String, String, String)>,
    inflight: HashMap<String, (String, After)>,
    owed: BTreeMap<String, Vec<String>>,
    rt: HxRuntime,
    link: Option<(Identity, i64)>,
    inner: UnboundedSender<Cmd>,
    erase_at: Option<std::time::Instant>,
}

pub async fn run(
    store: Arc<Store>,
    url: String,
    mut cmds: UnboundedReceiver<Cmd>,
    tx: UnboundedSender<HubEvent>,
) -> Result<()> {
    let keys = Keys::load(&store)?;
    let (inner, mut inner_rx) = tokio::sync::mpsc::unbounded_channel::<Cmd>();
    let mut hub = Hub {
        inner,
        store,
        keys,
        url,
        tx,
        outbox: VecDeque::new(),
        inflight: HashMap::new(),
        owed: BTreeMap::new(),
        rt: HxRuntime::default(),
        link: None,
        erase_at: None,
    };
    // A code left open by an earlier run can no longer be shown: delete its bundle now.
    if let Some(seed) = hub.store.meta("open_link").as_str().and_then(|s| Identity::from_seed_hex(s).ok()) {
        hub.sweep(seed);
    }
    let mut backoff = 1u64;
    loop {
        let _ = hub.tx.send(HubEvent::Conn(Conn::Connecting));
        let account = Relay::connect(&hub.url, &hub.keys.account).await;
        let device = Relay::connect(&hub.url, &hub.keys.device).await;
        match (account, device) {
            (Ok(mut a), Ok(mut d)) => {
                backoff = 1;
                while cmds.try_recv().is_ok() {}
                let _ = hub.tx.send(HubEvent::Conn(Conn::Online));
                match hub.session(&mut a, &mut d, &mut cmds, &mut inner_rx).await {
                    Ok(()) => return Ok(()),
                    Err(Error::Invalid(m)) if m == "erased" => return Ok(()),
                    Err(_) => {
                        let _ = hub.tx.send(HubEvent::Conn(Conn::Offline));
                    }
                }
            }
            _ => {
                let _ = hub.tx.send(HubEvent::Conn(Conn::Offline));
            }
        }
        let jitter = miga_core::random_bytes::<1>().map_or(0, |b| u64::from(b[0]) * 500 / 255);
        sleep(Duration::from_millis(backoff * 1000 + jitter)).await;
        backoff = (backoff * 2).min(30);
    }
}

impl Hub {
    fn emit(&self, e: HubEvent) {
        let _ = self.tx.send(e);
    }

    fn queue_sync(&mut self, to: Option<String>, msg: &Value) -> Result<()> {
        let targets = match to {
            Some(t) => vec![t],
            None => devices::other_devices(&self.store, &self.keys),
        };
        for t in targets {
            let body = self.keys.seal_to(&t, msg)?;
            self.outbox.push_back((t, miga_core::random_id()?, body));
        }
        Ok(())
    }

    /// Connects as a code's mailbox and acknowledges whatever waits there, then forgets the code.
    fn sweep(&self, mailbox: Identity) {
        let url = self.url.clone();
        let store = self.store.clone();
        tokio::spawn(async move {
            if let Ok(mut r) = Relay::connect(&url, &mailbox).await {
                let _ = timeout(Duration::from_secs(6), async {
                    while let Ok(ev) = r.next().await {
                        if let Event::Msg { from, id, .. } = ev {
                            let _ = r.ack(&from, &id).await;
                        }
                    }
                })
                .await;
                r.close().await;
            }
            let _ = store.set_meta("open_link", Value::Null);
        });
    }

    fn end_link(&mut self, message: &str) {
        if let Some((mailbox, _)) = self.link.take() {
            self.sweep(mailbox);
            self.emit(HubEvent::LinkEnded(message.to_string()));
        }
    }

    fn apply_fx(&mut self, fx: Effects) -> Result<()> {
        for (to, m) in fx.send {
            self.queue_sync(to, &m)?;
        }
        if fx.notes.iter().any(|n| n == "linked") {
            self.end_link("Device linked");
        }
        for peer in fx.changed {
            self.emit(HubEvent::Changed { peer, shown: None });
        }
        for (peer, ts) in fx.read {
            self.emit(HubEvent::Read(peer, ts));
        }
        if fx.devices {
            self.emit(HubEvent::Devices);
        }
        if let Some((d, t)) = fx.progress {
            self.emit(HubEvent::Progress(d, t));
        }
        if fx.erase {
            self.erase_at = Some(std::time::Instant::now() + Duration::from_millis(300));
        }
        Ok(())
    }

    async fn session(
        &mut self,
        acct: &mut Relay,
        dev: &mut Relay,
        cmds: &mut UnboundedReceiver<Cmd>,
        inner: &mut UnboundedReceiver<Cmd>,
    ) -> Result<()> {
        self.inflight.clear();
        self.rt = HxRuntime::default();
        // Anything that never got a `sent` goes out again (fresh nonce and ts, same id).
        for c in self.store.contacts()? {
            for m in self.store.pending(&c.address)? {
                let out = engine::reseal_pending(&self.store, &self.keys.account, &c.address, &m)?;
                acct.send(&c.address, &out.id, &out.body).await?;
                self.inflight.insert(out.id, (c.address.clone(), After::Sent));
                sleep(Duration::from_millis(100)).await;
            }
        }
        if self.store.meta("hello_pending").as_bool() == Some(true) {
            let sponsor = self.store.meta("hello_sponsor").as_str().unwrap_or_default().to_string();
            self.queue_sync(None, &json!({"k": "hello", "label": devices::device_label(), "sponsor": sponsor}))?;
        }
        if let Some((to, m)) = devices::hx_query(&self.store, &self.keys, &mut self.rt, now_ms())? {
            self.queue_sync(Some(to), &m)?;
        }
        let mut outbox_tick = interval(Duration::from_millis(OUTBOX_MS));
        let mut tick = interval(Duration::from_secs(1));
        let mut hx_tick = interval(Duration::from_secs(5));
        let mut was_busy = !self.outbox.is_empty();
        loop {
            tokio::select! {
                ev = acct.next() => self.on_account(acct, ev?).await?,
                ev = dev.next() => {
                    if let Event::Msg { from, id, body, ts } = ev? {
                        let fx = devices::handle_sync(&self.store, &self.keys, &mut self.rt, &from, &body, ts)?;
                        dev.ack(&from, &id).await?;
                        let erase = fx.erase;
                        self.apply_fx(fx)?;
                        if erase {
                            sleep(Duration::from_millis(300)).await;
                            self.erase_everything()?;
                            return Err(Error::Invalid("erased".into()));
                        }
                    }
                }
                cmd = inner.recv() => {
                    if let Some(cmd) = cmd {
                        self.on_cmd(acct, dev, cmd).await?;
                    }
                }
                cmd = cmds.recv() => {
                    let Some(cmd) = cmd else { return Ok(()) };
                    if self.on_cmd(acct, dev, cmd).await? {
                        return Err(Error::Invalid("erased".into()));
                    }
                }
                _ = outbox_tick.tick() => {
                    if let Some((to, id, body)) = self.outbox.front().cloned() {
                        dev.send(&to, &id, &body).await?;
                        self.outbox.pop_front();
                    } else if was_busy {
                        was_busy = false;
                        self.emit(HubEvent::Drained);
                    }
                    if !self.outbox.is_empty() {
                        was_busy = true;
                    }
                }
                _ = hx_tick.tick() => {
                    if let Some((to, m)) = devices::hx_query(&self.store, &self.keys, &mut self.rt, now_ms())? {
                        self.queue_sync(Some(to), &m)?;
                    }
                }
                _ = tick.tick() => {
                    if let Some((_, exp)) = &self.link {
                        if now_ms() > *exp {
                            self.end_link("The code expired");
                        }
                    }
                    for (peer, ids) in std::mem::take(&mut self.owed) {
                        for chunk in ids.chunks(50) {
                            let body = engine::delivery_receipt(&self.keys.account, &peer, chunk)?;
                            acct.send(&peer, &miga_core::random_id()?, &body).await?;
                            sleep(Duration::from_millis(400)).await;
                        }
                    }
                }
            }
        }
    }

    async fn on_account(&mut self, acct: &mut Relay, ev: Event) -> Result<()> {
        match ev {
            Event::Msg { from, id, body, ts } => {
                let handled = engine::handle_incoming(&self.store, &self.keys.account, &from, &id, &body, ts)?;
                if handled.ack {
                    acct.ack(&from, &id).await?;
                }
                if let Some(r) = handled.receipt {
                    self.owed.entry(from.clone()).or_default().push(r);
                }
                for (to, m) in handled.forward {
                    self.queue_sync(to, &m)?;
                }
                self.emit(HubEvent::Changed { peer: from, shown: handled.shown });
            }
            Event::Live { from, body } => {
                if !self.store.addresses("blocked").contains(&from) {
                    if let Some(p) = miga_core::payload::decrypt(&self.keys.account, &from, &body, now_ms() as f64) {
                        if let Some(text) = p.live {
                            self.emit(HubEvent::Live { from, text });
                        }
                    }
                }
            }
            Event::Sent { id } => {
                if let Some((peer, after)) = self.inflight.remove(&id) {
                    self.after_sent(acct, &peer, &id, after).await?;
                    self.emit(HubEvent::Confirmed(id));
                    self.emit(HubEvent::Changed { peer, shown: None });
                }
            }
            Event::Error { err, id } => {
                if let Some((peer, after)) = id.as_ref().and_then(|i| self.inflight.remove(i)) {
                    if let (After::Sent, Some(id)) = (&after, &id) {
                        self.store.update_own(&peer, id, |m| m["state"] = "failed".into())?;
                    }
                    self.emit(HubEvent::Changed { peer, shown: None });
                    self.emit(HubEvent::Notice(format!("The relay refused a message: {err}")));
                    if let Some(id) = id {
                        self.emit(HubEvent::Confirmed(id));
                    }
                } else if err != "bad_frame" {
                    self.emit(HubEvent::Notice(format!("Relay error: {err}")));
                }
            }
            Event::Other => {}
        }
        Ok(())
    }

    async fn after_sent(&mut self, acct: &mut Relay, peer: &str, id: &str, after: After) -> Result<()> {
        match after {
            After::Sent => {
                self.store.update_own(peer, id, |m| {
                    if m["state"] == "pending" {
                        m["state"] = "sent".into();
                    }
                })?;
                if let Some(m) = self.store.chat(peer)?.into_iter().find(|m| m["mine"] == true && m["id"] == id) {
                    self.queue_sync(None, &json!({"k": "msg", "peer": peer, "message": m}))?;
                }
            }
            After::Edit { msg_id, text, ts } => {
                if engine::apply_own_edit(&self.store, peer, &msg_id, &text, ts)? {
                    self.queue_sync(
                        None,
                        &json!({"k": "edit", "peer": peer, "id": msg_id, "mine": true, "text": text, "ts": ts}),
                    )?;
                }
            }
            After::Delete { msg_id } => {
                acct.unsend(peer, &msg_id).await?;
                if let Some(att) = self
                    .store
                    .chat(peer)?
                    .into_iter()
                    .find(|m| m["mine"] == true && m["id"] == msg_id.as_str())
                    .and_then(|m| miga_core::attach::clean_att(&m["att"], true))
                {
                    let url = self.url.clone();
                    tokio::task::spawn_blocking(move || crate::files::delete_blob(&url, &att));
                }
                engine::apply_own_delete(&self.store, peer, &msg_id)?;
                let t = Tomb { chat: peer.into(), kind: TombKind::Message, id: Some(msg_id), mine: true, ts: now_ms() };
                for (to, m) in devices::remember_deletes(&self.store, &[t])? {
                    self.queue_sync(to, &m)?;
                }
            }
            After::Nothing => {}
        }
        Ok(())
    }

    /// Returns true when the device erased itself.
    async fn on_cmd(&mut self, acct: &mut Relay, _dev: &mut Relay, cmd: Cmd) -> Result<bool> {
        match cmd {
            Cmd::Send { peer, id, body, after } => {
                acct.send(&peer, &id, &body).await?;
                self.inflight.insert(id, (peer, after));
            }
            Cmd::Sync(to, m) => self.queue_sync(to, &m)?,
            Cmd::Live { peer, body } => acct.send_eph(&peer, &body).await?,
            Cmd::AddDevice => {
                if self.link.is_some() {
                    self.end_link("");
                }
                let offer = devices::new_offer(&self.store, &self.keys)?;
                self.outbox.push_back((offer.mailbox.address().to_string(), miga_core::random_id()?, offer.body));
                self.link = Some((offer.mailbox, offer.expires));
                self.emit(HubEvent::Link { code: offer.code, expires: offer.expires });
            }
            Cmd::CancelLink => self.end_link("Link cancelled"),
            Cmd::RemoveDevice(address) => {
                self.queue_sync(None, &json!({"k": "bye", "address": address}))?;
                let list: Vec<Value> =
                    devices::devices(&self.store).into_iter().filter(|d| d["address"] != address.as_str()).collect();
                self.store.set_meta("devices", Value::Array(list))?;
                self.emit(HubEvent::Devices);
            }
            Cmd::CopyHistory(address) => {
                if devices::hx_job(&self.store).is_none() {
                    devices::start_hx(&self.store, &address)?;
                    self.rt = HxRuntime::default();
                    if let Some((to, m)) = devices::hx_query(&self.store, &self.keys, &mut self.rt, now_ms())? {
                        self.queue_sync(Some(to), &m)?;
                    }
                }
            }
            Cmd::SendFile { peer, path, caption } => {
                let (url, tx, inner) = (self.url.clone(), self.tx.clone(), self.inner.clone());
                tokio::task::spawn_blocking(move || {
                    let res = crate::files::prepare(std::path::Path::new(&path)).and_then(|p| {
                        let note = if p.stripped { " (metadata removed)" } else { "" };
                        crate::files::upload(&url, &p).map(|a| (a, note))
                    });
                    match res {
                        Ok((att, note)) => {
                            let _ = tx.send(HubEvent::Notice(format!("Uploaded{note}; sending")));
                            let _ = inner.send(Cmd::Uploaded { peer, caption, att: Box::new(att) });
                        }
                        Err(e) => {
                            let _ = tx.send(HubEvent::Notice(format!("Could not send the file: {e}")));
                            let _ = tx.send(HubEvent::Confirmed(String::new()));
                        }
                    }
                });
            }
            Cmd::Uploaded { peer, caption, att } => {
                let out = engine::prepare_attachment(&self.store, &self.keys.account, &peer, &caption, &att)?;
                acct.send(&peer, &out.id, &out.body).await?;
                self.inflight.insert(out.id.clone(), (peer.clone(), After::Sent));
                self.emit(HubEvent::Changed { peer, shown: None });
            }
            Cmd::Fetch { peer, id } => {
                let msg = self.store.chat(&peer)?.into_iter().find(|m| m["id"] == id.as_str());
                let Some(att) = msg.and_then(|m| miga_core::attach::clean_att(&m["att"], true)) else {
                    self.emit(HubEvent::Notice("No attachment in that message".into()));
                    return Ok(false);
                };
                let dir = self.store.files_dir();
                let (url, tx) = (self.url.clone(), self.tx.clone());
                tokio::task::spawn_blocking(move || {
                    let path = dir.join(crate::files::saved_name(&att));
                    let res = if path.exists() {
                        Ok(())
                    } else {
                        crate::files::download(&url, &att).and_then(|bytes| {
                            std::fs::create_dir_all(&dir)?;
                            std::fs::write(&path, bytes)?;
                            Ok(())
                        })
                    };
                    match res {
                        Ok(()) => {
                            let _ =
                                tx.send(HubEvent::FileReady { peer, id, path: path.to_string_lossy().into_owned() });
                        }
                        Err(e) => {
                            let _ = tx.send(HubEvent::Notice(format!("{e}")));
                        }
                    }
                });
            }
            Cmd::EraseSelf => {
                self.queue_sync(None, &json!({"k": "bye", "address": self.keys.device.address()}))?;
                // Give the goodbye time to leave before the keys are gone.
                for _ in 0..10 {
                    if let Some((to, id, body)) = self.outbox.pop_front() {
                        _dev.send(&to, &id, &body).await?;
                        sleep(Duration::from_millis(OUTBOX_MS)).await;
                    }
                }
                self.erase_everything()?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn erase_everything(&mut self) -> Result<()> {
        let _ = std::fs::remove_dir_all(self.store.data_dir());
        let _ = std::fs::remove_dir_all(self.store.config_dir());
        self.emit(HubEvent::Erased);
        Ok(())
    }
}

/// Joins an existing account with a typed link code (the new device side). Writes the identity and
/// the history job; the hub then sends `hello` and copies the history.
pub async fn join(store: &Store, url: &str, input: &str) -> Result<()> {
    let code = miga_core::link::normalize_link_code(input)
        .ok_or_else(|| Error::Invalid("that is not a valid link code (12 characters, e.g. G857-6A7E-NR5M)".into()))?;
    if store.has_identity() {
        return Err(Error::Invalid("this profile already has an account; use a new --profile".into()));
    }
    let keys = miga_core::link::derive_link(&code)?;
    let mut relay = timeout(Duration::from_secs(20), Relay::connect(url, &keys.mailbox))
        .await
        .map_err(|_| Error::Relay("could not reach the relay (linking needs a connection)".into()))??;
    let wait = async {
        loop {
            if let Event::Msg { from, id, body, .. } = relay.next().await? {
                let bundle = miga_core::link::open_value(&keys.bundle_key, &body, "");
                // Stale or foreign content is acknowledged so it is deleted from the relay.
                relay.ack(&from, &id).await?;
                if let Some(b) = bundle.filter(|b| miga_core::link::accept_bundle(b, now_ms() as f64)) {
                    return Ok::<Value, Error>(b);
                }
            }
        }
    };
    let bundle = timeout(Duration::from_secs(60), wait).await.map_err(|_| {
        Error::Relay("no link arrived: the code is wrong, used or expired (codes last 10 minutes)".into())
    })??;
    devices::adopt_bundle(store, &bundle)?;
    relay.close().await;
    Ok(())
}
