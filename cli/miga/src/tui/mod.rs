//! The terminal chat UI (`miga` with no subcommand).
pub mod app;
pub mod composer;
pub mod config;
pub mod keys;
pub mod net;
pub mod text;
pub mod theme;
pub mod ui;

#[cfg(test)]
mod snapshots;

use app::{App, ChatSeed, Intent};
use config::Config;
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste, EnableFocusChange,
    EnableMouseCapture, Event as TermEvent, EventStream, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, supports_keyboard_enhancement, EnterAlternateScreen, LeaveAlternateScreen,
    SetTitle,
};
use crossterm::{execute, queue};
use futures_util::StreamExt;
use miga_client::engine;
use miga_client::store::Store;
use miga_client::{now_ms, Error, Result};
use miga_core::identity::Identity;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io::{stdout, Stdout, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;
use tokio::time::interval;

type Term = Terminal<CrosstermBackend<Stdout>>;

struct Screen {
    mouse: bool,
    enhanced: bool,
}

/// Puts the terminal into UI mode; true when keyboard enhancement flags were pushed.
fn setup_terminal(mouse: bool) -> std::io::Result<bool> {
    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen, EnableBracketedPaste, EnableFocusChange, SetTitle("MIGA"))?;
    if mouse {
        execute!(out, EnableMouseCapture)?;
    }
    let enhanced = supports_keyboard_enhancement().unwrap_or(false);
    if enhanced {
        execute!(out, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES))?;
    }
    Ok(enhanced)
}

impl Screen {
    fn enter(mouse: bool) -> std::io::Result<Screen> {
        Ok(Screen { mouse, enhanced: setup_terminal(mouse)? })
    }

    fn leave(&self) {
        let mut out = stdout();
        if self.enhanced {
            let _ = execute!(out, PopKeyboardEnhancementFlags);
        }
        if self.mouse {
            let _ = execute!(out, DisableMouseCapture);
        }
        let _ = execute!(out, DisableFocusChange, DisableBracketedPaste, LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        self.leave();
    }
}

fn install_panic_hook(mouse: bool) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut out = stdout();
        if mouse {
            let _ = execute!(out, DisableMouseCapture);
        }
        let _ = execute!(out, DisableFocusChange, DisableBracketedPaste, LeaveAlternateScreen);
        let _ = disable_raw_mode();
        previous(info);
    }));
}

fn load_seeds(store: &Store, me: &Identity) -> Result<Vec<ChatSeed>> {
    let state = store.ui_state();
    let _ = me;
    Ok(store
        .contacts()?
        .into_iter()
        .map(|c| {
            let messages = store.chat(&c.address).unwrap_or_default();
            // First time we see a chat everything in it counts as read; only later arrivals are unread.
            let newest = messages.iter().filter_map(|m| m["ts"].as_f64()).fold(0.0, f64::max);
            ChatSeed {
                last_read: state["read"][&c.address].as_f64().unwrap_or(newest),
                draft: state["drafts"][&c.address].as_str().unwrap_or_default().to_string(),
                messages,
                address: c.address,
                name: c.name,
            }
        })
        .collect())
}

/// Opens the interface and runs until the user quits.
pub async fn run(store: Store, relay_url: String, config_path: Option<PathBuf>) -> Result<()> {
    use std::io::IsTerminal;
    if !stdout().is_terminal() || !std::io::stdin().is_terminal() {
        return Err(Error::Invalid(
            "the chat UI needs a terminal; for scripts use `miga send`, `miga listen` and `miga log`".into(),
        ));
    }
    let _lock = match store.lock_ui()? {
        Some(l) => l,
        None => return Err(Error::Invalid("miga is already open for this profile".into())),
    };
    let me = store.identity()?;
    let (cfg, config_problem) = config::load(config_path.as_deref());
    let theme = theme::Theme::new(theme::ColorMode::detect(&cfg.theme.color), &cfg.theme);
    let (keymap, key_problems) = keys::KeyMap::new(&cfg.keybinds);
    let seeds = load_seeds(&store, &me)?;
    let mut app = App::new(me.address(), seeds, cfg, theme, keymap);
    app.now = now_ms() as f64;
    if let Some(p) = config_problem.or_else(|| key_problems.into_iter().next()) {
        app.say(p);
    }
    let store = Arc::new(store);
    let (cmd_tx, cmd_rx) = unbounded_channel();
    let (ev_tx, mut ev_rx) = unbounded_channel();
    tokio::spawn(net::run(store.clone(), relay_url.clone(), cmd_rx, ev_tx));

    install_panic_hook(app.cfg.mouse);
    let mut screen = Screen::enter(app.cfg.mouse)?;
    let mut terminal: Term = Terminal::new(CrosstermBackend::new(stdout()))?;
    terminal.clear()?;
    let mut events = Some(EventStream::new());
    let mut tick = interval(Duration::from_secs(1));
    let mut saved = String::new();
    let mut editor_wanted = false;
    let first = app.mark_read();
    let mut shell =
        Shell { store: store.clone(), me, cmds: cmd_tx, bell: false, relay: relay_url.clone(), last_live: 0 };
    shell.sync_lists(&mut app);
    shell.exec(&mut app, first, &mut editor_wanted);

    loop {
        terminal.draw(|f| ui::draw(f, &mut app))?;
        if shell.bell {
            shell.bell = false;
            let mut out = stdout();
            let _ = out.write_all(b"\x07");
            let _ = out.flush();
        }
        if app.quit {
            break;
        }
        let mut intents: Vec<Intent> = Vec::new();
        tokio::select! {
            ev = events.as_mut().expect("events").next() => match ev {
                Some(Ok(TermEvent::Key(k))) => intents = app.handle_key(k),
                Some(Ok(TermEvent::Mouse(m))) => intents = app.handle_mouse(m),
                Some(Ok(TermEvent::Paste(p))) => app.handle_paste(&p),
                Some(Ok(TermEvent::FocusGained)) => app.focused = true,
                Some(Ok(TermEvent::FocusLost)) => app.focused = false,
                Some(Ok(TermEvent::Resize(..))) => {}
                Some(Err(_)) | None => break,
            },
            Some(ne) = ev_rx.recv() => shell.on_net(&mut app, ne),
            _ = tick.tick() => {
                app.tick(now_ms() as f64);
                let state = app.export_state().to_string();
                if state != saved && store.save_ui_state(&app.export_state()).is_ok() {
                    saved = state;
                }
            }
        }
        shell.exec(&mut app, intents, &mut editor_wanted);
        let more = app.mark_read();
        shell.exec(&mut app, more, &mut editor_wanted);
        if editor_wanted {
            editor_wanted = false;
            drop(events.take());
            match run_editor(&app, &mut screen, &mut terminal) {
                Ok(Some(t)) => app.set_composer(&t),
                Ok(None) => {}
                Err(e) => app.say(format!("Editor: {e}")),
            }
            events = Some(EventStream::new());
        }
    }
    let _ = store.save_ui_state(&app.export_state());
    drop(terminal);
    drop(screen);
    Ok(())
}

struct Shell {
    store: Arc<Store>,
    me: Identity,
    cmds: tokio::sync::mpsc::UnboundedSender<net::Cmd>,
    bell: bool,
    relay: String,
    last_live: i64,
}

impl Shell {
    /// Mute, block, verification and device lists from the store into the interface state.
    fn sync_lists(&self, app: &mut App) {
        app.muted = self.store.addresses("muted");
        app.blocked = self.store.addresses("blocked");
        app.my_device = self.store.device().map(|d| d.address().to_string()).unwrap_or_default();
        app.devices = miga_client::devices::devices(&self.store)
            .iter()
            .filter_map(|d| {
                Some((d["address"].as_str()?.to_string(), d["label"].as_str().unwrap_or("Device").to_string()))
            })
            .collect();
        if let Ok(list) = self.store.contacts() {
            app.verified = list
                .iter()
                .filter(|c| {
                    c.verified.as_deref().is_some_and(|v| {
                        miga_core::crypto::safety_number(self.me.address(), &c.address).is_ok_and(|n| n == v)
                    })
                })
                .map(|c| c.address.clone())
                .collect();
        }
    }

    fn set_list(&self, key: &str, peer: &str, on: bool) -> miga_client::Result<()> {
        let mut list = self.store.addresses(key);
        list.retain(|a| a != peer);
        if on {
            list.push(peer.to_string());
        }
        self.store.set_meta(key, serde_json::json!(list))?;
        self.forward(None, serde_json::json!({"k": "state", key: list}));
        Ok(())
    }

    /// Deletes the conversation (or the contact too) here and on the other devices, with a tombstone.
    fn delete(&self, app: &mut App, peer: &str, whole: bool) {
        use miga_core::sync::{Tomb, TombKind};
        let kind = if whole { TombKind::Contact } else { TombKind::Conversation };
        let t = Tomb { chat: peer.to_string(), kind, id: None, mine: false, ts: now_ms() };
        let result = miga_client::devices::remember_deletes(&self.store, std::slice::from_ref(&t))
            .and_then(|msgs| miga_client::devices::apply_tombstones(&self.store, &[t]).map(|_| msgs));
        match result {
            Ok(msgs) => {
                for (to, m) in msgs {
                    self.forward(to, m);
                }
                app.drop_chat(peer, whole);
                app.say(if whole { "Contact deleted on all your devices" } else { "Chat deleted on all your devices" });
            }
            Err(e) => app.say(e.to_string()),
        }
    }

    fn forward(&self, to: Option<String>, m: serde_json::Value) {
        let _ = self.cmds.send(net::Cmd::Sync(to, m));
    }

    fn refresh(&self, app: &mut App, peer: &str) {
        let known = app.chats.iter().any(|c| c.address == peer);
        if let Ok(list) = self.store.contacts() {
            if let Some(c) = list.iter().find(|c| c.address == peer) {
                if known {
                    app.rename_chat(peer, &c.name);
                } else {
                    app.add_chat(peer, &c.name);
                }
            }
        }
        if let Ok(msgs) = self.store.chat(peer) {
            app.set_messages(peer, &msgs);
        }
    }

    fn on_net(&mut self, app: &mut App, ev: net::NetEvent) {
        match ev {
            net::NetEvent::Conn(c) => {
                app.conn = match c {
                    net::HubConn::Connecting => app::Conn::Connecting,
                    net::HubConn::Online => app::Conn::Online,
                    net::HubConn::Offline => app::Conn::Offline,
                }
            }
            net::NetEvent::Notice(m) => app.say(m),
            net::NetEvent::Link { code, .. } => {
                let url = crate::qr::link_url(&self.relay, &code);
                let lines = crate::qr::lines(&url).unwrap_or_default();
                app.popup = app::Popup::Link { code, lines, url };
            }
            net::NetEvent::LinkEnded(m) => {
                if matches!(app.popup, app::Popup::Link { .. }) {
                    app.popup = app::Popup::None;
                }
                if !m.is_empty() {
                    app.say(m);
                }
                self.sync_lists(app);
            }
            net::NetEvent::Devices => self.sync_lists(app),
            net::NetEvent::Progress(d, t) => {
                app.history = if d >= t && t > 0 { None } else { Some((d, t)) };
                if d >= t {
                    app.say("History copied");
                    if let Ok(list) = self.store.contacts() {
                        for c in list {
                            self.refresh(app, &c.address);
                        }
                    }
                }
            }
            net::NetEvent::Read(peer, ts) => app.read_up_to(&peer, ts),
            net::NetEvent::Erased => {
                app.quit = true;
            }
            net::NetEvent::Live { from, text } => {
                if text.is_empty() {
                    app.live.remove(&from);
                } else {
                    app.live.insert(from, text);
                }
            }
            net::NetEvent::FileReady { path, .. } => open_file(app, &path),
            net::NetEvent::Confirmed(_) | net::NetEvent::Drained => {}
            net::NetEvent::Changed { peer, shown } => {
                self.refresh(app, &peer);
                if let Some(m) = shown {
                    app.live.remove(&peer);
                    let quiet = (app.is_watching(&peer) && !app.cfg.notifications.when_focused) || app.is_muted(&peer);
                    if !quiet {
                        if app.cfg.notifications.bell {
                            self.bell = true;
                        }
                        if app.cfg.notifications.desktop {
                            notify(&app.cfg, &m.name, &m.text);
                        }
                    }
                }
            }
        }
    }

    fn send_cmd(&self, app: &mut App, cmd: net::Cmd) {
        if self.cmds.send(cmd).is_err() {
            app.say("The network task stopped");
        }
    }

    fn exec(&mut self, app: &mut App, intents: Vec<Intent>, editor: &mut bool) {
        for intent in intents {
            match intent {
                Intent::Send { peer, text, reply } => {
                    match engine::prepare_message(&self.store, &self.me, &peer, &text, reply.as_ref()) {
                        Ok(out) => {
                            self.refresh(app, &peer);
                            if app.conn == app::Conn::Online {
                                self.send_cmd(
                                    app,
                                    net::Cmd::Send { peer, id: out.id, body: out.body, after: net::After::Sent },
                                );
                            } else {
                                app.say("Offline: the message is queued and goes out when you reconnect");
                            }
                        }
                        Err(e) => app.say(e.to_string()),
                    }
                }
                Intent::Edit { peer, id, text } => match engine::prepare_edit(&self.me, &peer, &id, &text) {
                    Ok(c) => {
                        let after = net::After::Edit { msg_id: id, text: c.text, ts: c.ts };
                        self.send_cmd(app, net::Cmd::Send { peer, id: c.frame_id, body: c.body, after });
                    }
                    Err(e) => app.say(e.to_string()),
                },
                Intent::Delete { peer, id } => match engine::prepare_delete(&self.me, &peer, &id) {
                    Ok(c) => {
                        self.send_cmd(
                            app,
                            net::Cmd::Send {
                                peer,
                                id: c.frame_id,
                                body: c.body,
                                after: net::After::Delete { msg_id: id },
                            },
                        );
                    }
                    Err(e) => app.say(e.to_string()),
                },
                Intent::Seen { peer, ids } => {
                    if let Some(up_to) = self.store.chat(&peer).ok().and_then(|l| {
                        l.iter()
                            .filter(|m| m["mine"] == false && ids.iter().any(|i| m["id"] == i.as_str()))
                            .filter_map(|m| m["ts"].as_f64())
                            .reduce(f64::max)
                    }) {
                        self.forward(None, serde_json::json!({"k": "read", "peer": peer, "upTo": up_to}));
                    }
                    if app.conn == app::Conn::Online {
                        if let (Ok(body), Ok(id)) =
                            (engine::seen_receipt(&self.me, &peer, &ids), miga_core::random_id())
                        {
                            self.send_cmd(app, net::Cmd::Send { peer, id, body, after: net::After::Nothing });
                        }
                    }
                }
                Intent::Copy(text) => copy_osc52(&text),
                Intent::OpenUrl(url) => open_url(app, &url),
                Intent::ExternalEditor => *editor = true,
                Intent::AddContact { address, name } => {
                    if let Err(e) = self.store.upsert_contact(&address, &name) {
                        app.say(e.to_string());
                    }
                }
                Intent::SaveState => {
                    let _ = self.store.save_ui_state(&app.export_state());
                }
                Intent::Quit => {}
                Intent::Attach { peer, path, caption } => {
                    self.send_cmd(app, net::Cmd::SendFile { peer, path, caption });
                }
                Intent::OpenAttachment { peer, id } => self.send_cmd(app, net::Cmd::Fetch { peer, id }),
                Intent::AddDevice => self.send_cmd(app, net::Cmd::AddDevice),
                Intent::CancelLink => self.send_cmd(app, net::Cmd::CancelLink),
                Intent::RemoveDevice(a) => {
                    self.send_cmd(app, net::Cmd::RemoveDevice(a));
                    self.sync_lists(app);
                }
                Intent::CopyHistory(a) => self.send_cmd(app, net::Cmd::CopyHistory(a)),
                Intent::Mute { peer, on } => {
                    let _ = self.set_list("muted", &peer, on);
                }
                Intent::Block { peer, on } => {
                    let _ = self.set_list("blocked", &peer, on);
                }
                Intent::Verify { peer, on } => {
                    if let Ok(mut list) = self.store.contacts() {
                        let number = miga_core::crypto::safety_number(self.me.address(), &peer).ok();
                        if let Some(c) = list.iter_mut().find(|c| c.address == peer) {
                            c.verified = if on { number } else { None };
                        }
                        let _ = self.store.save_contacts(&list);
                        if let Some(c) = list.iter().find(|c| c.address == peer) {
                            self.forward(
                                None,
                                serde_json::json!({"k": "state", "contacts": [miga_client::devices::contact_value(c)]}),
                            );
                        }
                    }
                }
                Intent::DeleteChat { peer } => self.delete(app, &peer, false),
                Intent::DeleteContact { peer } => self.delete(app, &peer, true),
                Intent::ShowQr(app::QrKind::Address) => {
                    let url = format!("{}/app/#to={}", crate::qr::app_origin(&self.relay), self.me.address());
                    app.popup = app::Popup::Qr {
                        title: "Your address".into(),
                        lines: crate::qr::lines(&url).unwrap_or_default(),
                        note: "Scan with MIGA to add you. It contains your address.".into(),
                    };
                }
                Intent::Live { peer, text } => {
                    let now = now_ms();
                    if now - self.last_live >= 300 || text.is_empty() {
                        self.last_live = now;
                        if let Ok(body) = miga_core::payload::encrypt_live(&self.me, &peer, &text, now) {
                            self.send_cmd(app, net::Cmd::Live { peer, body });
                        }
                    }
                }
            }
        }
    }
}

/// Copies through the terminal (OSC 52), which also works over SSH.
fn copy_osc52(text: &str) {
    let text: String = text.chars().take(100_000).collect();
    let encoded = miga_core::js::to_base64(text.as_bytes());
    let mut out = stdout();
    let _ = write!(out, "\x1b]52;c;{encoded}\x07");
    let _ = out.flush();
}

/// Opens a saved attachment with `open_command`.
fn open_file(app: &mut App, path: &str) {
    let mut program = app.cfg.open_command.clone();
    if program.is_empty() {
        app.say(format!("Saved: {path}"));
        return;
    }
    if program == "xdg-open" && cfg!(target_os = "macos") {
        program = "open".into();
    }
    match std::process::Command::new(&program)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            app.say(format!("Saved to {path}"));
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => app.say(format!("Saved to {path}; could not run {program}: {e}")),
    }
}

fn open_url(app: &mut App, url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    let mut program = app.cfg.open_command.clone();
    if program.is_empty() {
        app.say(format!("Link: {url}"));
        return;
    }
    if program == "xdg-open" && cfg!(target_os = "macos") {
        program = "open".into();
    }
    let result = std::process::Command::new(&program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match result {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => app.say(format!("Could not run {program}: {e}")),
    }
}

/// Desktop notification through `notify_cmd`; generic text unless `show_text` is on. No shell involved.
fn notify(cfg: &Config, name: &str, text: &str) {
    let (title, body) = if cfg.notifications.show_text {
        (name.to_string(), text.chars().take(120).collect::<String>())
    } else {
        ("MIGA".to_string(), "New message".to_string())
    };
    let mut parts = cfg.notifications.notify_cmd.split_whitespace();
    let Some(program) = parts.next() else { return };
    let args: Vec<String> = parts.map(|a| a.replace("{title}", &title).replace("{body}", &body)).collect();
    if let Ok(mut child) = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// Writes the draft to a private temp file, runs `$VISUAL`/`$EDITOR` on it, returns the result.
fn run_editor(app: &App, screen: &mut Screen, terminal: &mut Term) -> std::io::Result<Option<String>> {
    use std::os::unix::fs::OpenOptionsExt;
    let editor = match app.cfg.editor.as_str() {
        "" | "default" => std::env::var("VISUAL")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| std::env::var("EDITOR").ok().filter(|v| !v.is_empty()))
            .unwrap_or_else(|| "vi".into()),
        custom => custom.to_string(),
    };
    let dir = std::env::temp_dir();
    let mut path = dir.join(format!("miga-draft-{}-{}.txt", std::process::id(), now_ms()));
    let mut attempts = 0;
    let mut file = loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path) {
            Ok(f) => break f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempts < 5 => {
                attempts += 1;
                path = dir.join(format!("miga-draft-{}-{}-{attempts}.txt", std::process::id(), now_ms()));
            }
            Err(e) => return Err(e),
        }
    };
    file.write_all(app.composer_text().as_bytes())?;
    drop(file);
    screen.leave();
    let status =
        std::process::Command::new("sh").arg("-c").arg(format!("{editor} \"$1\"")).arg("sh").arg(&path).status();
    let again = setup_terminal(screen.mouse);
    let text = std::fs::read_to_string(&path);
    let _ = std::fs::remove_file(&path);
    screen.enhanced = again?;
    terminal.clear()?;
    let _ = queue!(stdout(), SetTitle("MIGA"));
    match status {
        Ok(s) if s.success() => Ok(Some(text?)),
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    }
}
