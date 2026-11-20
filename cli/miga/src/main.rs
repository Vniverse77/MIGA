//! `miga`: headless MIGA client. Subcommands: init, address, add, contacts, send, listen, log.
#![forbid(unsafe_code)]

mod headless;
mod ipc;
mod qr;
mod tui;

use clap::{Parser, Subcommand};
use miga_client::engine;
use miga_client::store::{Contact, Store};
use miga_client::{Error, Result, DEFAULT_RELAY};
use miga_core::crypto::{group_safety, safety_number};
use miga_core::identity::Identity;

#[derive(Parser)]
#[command(name = "miga", version, about = "MIGA terminal client (protocol v0)")]
struct Cli {
    /// Relay WebSocket URL
    #[arg(long, global = true, env = "MIGA_RELAY", default_value = DEFAULT_RELAY)]
    relay: String,
    /// Use a separate account stored under this name
    #[arg(long, global = true)]
    profile: Option<String>,
    /// Config file (default: ~/.config/miga/config.toml)
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
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
    Send {
        contact: String,
        text: Vec<String>,
        /// Send this image as an attachment (the text becomes its caption)
        #[arg(long)]
        file: Option<std::path::PathBuf>,
    },
    /// Download and save an attachment of a stored message (id or unique id prefix from `miga log`)
    Get {
        contact: String,
        id: String,
        /// Folder to save into (default: the profile's files folder)
        #[arg(long)]
        out: Option<std::path::PathBuf>,
    },
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
    /// Show a link code and QR code so another device (the phone or the web app) can join this account
    Link {
        /// Keep serving the history copy this many seconds after the device joined
        #[arg(long, default_value_t = 120)]
        stay: u64,
    },
    /// Join an existing account with the link code shown by another device
    Join { code: String },
    /// List the devices of this account (or remove one with --remove)
    Devices {
        #[arg(long)]
        remove: Option<String>,
    },
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
    let Some(command) = cli.command else {
        return tui::run(store, cli.relay, cli.config).await;
    };
    match command {
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
            for Contact { address, name, .. } in store.contacts()? {
                println!("{name}\t{address}");
            }
            Ok(())
        }
        Command::Join { code } => headless::join(&store, &cli.relay, &code).await,
        Command::Link { stay } => headless::link(&store, &cli.relay, stay).await,
        Command::Devices { remove } => headless::devices(&store, &cli.relay, remove).await,
        Command::Send { contact, text, file } => headless::send(&store, &cli.relay, &contact, text, file).await,
        Command::Get { contact, id, out } => headless::get(&store, &cli.relay, &contact, &id, out).await,
        Command::Listen { timeout, count } => headless::listen(&store, &cli.relay, timeout, count).await,
        Command::Log { contact } => {
            let peer = resolve(&store, &store.identity()?, &contact)?;
            for m in store.chat(&peer)? {
                let att = m["att"]
                    .as_object()
                    .map(|a| {
                        format!(
                            " [file {} {} bytes, id {}]",
                            a["mime"].as_str().unwrap_or("?"),
                            a["size"],
                            &m["id"].as_str().unwrap_or_default()[..8]
                        )
                    })
                    .unwrap_or_default();
                println!(
                    "{} {} {}{att}{}",
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
pub(crate) fn resolve(store: &Store, me: &Identity, query: &str) -> Result<String> {
    if let Some(c) = store.find_contact(query)? {
        return Ok(c.address);
    }
    match engine::parse_address(me, query) {
        Ok(a) => Ok(a),
        Err(_) => Err(Error::Invalid(format!("no contact `{query}` (add one with `miga add <address> [name]`)"))),
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC.
pub(crate) fn stamp(ms: f64) -> String {
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
