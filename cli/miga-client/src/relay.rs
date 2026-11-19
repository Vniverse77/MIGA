//! One authenticated relay connection (ENGINE.md section 8).
use crate::{Error, Result};
use futures_util::{SinkExt, StreamExt};
use miga_core::identity::Identity;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::{interval, timeout, Interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const PING: Duration = Duration::from_secs(30);
const HANDSHAKE: Duration = Duration::from_secs(20);

/// What the relay tells us once the connection is ready.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A stored message. Acknowledge it only after it is durably stored.
    Msg {
        from: String,
        id: String,
        body: String,
        ts: f64,
    },
    /// Ephemeral frame (live typing): never acknowledged.
    Live {
        from: String,
        body: String,
    },
    Sent {
        id: String,
    },
    Error {
        err: String,
        id: Option<String>,
    },
    Other,
}

pub struct Relay {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ping: Interval,
}

impl Relay {
    /// Connects, answers the challenge and waits for `ready`. No `Origin` header is sent.
    pub async fn connect(url: &str, identity: &Identity) -> Result<Relay> {
        // Only the ring provider is compiled in; installing it is idempotent.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut request = url.into_client_request().map_err(|e| Error::Ws(e.to_string()))?;
        request.headers_mut().insert(
            "User-Agent",
            format!("miga-cli/{}", env!("CARGO_PKG_VERSION"))
                .parse()
                .map_err(|_| Error::Invalid("user agent".into()))?,
        );
        let (ws, _) = timeout(HANDSHAKE, connect_async(request))
            .await
            .map_err(|_| Error::Relay("connect timed out".into()))?
            .map_err(|e| Error::Ws(e.to_string()))?;
        let mut ping = interval(PING);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut relay = Relay { ws, ping };
        timeout(HANDSHAKE, relay.authenticate(identity))
            .await
            .map_err(|_| Error::Relay("authentication timed out".into()))??;
        relay.ping.reset();
        Ok(relay)
    }

    async fn authenticate(&mut self, identity: &Identity) -> Result<()> {
        loop {
            let frame = self.read_frame().await?;
            match frame.get("t").and_then(Value::as_str) {
                Some("challenge") => {
                    let nonce = frame.get("nonce").and_then(Value::as_str).unwrap_or_default();
                    self.write(json!({"t": "auth", "pub": identity.address(), "sig": identity.sign_auth(nonce)}))
                        .await?;
                }
                Some("ready") => return Ok(()),
                Some("error") => {
                    return Err(Error::Relay(format!(
                        "relay error: {}",
                        frame.get("err").and_then(Value::as_str).unwrap_or("?")
                    )))
                }
                _ => {}
            }
        }
    }

    async fn read_frame(&mut self) -> Result<Value> {
        read_ws(&mut self.ws).await
    }

    async fn write(&mut self, frame: Value) -> Result<()> {
        self.ws.send(Message::text(frame.to_string())).await.map_err(|e| Error::Ws(e.to_string()))
    }

    pub async fn send(&mut self, to: &str, id: &str, body: &str) -> Result<()> {
        self.write(json!({"t": "send", "to": to, "id": id, "body": body})).await
    }

    pub async fn ack(&mut self, from: &str, id: &str) -> Result<()> {
        self.write(json!({"t": "ack", "from": from, "id": id})).await
    }

    /// The next relay frame, sending keep-alive pings every 30 s while waiting.
    pub async fn next(&mut self) -> Result<Event> {
        loop {
            tokio::select! {
                frame = read_ws(&mut self.ws) => return Ok(parse_event(&frame?)),
                _ = self.ping.tick() => self.write(json!({"t": "ping"})).await?,
            }
        }
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}

fn str_of(frame: &Value, k: &str) -> String {
    frame.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn parse_event(frame: &Value) -> Event {
    match frame.get("t").and_then(Value::as_str) {
        Some("msg") if frame.get("eph").and_then(Value::as_bool) == Some(true) => {
            Event::Live { from: str_of(frame, "from"), body: str_of(frame, "body") }
        }
        Some("msg") => Event::Msg {
            from: str_of(frame, "from"),
            id: str_of(frame, "id"),
            body: str_of(frame, "body"),
            ts: miga_core::js::js_number(frame.get("ts")),
        },
        Some("sent") => Event::Sent { id: str_of(frame, "id") },
        Some("error") => {
            Event::Error { err: str_of(frame, "err"), id: frame.get("id").and_then(Value::as_str).map(str::to_string) }
        }
        _ => Event::Other,
    }
}

async fn read_ws(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Result<Value> {
    loop {
        match ws.next().await {
            None => return Err(Error::Relay("connection closed".into())),
            Some(Err(e)) => return Err(Error::Ws(e.to_string())),
            Some(Ok(Message::Text(t))) => {
                if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                    return Ok(v);
                }
            }
            Some(Ok(Message::Close(_))) => return Err(Error::Relay("connection closed".into())),
            Some(Ok(_)) => {}
        }
    }
}
