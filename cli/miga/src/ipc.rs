//! Local control socket: while the chat UI runs it owns the relay connection, so `miga send`,
//! `miga send --file` and `miga listen` talk to it over a Unix socket in the profile's data
//! directory (mode 0600). One JSON object per line in each direction.
use miga_client::engine;
use miga_client::hub::{After, Cmd};
use miga_client::store::Store;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;
use tokio::sync::mpsc::UnboundedSender;

pub fn socket_path(store: &Store) -> PathBuf {
    store.data_dir().join("miga.sock")
}

/// Starts serving. The returned sender broadcasts event lines to `listen` clients.
pub fn serve(store: Arc<Store>, cmds: UnboundedSender<Cmd>) -> Option<broadcast::Sender<String>> {
    let path = socket_path(&store);
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).ok()?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let (events, _) = broadcast::channel::<String>(64);
    let ev = events.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { break };
            tokio::spawn(client(stream, store.clone(), cmds.clone(), ev.subscribe()));
        }
    });
    Some(events)
}

async fn client(
    stream: UnixStream,
    store: Arc<Store>,
    cmds: UnboundedSender<Cmd>,
    mut events: broadcast::Receiver<String>,
) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let Ok(Some(line)) = lines.next_line().await else { return };
    let req: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    let reply = match req["op"].as_str() {
        Some("subscribe") => {
            let _ = write.write_all(b"{\"ok\":true}\n").await;
            while let Ok(l) = events.recv().await {
                if write.write_all(format!("{l}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
            return;
        }
        Some("send") => handle_send(&store, &cmds, &req),
        Some("sendfile") => match (req["to"].as_str(), req["path"].as_str()) {
            (Some(to), Some(path)) => {
                let _ = cmds.send(Cmd::SendFile {
                    peer: to.to_string(),
                    path: path.to_string(),
                    caption: req["caption"].as_str().unwrap_or_default().to_string(),
                });
                json!({"ok": true, "note": "uploading in the running UI"})
            }
            _ => json!({"ok": false, "err": "missing to or path"}),
        },
        _ => json!({"ok": false, "err": "unknown request"}),
    };
    let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
}

fn handle_send(store: &Store, cmds: &UnboundedSender<Cmd>, req: &Value) -> Value {
    let (Some(to), Some(text)) = (req["to"].as_str(), req["text"].as_str()) else {
        return json!({"ok": false, "err": "missing to or text"});
    };
    let me = match store.identity() {
        Ok(m) => m,
        Err(e) => return json!({"ok": false, "err": e.to_string()}),
    };
    let result = engine::prepare_text(store, &me, to, text);
    match result {
        Ok(out) => {
            let id = out.id.clone();
            let _ = cmds.send(Cmd::Send { peer: to.to_string(), id: out.id, body: out.body, after: After::Sent });
            json!({"ok": true, "id": id})
        }
        Err(e) => json!({"ok": false, "err": e.to_string()}),
    }
}

/// One request/answer exchange with the running UI. `None` when no UI answers.
pub async fn request(store: &Store, req: &Value) -> Option<Value> {
    let stream = UnixStream::connect(socket_path(store)).await.ok()?;
    let (read, mut write) = stream.into_split();
    write.write_all(format!("{req}\n").as_bytes()).await.ok()?;
    let line = BufReader::new(read).lines().next_line().await.ok()??;
    serde_json::from_str(&line).ok()
}

/// Connects and returns the stream of event lines (for `listen`).
pub async fn subscribe(store: &Store) -> Option<tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>> {
    let stream = UnixStream::connect(socket_path(store)).await.ok()?;
    let (read, mut write) = stream.into_split();
    write.write_all(b"{\"op\":\"subscribe\"}\n").await.ok()?;
    let mut lines = BufReader::new(read).lines();
    lines.next_line().await.ok()??;
    Some(lines)
}
