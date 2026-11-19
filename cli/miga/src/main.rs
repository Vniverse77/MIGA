//! `miga`: headless MIGA client. Subcommands: init, address, add, contacts, send, listen, log.
#![forbid(unsafe_code)]

use clap::{Parser, Subcommand};
use miga_client::engine::{self, Handled};
use miga_client::relay::{Event, Relay};
use miga_client::store::{Contact, Store};
use miga_client::{now_ms, Error, Result, DEFAULT_RELAY};
use miga_core::crypto::{group_safety, safety_number};
use miga_core::identity::Identity;
use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::time::{interval, sleep, timeout};

#[derive(Parser)]
#[command(name = "miga", version, about = "MIGA terminal client (protocol v0)")]
struct Cli {
    /// Relay WebSocket URL
    #[arg(long, global = true, env = "MIGA_RELAY", default_value = DEFAULT_RELAY)]
    relay: String,
    /// Use a separate account stored under this name
    #[arg(long, global = true)]
    profile: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create an identity and print its address
    Init {
        /// Display name shared with contacts in your messages
        #[arg(long)]
        name: Option<String>,
    },
    /// Print your address
    Address,
    /// Add a contact (and print the safety number to compare)
    Add { address: String, name: Option<String> },
    /// List contacts
    Contacts,
    /// Send a text message (text from arguments, or from stdin when none is given)
    Send { contact: String, text: Vec<String> },
    /// Print incoming messages until interrupted
    Listen {
        /// Stop after this many seconds
        #[arg(long)]
        timeout: Option<u64>,
        /// Stop after this many incoming messages
        #[arg(long)]
        count: Option<usize>,
    },
    /// Show the stored conversation with a contact
    Log { contact: String },
}

fn main() {
    let cli = Cli::parse();
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => return fail(&e.to_string()),
    };
    if let Err(e) = runtime.block_on(run(cli)) {
        fail(&e.to_string());
    }
}

fn fail(message: &str) {
    eprintln!("miga: {message}");
    std::process::exit(1);
}

async fn run(cli: Cli) -> Result<()> {
    let store = Store::open(cli.profile.as_deref())?;
    match cli.command {
        Command::Init { name } => {
            let id = store.create_identity(name.as_deref())?;
            println!("{}", id.address());
            eprintln!("Identity created. Share the address above; the key stays in the 0600 identity file.");
            Ok(())
        }
        Command::Address => {
            println!("{}", store.identity()?.address());
            Ok(())
        }
        Command::Add { address, name } => {
            let me = store.identity()?;
            let address = engine::parse_address(&me, &address)?;
            let name = name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("{}...", &address[..8]));
            let new = store.upsert_contact(&address, &name)?;
            println!("{} {name} ({address})", if new { "added" } else { "updated" });
            println!("safety number: {}", group_safety(&safety_number(me.address(), &address)?));
            Ok(())
        }
        Command::Contacts => {
            for Contact { address, name } in store.contacts()? {
                println!("{name}\t{address}");
            }
            Ok(())
        }
        Command::Send { contact, text } => send(&store, &cli.relay, &contact, text).await,
        Command::Listen { timeout, count } => listen(&store, &cli.relay, timeout, count).await,
        Command::Log { contact } => {
            let peer = resolve(&store, &store.identity()?, &contact)?;
            for m in store.chat(&peer)? {
                println!(
                    "{} {} {}{}",
                    stamp(m["ts"].as_f64().unwrap_or(0.0)),
                    if m["mine"] == true { ">" } else { "<" },
                    m["text"].as_str().unwrap_or_default(),
                    match (m["delivery"].as_str(), m["state"].as_str()) {
                        (Some(d), _) => format!("  [{d}]"),
                        (None, Some("received")) | (None, None) => String::new(),
                        (None, Some(s)) => format!("  [{s}]"),
                    }
                );
            }
            Ok(())
        }
    }
}

/// A contact by name, address or unique prefix; a full valid address is added on the spot.
fn resolve(store: &Store, me: &Identity, query: &str) -> Result<String> {
    if let Some(c) = store.find_contact(query)? {
        return Ok(c.address);
    }
    match engine::parse_address(me, query) {
        Ok(a) => Ok(a),
        Err(_) => Err(Error::Invalid(format!("no contact `{query}` (add one with `miga add <address> [name]`)"))),
    }
}

async fn send(store: &Store, relay_url: &str, contact: &str, words: Vec<String>) -> Result<()> {
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
    let out = engine::prepare_text(store, &me, &peer, &text)?;
    let mut relay = match Relay::connect(relay_url, &me).await {
        Ok(r) => r,
        Err(e) => {
            return Err(Error::Relay(format!(
                "{e}; the message is saved as pending and goes out on the next `miga listen`"
            )))
        }
    };
    relay.send(&peer, &out.id, &out.body).await?;
    let wait = async {
        loop {
            match relay.next().await? {
                Event::Sent { id } if id == out.id => {
                    store.update_own(&peer, &id, |m| m["state"] = "sent".into())?;
                    return Ok(());
                }
                Event::Error { err, id: Some(id) } if id == out.id => {
                    store.update_own(&peer, &id, |m| m["state"] = "failed".into())?;
                    return Err(Error::Relay(format!("relay refused the message: {err}")));
                }
                Event::Error { err, id: None } if err != "bad_frame" => {
                    return Err(Error::Relay(format!("relay error: {err}")))
                }
                _ => {}
            }
        }
    };
    timeout(Duration::from_secs(20), wait).await.map_err(|_| Error::Relay("no answer from the relay".into()))??;
    relay.close().await;
    println!("sent {}", &out.id[..8]);
    Ok(())
}

async fn listen(store: &Store, relay_url: &str, limit: Option<u64>, count: Option<usize>) -> Result<()> {
    let me = store.identity()?;
    let deadline = limit.map(|s| Instant::now() + Duration::from_secs(s));
    let mut received = 0usize;
    let mut backoff = 1u64;
    eprintln!("listening as {} on {relay_url}", me.address());
    loop {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            return Ok(());
        }
        let mut relay = match Relay::connect(relay_url, &me).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("miga: {e}; retrying in {backoff}s");
                sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
                continue;
            }
        };
        backoff = 1;
        match session(store, &me, &mut relay, deadline, count, &mut received).await {
            Ok(()) => return Ok(()),
            Err(e) => eprintln!("miga: connection lost ({e}); reconnecting"),
        }
    }
}

/// Runs one connection. `Ok` means we are done (deadline or count reached).
async fn session(
    store: &Store,
    me: &Identity,
    relay: &mut Relay,
    deadline: Option<Instant>,
    count: Option<usize>,
    received: &mut usize,
) -> Result<()> {
    // Resend anything that never got a `sent` (fresh nonce and ts, same id).
    for c in store.contacts()? {
        for m in store.pending(&c.address)? {
            let out = engine::reseal_pending(store, me, &c.address, &m)?;
            relay.send(&c.address, &out.id, &out.body).await?;
        }
    }
    let mut owed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut tick = interval(Duration::from_secs(1));
    loop {
        if count.is_some_and(|n| *received >= n) {
            flush(me, relay, &mut owed).await?;
            return Ok(());
        }
        let remaining = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if remaining == Some(Duration::ZERO) {
            flush(me, relay, &mut owed).await?;
            return Ok(());
        }
        let wait = remaining.unwrap_or(Duration::from_secs(3600));
        tokio::select! {
            event = relay.next() => match event? {
                Event::Msg { from, id, body, ts } => {
                    let handled = engine::handle_incoming(store, me, &from, &id, &body, ts)?;
                    // Durable first, then acknowledge.
                    if handled.ack {
                        relay.ack(&from, &id).await?;
                    }
                    report(&handled, received);
                    if let Some(r) = handled.receipt {
                        owed.entry(from).or_default().push(r);
                    }
                }
                Event::Error { err, id } => eprintln!("miga: relay error {err}{}", id.map(|i| format!(" (message {})", &i[..i.len().min(8)])).unwrap_or_default()),
                _ => {}
            },
            _ = tick.tick() => flush(me, relay, &mut owed).await?,
            () = sleep(wait) => {}
        }
    }
}

/// Sends the delivery receipts that are owed, at most 50 ids per message.
async fn flush(me: &Identity, relay: &mut Relay, owed: &mut BTreeMap<String, Vec<String>>) -> Result<()> {
    for (peer, ids) in std::mem::take(owed) {
        for chunk in ids.chunks(50) {
            let body = engine::delivery_receipt(me, &peer, chunk)?;
            relay.send(&peer, &miga_core::random_id()?, &body).await?;
            sleep(Duration::from_millis(400)).await;
        }
    }
    Ok(())
}

fn report(h: &Handled, received: &mut usize) {
    if let Some(m) = &h.shown {
        *received += 1;
        let att = if m.has_attachment { " [attachment: not supported yet]" } else { "" };
        println!("[{}] {}: {}{att}", stamp(m.ts), m.name, m.text);
    }
    for n in &h.notes {
        println!("[{}] {n}", stamp(now_ms() as f64));
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC.
fn stamp(ms: f64) -> String {
    if !ms.is_finite() {
        return "unknown time".into();
    }
    let secs = (ms / 1000.0).floor() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
