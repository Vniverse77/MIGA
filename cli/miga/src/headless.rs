//! Subcommands that run without the chat UI. They use the same network task as the UI.
use crate::{qr, resolve, stamp};
use miga_client::engine;
use miga_client::hub::{self, After, Cmd, HubEvent};
use miga_client::store::Store;
use miga_client::{now_ms, Error, Result};
use miga_core::link::format_link_code;
use std::io::IsTerminal;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::timeout;

type Hub = (UnboundedSender<Cmd>, UnboundedReceiver<HubEvent>, tokio::task::JoinHandle<Result<()>>);

fn start(store: &Arc<Store>, relay: &str) -> Hub {
    let (cmd_tx, cmd_rx) = unbounded_channel();
    let (ev_tx, ev_rx) = unbounded_channel();
    let task = tokio::spawn(hub::run(store.clone(), relay.to_string(), cmd_rx, ev_tx));
    (cmd_tx, ev_rx, task)
}

/// Waits (up to `limit`) for an event the closure accepts.
async fn wait_for<T>(
    rx: &mut UnboundedReceiver<HubEvent>,
    limit: Duration,
    mut pick: impl FnMut(HubEvent) -> Option<T>,
) -> Option<T> {
    timeout(limit, async {
        while let Some(e) = rx.recv().await {
            if let Some(v) = pick(e) {
                return Some(v);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

pub async fn send(
    store: &Store,
    relay: &str,
    contact: &str,
    words: Vec<String>,
    file: Option<std::path::PathBuf>,
) -> Result<()> {
    let me = store.identity()?;
    let peer = resolve(store, &me, contact)?;
    if store.find_contact(&peer)?.is_none() {
        store.upsert_contact(&peer, &format!("{}...", &peer[..8]))?;
    }
    let mut text = words.join(" ");
    if text.is_empty() && !std::io::stdin().is_terminal() {
        tokio::io::stdin().read_to_string(&mut text).await?;
    }
    engine::check_peer(&me, &peer)?;
    if let Some(file) = file {
        return send_file(store, relay, peer, &file, &text).await;
    }
    let out = engine::prepare_text(store, &me, &peer, &text)?;
    let store = Arc::new(Store::open_like(store));
    let (cmds, mut events, task) = start(&store, relay);
    let id = out.id.clone();
    let _ = cmds.send(Cmd::Send { peer, id: out.id, body: out.body, after: After::Sent });
    // The first connection event may arrive before the command is read; Send is retried by `pending`.
    let done = wait_for(&mut events, Duration::from_secs(25), |e| match e {
        HubEvent::Confirmed(c) if c == id => Some(()),
        _ => None,
    })
    .await;
    if done.is_none() {
        task.abort();
        return Err(Error::Relay(
            "the relay did not confirm; the message is saved as pending and goes out on the next `miga listen`".into(),
        ));
    }
    // Let the sync copy for our other devices leave.
    let _ = wait_for(&mut events, Duration::from_secs(8), |e| matches!(e, HubEvent::Drained).then_some(())).await;
    task.abort();
    println!("sent {}", &id[..8]);
    Ok(())
}

pub async fn listen(store: &Store, relay: &str, limit: Option<u64>, count: Option<usize>) -> Result<()> {
    let me = store.identity()?;
    eprintln!("listening as {} on {relay}", me.address());
    let store = Arc::new(Store::open_like(store));
    let (_cmds, mut events, task) = start(&store, relay);
    let deadline = limit.map(|s| tokio::time::Instant::now() + Duration::from_secs(s));
    let mut received = 0usize;
    loop {
        let next = match deadline {
            Some(d) => match tokio::time::timeout_at(d, events.recv()).await {
                Ok(e) => e,
                Err(_) => break,
            },
            None => events.recv().await,
        };
        let Some(ev) = next else { break };
        match ev {
            HubEvent::Changed { shown: Some(m), .. } => {
                received += 1;
                let att = if m.has_attachment { " [attachment]" } else { "" };
                println!("[{}] {}: {}{att}", stamp(m.ts), m.name, m.text);
                if count.is_some_and(|n| received >= n) {
                    break;
                }
            }
            HubEvent::Notice(n) => eprintln!("miga: {n}"),
            HubEvent::Progress(d, t) => eprintln!("history: {d}/{t}"),
            HubEvent::Erased => {
                eprintln!("miga: this device was removed from the account; local data erased");
                break;
            }
            _ => {}
        }
    }
    // Receipts for what was just shown leave on the next tick.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    task.abort();
    Ok(())
}

pub async fn link(store: &Store, relay: &str, stay: u64) -> Result<()> {
    store.identity()?;
    let store = Arc::new(Store::open_like(store));
    let (cmds, mut events, task) = start(&store, relay);
    wait_for(&mut events, Duration::from_secs(30), |e| matches!(e, HubEvent::Conn(hub::Conn::Online)).then_some(()))
        .await
        .ok_or_else(|| Error::Relay("could not reach the relay (linking needs a connection)".into()))?;
    let _ = cmds.send(Cmd::AddDevice);
    let (code, expires) = wait_for(&mut events, Duration::from_secs(20), |e| match e {
        HubEvent::Link { code, expires } => Some((code, expires)),
        _ => None,
    })
    .await
    .ok_or_else(|| Error::Relay("could not make a link code".into()))?;
    let url = qr::link_url(relay, &code);
    if let Some(lines) = qr::lines(&url) {
        for l in lines {
            println!("  {l}");
        }
    }
    println!();
    println!("  Link code: {}", format_link_code(&code));
    println!(
        "  Valid for {} minutes. Scan the QR code with the MIGA app (Settings > Devices > Scan),",
        (expires - now_ms()) / 60_000 + 1
    );
    println!("  or type the code on the new device. Scan it only on your own device; do not share a screenshot.");
    let ended = wait_for(&mut events, Duration::from_secs(660), |e| match e {
        HubEvent::LinkEnded(m) => Some(m),
        _ => None,
    })
    .await
    .unwrap_or_default();
    if ended == "Device linked" {
        eprintln!("Device linked. Serving the history copy for {stay} s (Ctrl+C to stop)...");
        let _ = timeout(Duration::from_secs(stay), async { while events.recv().await.is_some() {} }).await;
    } else {
        eprintln!("{}", if ended.is_empty() { "No device linked." } else { &ended });
    }
    task.abort();
    Ok(())
}

pub async fn join(store: &Store, relay: &str, code: &str) -> Result<()> {
    eprintln!("Looking for the link on the relay (the key derivation takes a moment)...");
    hub::join(store, relay, code).await?;
    eprintln!("Joined. Copying history from your other device (keep it online)...");
    let store = Arc::new(Store::open_like(store));
    let (_cmds, mut events, task) = start(&store, relay);
    let mut last = 0;
    let finished = wait_for(&mut events, Duration::from_secs(900), |e| match e {
        HubEvent::Progress(d, t) => {
            if d != last {
                last = d;
                eprintln!("history: {d}/{t}");
            }
            (d == t).then_some(())
        }
        _ => None,
    })
    .await;
    task.abort();
    if finished.is_none() {
        return Err(Error::Relay("the history copy did not finish; run `miga listen` to resume it".into()));
    }
    println!("{}", store.identity()?.address());
    Ok(())
}

pub async fn devices(store: &Store, relay: &str, remove: Option<String>) -> Result<()> {
    let keys = miga_client::devices::Keys::load(store)?;
    if let Some(addr) = remove {
        let full = miga_client::devices::devices(store)
            .iter()
            .filter_map(|d| d["address"].as_str())
            .find(|a| a.starts_with(&addr.to_lowercase()))
            .map(str::to_string)
            .ok_or_else(|| Error::Invalid("no such device".into()))?;
        let store = Arc::new(Store::open_like(store));
        let (cmds, mut events, task) = start(&store, relay);
        let _ = wait_for(&mut events, Duration::from_secs(30), |e| {
            matches!(e, HubEvent::Conn(hub::Conn::Online)).then_some(())
        })
        .await;
        let _ = cmds.send(Cmd::RemoveDevice(full));
        let _ = wait_for(&mut events, Duration::from_secs(10), |e| matches!(e, HubEvent::Drained).then_some(())).await;
        task.abort();
        println!("removed");
        return Ok(());
    }
    println!("{}  {}  (this device)", keys.device.address(), miga_client::devices::device_label());
    for d in miga_client::devices::devices(store) {
        println!("{}  {}", d["address"].as_str().unwrap_or("?"), d["label"].as_str().unwrap_or(""));
    }
    Ok(())
}

async fn send_file(store: &Store, relay: &str, peer: String, file: &std::path::Path, caption: &str) -> Result<()> {
    let store = Arc::new(Store::open_like(store));
    let (cmds, mut events, task) = start(&store, relay);
    wait_for(&mut events, Duration::from_secs(30), |e| matches!(e, HubEvent::Conn(hub::Conn::Online)).then_some(()))
        .await
        .ok_or_else(|| Error::Relay("could not reach the relay".into()))?;
    let _ = cmds.send(Cmd::SendFile { peer, path: file.to_string_lossy().into_owned(), caption: caption.to_string() });
    let mut error = None;
    let done = wait_for(&mut events, Duration::from_secs(150), |e| match e {
        HubEvent::Confirmed(id) => Some(id),
        HubEvent::Notice(n) if n.starts_with("Could not") || n.starts_with("The relay refused") => {
            error = Some(n);
            Some(String::new())
        }
        HubEvent::Notice(n) => {
            eprintln!("{n}");
            None
        }
        _ => None,
    })
    .await;
    if let Some(e) = error {
        task.abort();
        return Err(Error::Relay(e));
    }
    let id = done.ok_or_else(|| Error::Relay("the relay did not confirm the file".into()))?;
    let _ = wait_for(&mut events, Duration::from_secs(8), |e| matches!(e, HubEvent::Drained).then_some(())).await;
    task.abort();
    println!("sent file {}", &id[..8.min(id.len())]);
    Ok(())
}

pub async fn get(store: &Store, relay: &str, contact: &str, id: &str, out: Option<std::path::PathBuf>) -> Result<()> {
    let me = store.identity()?;
    let peer = resolve(store, &me, contact)?;
    let msg = store
        .chat(&peer)?
        .into_iter()
        .find(|m| m["id"].as_str().is_some_and(|i| i.starts_with(id)) && m["att"].is_object())
        .ok_or_else(|| Error::Invalid("no attachment with that id in this chat (see `miga log`)".into()))?;
    let att =
        miga_core::attach::clean_att(&msg["att"], true).ok_or_else(|| Error::Invalid("damaged attachment".into()))?;
    let relay = relay.to_string();
    let a2 = att.clone();
    let bytes = tokio::task::spawn_blocking(move || miga_client::files::download(&relay, &a2))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))??;
    let dir = out.unwrap_or_else(|| store.files_dir());
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(miga_client::files::saved_name(&att));
    std::fs::write(&path, bytes)?;
    println!("{}", path.display());
    Ok(())
}
