//! The network task: one relay connection with reconnect, resend of pending messages, receipts.
use super::app::Conn;
use miga_client::engine::{self, Shown};
use miga_client::relay::{Event, Relay};
use miga_client::store::Store;
use miga_client::Result;
use miga_core::identity::Identity;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::time::{interval, sleep};

/// What to do locally once the relay confirms a frame (`sent`).
#[derive(Debug, Clone)]
pub enum After {
    /// A new message: pending becomes sent.
    Sent,
    Edit {
        msg_id: String,
        text: String,
        ts: i64,
    },
    Delete {
        msg_id: String,
    },
    Nothing,
}

#[derive(Debug)]
pub struct Cmd {
    pub peer: String,
    /// Relay frame id (the message id for a text message).
    pub id: String,
    pub body: String,
    pub after: After,
}

#[derive(Debug)]
pub enum NetEvent {
    Conn(Conn),
    /// The stored conversation with `peer` changed. `shown` is set for a new incoming message.
    Changed {
        peer: String,
        shown: Option<Shown>,
    },
    Notice(String),
}

pub async fn run(
    store: Arc<Store>,
    me: Identity,
    url: String,
    mut cmds: UnboundedReceiver<Cmd>,
    tx: UnboundedSender<NetEvent>,
) {
    let mut backoff = 1u64;
    loop {
        let _ = tx.send(NetEvent::Conn(Conn::Connecting));
        match Relay::connect(&url, &me).await {
            Ok(mut relay) => {
                backoff = 1;
                while cmds.try_recv().is_ok() {}
                let _ = tx.send(NetEvent::Conn(Conn::Online));
                match session(&store, &me, &mut relay, &mut cmds, &tx).await {
                    Ok(()) => return,
                    Err(_) => {
                        let _ = tx.send(NetEvent::Conn(Conn::Offline));
                    }
                }
            }
            Err(_) => {
                let _ = tx.send(NetEvent::Conn(Conn::Offline));
            }
        }
        let jitter = miga_core::random_bytes::<1>().map_or(0, |b| u64::from(b[0]) * 500 / 255);
        sleep(Duration::from_millis(backoff * 1000 + jitter)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn session(
    store: &Store,
    me: &Identity,
    relay: &mut Relay,
    cmds: &mut UnboundedReceiver<Cmd>,
    tx: &UnboundedSender<NetEvent>,
) -> Result<()> {
    let mut inflight: HashMap<String, (String, After)> = HashMap::new();
    // Anything that never got a `sent` goes out again (fresh nonce and ts, same id).
    for c in store.contacts()? {
        for m in store.pending(&c.address)? {
            let out = engine::reseal_pending(store, me, &c.address, &m)?;
            relay.send(&c.address, &out.id, &out.body).await?;
            inflight.insert(out.id, (c.address.clone(), After::Sent));
            sleep(Duration::from_millis(100)).await;
        }
    }
    let mut owed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut tick = interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            event = relay.next() => match event? {
                Event::Msg { from, id, body, ts } => {
                    let handled = engine::handle_incoming(store, me, &from, &id, &body, ts)?;
                    if handled.ack {
                        relay.ack(&from, &id).await?;
                    }
                    if let Some(r) = handled.receipt {
                        owed.entry(from.clone()).or_default().push(r);
                    }
                    let _ = tx.send(NetEvent::Changed { peer: from, shown: handled.shown });
                }
                Event::Sent { id } => {
                    if let Some((peer, after)) = inflight.remove(&id) {
                        apply(store, &peer, &id, after)?;
                        let _ = tx.send(NetEvent::Changed { peer, shown: None });
                    }
                }
                Event::Error { err, id } => {
                    if let Some((peer, after)) = id.as_ref().and_then(|i| inflight.remove(i)) {
                        if let (After::Sent, Some(id)) = (&after, &id) {
                            store.update_own(&peer, id, |m| m["state"] = "failed".into())?;
                        }
                        let _ = tx.send(NetEvent::Changed { peer, shown: None });
                        let _ = tx.send(NetEvent::Notice(format!("The relay refused a message: {err}")));
                    } else if err != "bad_frame" {
                        let _ = tx.send(NetEvent::Notice(format!("Relay error: {err}")));
                    }
                }
                Event::Live { .. } | Event::Other => {}
            },
            cmd = cmds.recv() => {
                let Some(cmd) = cmd else { return Ok(()) };
                relay.send(&cmd.peer, &cmd.id, &cmd.body).await?;
                inflight.insert(cmd.id, (cmd.peer, cmd.after));
            }
            _ = tick.tick() => {
                for (peer, ids) in std::mem::take(&mut owed) {
                    for chunk in ids.chunks(50) {
                        let body = engine::delivery_receipt(me, &peer, chunk)?;
                        relay.send(&peer, &miga_core::random_id()?, &body).await?;
                        sleep(Duration::from_millis(400)).await;
                    }
                }
            }
        }
    }
}

fn apply(store: &Store, peer: &str, id: &str, after: After) -> Result<()> {
    match after {
        After::Sent => {
            store.update_own(peer, id, |m| {
                if m["state"] == "pending" {
                    m["state"] = "sent".into();
                }
            })?;
        }
        After::Edit { msg_id, text, ts } => {
            engine::apply_own_edit(store, peer, &msg_id, &text, ts)?;
        }
        After::Delete { msg_id } => {
            engine::apply_own_delete(store, peer, &msg_id)?;
        }
        After::Nothing => {}
    }
    Ok(())
}
