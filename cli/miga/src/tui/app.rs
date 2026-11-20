//! Interface state and the reducer: keys and events in, state changes and [`Intent`]s out. No IO here.
use super::composer::Composer;
use super::config::Config;
use super::keys::{Action, KeyMap, Mode};
use super::text::{fuzzy, links, one_line, sanitize};
use super::theme::Theme;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use miga_core::identity::is_address;
use miga_core::js::{js_trim, utf16_len};
use miga_core::payload::{Reply, MAX_TEXT};
use ratatui::layout::Rect;

/// Every `:command` the composer and the command popup understand.
const COMMANDS: &[&str] = &[
    "q", "quit", "help", "h", "address", "bell", "add", "link", "devices", "search", "gsearch", "qr", "attach", "mute",
    "unmute", "block", "unblock", "verify", "unverify", "safety", "delete",
];
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    List,
    History,
    Composer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conn {
    Connecting,
    Online,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Pending,
    Sent,
    Failed,
    Received,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Delivery {
    None,
    Delivered,
    Read,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub mine: bool,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    pub id: String,
    pub mine: bool,
    pub text: String,
    pub ts: f64,
    pub state: State,
    pub delivery: Delivery,
    pub edited: bool,
    pub reply: Option<Quote>,
    pub att: bool,
    /// `image/png, 120 KB, 800x600` for an attachment.
    pub att_info: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Msg(Msg),
    /// A message that was deleted while we watched (kept for this session only).
    Gone {
        ts: f64,
        mine: bool,
    },
}

impl Row {
    pub fn ts(&self) -> f64 {
        match self {
            Row::Msg(m) => m.ts,
            Row::Gone { ts, .. } => *ts,
        }
    }
}

impl Msg {
    pub fn from_value(v: &Value, me: &str) -> Option<Msg> {
        let id = v.get("id")?.as_str()?.to_string();
        let mine = v.get("mine").and_then(Value::as_bool).unwrap_or(false);
        let state = match v.get("state").and_then(Value::as_str) {
            Some("pending") => State::Pending,
            Some("failed") => State::Failed,
            Some("sent") => State::Sent,
            _ if mine => State::Sent,
            _ => State::Received,
        };
        let delivery = match v.get("delivery").and_then(Value::as_str) {
            Some("read") => Delivery::Read,
            Some("delivered") => Delivery::Delivered,
            _ => Delivery::None,
        };
        let reply = v.get("reply").and_then(|r| {
            Some(Quote { mine: r.get("from")?.as_str()? == me, text: sanitize(&one_line(r.get("text")?.as_str()?)) })
        });
        Some(Msg {
            id,
            mine,
            text: sanitize(v.get("text").and_then(Value::as_str).unwrap_or_default()),
            ts: v.get("ts").and_then(Value::as_f64).unwrap_or(0.0),
            state,
            delivery,
            edited: v.get("edited").and_then(Value::as_f64).unwrap_or(0.0) > 0.0,
            reply,
            att: v.get("att").is_some_and(|a| !a.is_null()),
            att_info: v.get("att").filter(|a| a.is_object()).map(att_label).unwrap_or_default(),
        })
    }
}

/// `image/png, 120 KB, 800x600`
fn att_label(a: &Value) -> String {
    let size = a.get("size").and_then(Value::as_f64).unwrap_or(0.0);
    let human = if size >= 1_048_576.0 {
        format!("{:.1} MB", size / 1_048_576.0)
    } else {
        format!("{:.0} KB", (size / 1024.0).max(1.0))
    };
    format!(
        "{}, {human}, {}x{}",
        a.get("mime").and_then(Value::as_str).unwrap_or("file"),
        a.get("w").and_then(Value::as_u64).unwrap_or(0),
        a.get("h").and_then(Value::as_u64).unwrap_or(0)
    )
}

pub struct Chat {
    pub address: String,
    pub name: String,
    pub rows: Vec<Row>,
    pub last_read: f64,
    pub unread: usize,
    pub composer: Composer,
    pub reply_to: Option<String>,
    pub editing: Option<String>,
    stash: String,
    /// Selected row index (a message) while browsing history.
    pub sel: Option<usize>,
}

/// What the loader gives the app for each contact.
pub struct ChatSeed {
    pub address: String,
    pub name: String,
    pub messages: Vec<Value>,
    pub last_read: f64,
    pub draft: String,
}

impl Chat {
    fn last_ts(&self) -> f64 {
        self.rows.iter().rev().find_map(|r| matches!(r, Row::Msg(_)).then(|| r.ts())).unwrap_or(0.0)
    }

    pub fn last_msg(&self) -> Option<&Msg> {
        self.rows.iter().rev().find_map(|r| if let Row::Msg(m) = r { Some(m) } else { None })
    }

    fn count_unread(&self) -> usize {
        self.rows.iter().filter(|r| matches!(r, Row::Msg(m) if !m.mine && m.ts > self.last_read)).count()
    }

    fn msg_at(&self, i: usize) -> Option<&Msg> {
        match self.rows.get(i) {
            Some(Row::Msg(m)) => Some(m),
            _ => None,
        }
    }
}

/// Things the shell must do for the reducer.
#[derive(Debug, Clone, PartialEq)]
pub enum Intent {
    Send {
        peer: String,
        text: String,
        reply: Option<Reply>,
    },
    Edit {
        peer: String,
        id: String,
        text: String,
    },
    Delete {
        peer: String,
        id: String,
    },
    Seen {
        peer: String,
        ids: Vec<String>,
    },
    Copy(String),
    OpenUrl(String),
    ExternalEditor,
    AddContact {
        address: String,
        name: String,
    },
    SaveState,
    Quit,
    /// Encrypt and upload a file, then send it with an optional caption.
    Attach {
        peer: String,
        path: String,
        caption: String,
    },
    /// Download (if needed), save and open an attachment.
    OpenAttachment {
        peer: String,
        id: String,
    },
    AddDevice,
    CancelLink,
    RemoveDevice(String),
    CopyHistory(String),
    Mute {
        peer: String,
        on: bool,
    },
    Block {
        peer: String,
        on: bool,
    },
    DeleteChat {
        peer: String,
    },
    DeleteContact {
        peer: String,
    },
    Verify {
        peer: String,
        on: bool,
    },
    /// Show a QR code popup: `address` (invite link) or `safety`.
    ShowQr(QrKind),
    /// Live typing text of the open chat (opt-in).
    Live {
        peer: String,
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrKind {
    Address,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Popup {
    None,
    Help {
        scroll: usize,
    },
    Address,
    Switcher {
        query: Composer,
        sel: usize,
    },
    NewChat {
        address: Composer,
        name: Composer,
        field: usize,
        error: Option<String>,
    },
    ConfirmDelete {
        peer: String,
        id: String,
    },
    ConfirmQuit,
    Command(Composer),
    /// A link code on offer: QR lines, the code and the app link.
    Link {
        code: String,
        lines: Vec<String>,
        url: String,
    },
    /// A QR code with a title and a note (your address).
    Qr {
        title: String,
        lines: Vec<String>,
        note: String,
    },
    Devices {
        sel: usize,
    },
    Safety {
        peer: String,
    },
    Search {
        query: Composer,
        global: bool,
        sel: usize,
    },
    Confirm {
        prompt: String,
        intent: Box<Intent>,
    },
}

/// Where things were drawn last, for the mouse.
#[derive(Debug, Default, Clone)]
pub struct Hit {
    pub list: Rect,
    /// Chat index per two-line row of the list, starting at `list.y`.
    pub list_rows: Vec<usize>,
    pub hist: Rect,
    /// Row index per screen line of the history area.
    pub hist_lines: Vec<Option<usize>>,
    pub composer: Rect,
    pub comp_width: usize,
}

pub struct App {
    pub me: String,
    pub chats: Vec<Chat>,
    pub cur: usize,
    pub focus: Focus,
    pub popup: Popup,
    pub conn: Conn,
    pub focused: bool,
    pub now: f64,
    pub tz: jiff::tz::TimeZone,
    pub keys: KeyMap,
    pub cfg: Config,
    pub theme: Theme,
    pub notice: Option<(String, u8)>,
    pub quit: bool,
    pub size: (u16, u16),
    /// Lines scrolled up from the bottom of the history; 0 follows new messages.
    pub offset: usize,
    pub reveal: bool,
    pub view_h: usize,
    pub list_top: usize,
    pub hit: Hit,
    pub version: &'static str,
    /// Address popup shows the full address only after the reveal key.
    pub addr_reveal: bool,
    /// History copy progress `(done, total)`.
    pub history: Option<(u64, u64)>,
    pub muted: Vec<String>,
    pub blocked: Vec<String>,
    /// Chats whose safety number was marked verified.
    pub verified: Vec<String>,
    /// This account's devices `(address, label)` and this device's own address.
    pub devices: Vec<(String, String)>,
    pub my_device: String,
    /// Live typing text of other people, by chat address.
    pub live: std::collections::HashMap<String, String>,
    last_live: String,
}

impl App {
    pub fn new(me: &str, seeds: Vec<ChatSeed>, cfg: Config, theme: Theme, keys: KeyMap) -> App {
        let mut app = App {
            me: me.to_string(),
            chats: Vec::new(),
            cur: 0,
            focus: Focus::Composer,
            popup: Popup::None,
            conn: Conn::Connecting,
            focused: true,
            now: 0.0,
            tz: jiff::tz::TimeZone::system(),
            keys,
            cfg,
            theme,
            notice: None,
            quit: false,
            size: (80, 24),
            offset: 0,
            reveal: false,
            view_h: 10,
            list_top: 0,
            hit: Hit::default(),
            version: env!("CARGO_PKG_VERSION"),
            addr_reveal: false,
            history: None,
            muted: Vec::new(),
            blocked: Vec::new(),
            verified: Vec::new(),
            devices: Vec::new(),
            my_device: String::new(),
            live: std::collections::HashMap::new(),
            last_live: String::new(),
        };
        for s in seeds {
            let mut chat = Chat {
                address: s.address,
                name: s.name,
                rows: Vec::new(),
                last_read: s.last_read,
                unread: 0,
                composer: Composer::default(),
                reply_to: None,
                editing: None,
                stash: String::new(),
                sel: None,
            };
            chat.composer.set(&s.draft);
            chat.rows = s.messages.iter().filter_map(|v| Msg::from_value(v, me)).map(Row::Msg).collect();
            chat.unread = chat.count_unread();
            app.chats.push(chat);
        }
        app.sort_chats(None);
        if let Some(i) = app.chats.iter().position(|c| c.unread > 0) {
            app.cur = i;
            app.focus = Focus::List;
        }
        if app.chats.is_empty() {
            app.focus = Focus::List;
        }
        app
    }

    // ---- small accessors ------------------------------------------------------------------

    pub fn chat(&self) -> Option<&Chat> {
        self.chats.get(self.cur)
    }

    fn chat_mut(&mut self) -> Option<&mut Chat> {
        self.chats.get_mut(self.cur)
    }

    pub fn narrow(&self) -> bool {
        self.size.0 < self.cfg.sidebar_collapse_below
    }

    /// Is the user in the conversation (not just browsing the chat list)?
    pub fn conversation_visible(&self) -> bool {
        self.focus != Focus::List
    }

    pub fn say(&mut self, msg: impl Into<String>) {
        self.notice = Some((msg.into(), 4));
    }

    /// Called once a second.
    pub fn tick(&mut self, now: f64) {
        self.now = now;
        if let Some((_, ttl)) = &mut self.notice {
            *ttl = ttl.saturating_sub(1);
            if *ttl == 0 {
                self.notice = None;
            }
        }
    }

    fn sort_chats(&mut self, keep: Option<String>) {
        let keep = keep.or_else(|| self.chat().map(|c| c.address.clone()));
        self.chats.sort_by(|a, b| {
            b.last_ts()
                .partial_cmp(&a.last_ts())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        if let Some(k) = keep {
            self.cur = self.chats.iter().position(|c| c.address == k).unwrap_or(0);
        }
    }

    // ---- data in --------------------------------------------------------------------------

    /// Replaces the messages of one chat (after a network or store change).
    pub fn set_messages(&mut self, address: &str, messages: &[Value]) {
        let me = self.me.clone();
        let Some(i) = self.chats.iter().position(|c| c.address == address) else { return };
        let chat = &mut self.chats[i];
        let fresh: Vec<Msg> = messages.iter().filter_map(|v| Msg::from_value(v, &me)).collect();
        let had_any = chat.rows.iter().any(|r| matches!(r, Row::Msg(_)));
        let mut rows: Vec<Row> = Vec::new();
        for old in &chat.rows {
            match old {
                Row::Msg(m) if had_any && !fresh.iter().any(|f| f.id == m.id && f.mine == m.mine) => {
                    rows.push(Row::Gone { ts: m.ts, mine: m.mine });
                }
                Row::Gone { .. } => rows.push(old.clone()),
                Row::Msg(_) => {}
            }
        }
        rows.extend(fresh.into_iter().map(Row::Msg));
        rows.sort_by(|a, b| a.ts().partial_cmp(&b.ts()).unwrap_or(std::cmp::Ordering::Equal));
        let selected_id = chat.sel.and_then(|s| chat.msg_at(s)).map(|m| m.id.clone());
        chat.rows = rows;
        chat.sel = selected_id.and_then(|id| chat.rows.iter().position(|r| matches!(r, Row::Msg(m) if m.id == id)));
        chat.unread = chat.count_unread();
        let keep = Some(self.chats[self.cur].address.clone());
        self.sort_chats(keep);
    }

    pub fn add_chat(&mut self, address: &str, name: &str) -> usize {
        if let Some(i) = self.chats.iter().position(|c| c.address == address) {
            return i;
        }
        self.chats.push(Chat {
            address: address.to_string(),
            name: sanitize(name),
            rows: Vec::new(),
            last_read: 0.0,
            unread: 0,
            composer: Composer::default(),
            reply_to: None,
            editing: None,
            stash: String::new(),
            sel: None,
        });
        self.chats.len() - 1
    }

    pub fn rename_chat(&mut self, address: &str, name: &str) {
        if let Some(c) = self.chats.iter_mut().find(|c| c.address == address) {
            c.name = sanitize(name);
        }
    }

    /// Should a new message in `address` make noise?
    pub fn is_watching(&self, address: &str) -> bool {
        self.focused
            && self.conversation_visible()
            && self.offset == 0
            && self.chat().is_some_and(|c| c.address == address)
    }

    /// Marks the open chat read when it is on screen and the terminal has focus. Returns receipts to send.
    pub fn mark_read(&mut self) -> Vec<Intent> {
        if !(self.focused && self.conversation_visible() && self.offset == 0) || !matches!(self.popup, Popup::None) {
            return vec![];
        }
        let receipts = self.cfg.show_receipts;
        let Some(chat) = self.chat_mut() else { return vec![] };
        let newest = chat.last_ts();
        if newest <= chat.last_read {
            return vec![];
        }
        let ids: Vec<String> = chat
            .rows
            .iter()
            .filter_map(|r| match r {
                Row::Msg(m) if !m.mine && m.ts > chat.last_read => Some(m.id.clone()),
                _ => None,
            })
            .collect();
        chat.last_read = newest;
        chat.unread = 0;
        let peer = chat.address.clone();
        let mut out = vec![Intent::SaveState];
        if receipts {
            for part in ids.chunks(50) {
                out.push(Intent::Seen { peer: peer.clone(), ids: part.to_vec() });
            }
        }
        out
    }

    /// Read markers and drafts to store.
    pub fn export_state(&self) -> Value {
        let mut read = serde_json::Map::new();
        let mut drafts = serde_json::Map::new();
        for c in &self.chats {
            read.insert(c.address.clone(), json!(c.last_read));
            if !c.composer.is_empty() && c.editing.is_none() {
                drafts.insert(c.address.clone(), json!(c.composer.text()));
            } else if !c.stash.is_empty() {
                drafts.insert(c.address.clone(), json!(c.stash));
            }
        }
        json!({"read": read, "drafts": drafts})
    }

    fn has_drafts(&self) -> bool {
        self.chats.iter().any(|c| !c.composer.is_empty() || !c.stash.is_empty())
    }

    /// Text written in `$EDITOR` replaces the composer.
    pub fn set_composer(&mut self, text: &str) {
        if let Some(c) = self.chat_mut() {
            c.composer.set(text.trim_end_matches('\n'));
        }
        self.focus = Focus::Composer;
    }

    pub fn composer_text(&self) -> String {
        self.chat().map(|c| c.composer.text().to_string()).unwrap_or_default()
    }

    // ---- navigation helpers ---------------------------------------------------------------

    pub fn open_chat(&mut self, idx: usize) {
        if idx < self.chats.len() {
            self.cur = idx;
            self.offset = 0;
            self.reveal = false;
            self.focus = Focus::Composer;
            if let Some(c) = self.chat_mut() {
                c.sel = None;
            }
        }
    }

    fn msg_indices(&self) -> Vec<usize> {
        self.chat()
            .map(|c| c.rows.iter().enumerate().filter_map(|(i, r)| matches!(r, Row::Msg(_)).then_some(i)).collect())
            .unwrap_or_default()
    }

    fn select_last(&mut self) {
        let last = self.msg_indices().last().copied();
        if let Some(c) = self.chat_mut() {
            if c.sel.is_none() {
                c.sel = last;
            }
        }
        self.reveal = true;
    }

    fn set_focus(&mut self, focus: Focus) {
        self.focus = focus;
        match focus {
            Focus::History => self.select_last(),
            Focus::Composer => {
                if let Some(c) = self.chat_mut() {
                    c.sel = None;
                }
            }
            Focus::List => {}
        }
    }

    fn move_sel(&mut self, delta: isize, to: Option<bool>) {
        let idx = self.msg_indices();
        if idx.is_empty() {
            return;
        }
        let Some(chat) = self.chat() else { return };
        let pos = chat.sel.and_then(|s| idx.iter().position(|i| *i == s));
        let new = match (to, pos) {
            (Some(true), _) => 0,
            (Some(false), _) => idx.len() - 1,
            (None, None) => idx.len() - 1,
            (None, Some(p)) => (p as isize + delta).clamp(0, idx.len() as isize - 1) as usize,
        };
        let at_end = new == idx.len() - 1;
        let target = idx[new];
        if let Some(c) = self.chat_mut() {
            c.sel = Some(target);
        }
        if at_end && delta >= 0 {
            self.offset = 0;
        }
        self.reveal = true;
    }

    // ---- keys -----------------------------------------------------------------------------

    pub fn handle_key(&mut self, key: KeyEvent) -> Vec<Intent> {
        if key.kind == KeyEventKind::Release {
            return vec![];
        }
        if !matches!(self.popup, Popup::None) {
            return self.popup_key(key);
        }
        let mode = match self.focus {
            Focus::List => Mode::List,
            Focus::History => Mode::History,
            Focus::Composer => Mode::Composer,
        };
        if let Some(action) = self.keys.lookup(mode, &key) {
            if let Some(out) = self.perform(action) {
                return out;
            }
        }
        if self.focus == Focus::Composer {
            let w = self.hit.comp_width.max(10);
            if let Some(c) = self.chat_mut() {
                c.composer.handle_key(&key, w);
            }
            return self.live_intent();
        }
        vec![]
    }

    /// With `live_text` on, the composer text is sent as an ephemeral frame (shell throttles it).
    fn live_intent(&mut self) -> Vec<Intent> {
        if !self.cfg.live_text {
            return vec![];
        }
        let Some(c) = self.chat() else { return vec![] };
        if c.editing.is_some() || c.composer.text().starts_with('/') || c.composer.text().starts_with(':') {
            return vec![];
        }
        let (text, peer) = (c.composer.text().to_string(), c.address.clone());
        if text == self.last_live {
            return vec![];
        }
        self.last_live = text.clone();
        vec![Intent::Live { peer, text }]
    }

    /// `None` means "not handled, treat as a plain key".
    fn perform(&mut self, action: Action) -> Option<Vec<Intent>> {
        let mut out = vec![];
        match action {
            Action::Quit => return Some(self.request_quit()),
            Action::Help => self.popup = Popup::Help { scroll: 0 },
            Action::Address => self.popup = Popup::Address,
            Action::Switcher => self.popup = Popup::Switcher { query: Composer::default(), sel: 0 },
            Action::NewChat => {
                self.popup =
                    Popup::NewChat { address: Composer::default(), name: Composer::default(), field: 0, error: None }
            }
            Action::Command => self.popup = Popup::Command(Composer::default()),
            Action::NextUnread => {
                let n = self.chats.len();
                match (1..=n)
                    .map(|k| (self.cur + k) % n.max(1))
                    .find(|i| self.chats.get(*i).is_some_and(|c| c.unread > 0))
                {
                    Some(i) => self.open_chat(i),
                    None => self.say("No unread chats"),
                }
            }
            Action::PrevChat | Action::NextChat if !self.chats.is_empty() => {
                let n = self.chats.len();
                let i = if action == Action::NextChat { (self.cur + 1) % n } else { (self.cur + n - 1) % n };
                let keep = self.focus;
                self.open_chat(i);
                if keep == Focus::List {
                    self.focus = Focus::List;
                }
            }
            Action::PrevChat | Action::NextChat => {}
            Action::FocusNext | Action::FocusPrev => {
                let next = match (self.focus, action == Action::FocusNext) {
                    (Focus::List, true) => Focus::History,
                    (Focus::History, true) => Focus::Composer,
                    (Focus::Composer, true) => Focus::List,
                    (Focus::List, false) => Focus::Composer,
                    (Focus::History, false) => Focus::List,
                    (Focus::Composer, false) => Focus::History,
                };
                self.set_focus(if self.chats.is_empty() { Focus::List } else { next });
            }
            Action::Back => self.set_focus(Focus::List),
            Action::Up | Action::Down | Action::Top | Action::Bottom => self.navigate(action),
            Action::PageUp => {
                self.offset += self.view_h.saturating_sub(2).max(1);
                self.reveal = false;
            }
            Action::PageDown => {
                self.offset = self.offset.saturating_sub(self.view_h.saturating_sub(2).max(1));
                self.reveal = false;
            }
            Action::OpenChat => {
                if !self.chats.is_empty() {
                    self.set_focus(Focus::Composer);
                }
            }
            Action::Compose => self.set_focus(Focus::Composer),
            Action::Reply => self.start_reply(),
            Action::Edit => self.start_edit_selected(),
            Action::Delete => return Some(self.start_delete()),
            Action::Copy => {
                if let Some(m) = self.selected_msg() {
                    out.push(Intent::Copy(m.text.clone()));
                    self.say("Copied to the clipboard (terminal permitting)");
                }
            }
            Action::OpenLink => {
                if let Some(m) = self.selected_msg().filter(|m| m.att) {
                    if let Some(c) = self.chat() {
                        out.push(Intent::OpenAttachment { peer: c.address.clone(), id: m.id });
                        self.say("Opening the attachment...");
                    }
                } else if let Some(m) = self.selected_msg() {
                    let found = links(&m.text);
                    match found.first() {
                        Some(u) => {
                            out.push(Intent::OpenUrl(u.clone()));
                            if found.len() > 1 {
                                self.say(format!("{} links; opened the first", found.len()));
                            }
                        }
                        None => self.say("No link in this message"),
                    }
                }
            }
            Action::Send => return Some(self.send()),
            Action::Newline => {
                if let Some(c) = self.chat_mut() {
                    c.composer.newline();
                }
            }
            Action::EditLast => {
                if !self.chat().is_some_and(|c| c.composer.is_empty()) {
                    return None;
                }
                self.start_edit_last();
            }
            Action::OpenEditor => return Some(vec![Intent::ExternalEditor]),
            Action::Cancel => self.cancel_composer(),
            Action::Search => self.open_search(false),
            Action::GlobalSearch => self.open_search(true),
            Action::Devices => self.popup = Popup::Devices { sel: 0 },
        }
        Some(out)
    }

    fn navigate(&mut self, action: Action) {
        match self.focus {
            Focus::List => {
                let n = self.chats.len();
                if n == 0 {
                    return;
                }
                self.cur = match action {
                    Action::Up => self.cur.saturating_sub(1),
                    Action::Down => (self.cur + 1).min(n - 1),
                    Action::Top => 0,
                    _ => n - 1,
                };
                self.offset = 0;
                if let Some(c) = self.chat_mut() {
                    c.sel = None;
                }
            }
            _ => match action {
                Action::Up => self.move_sel(-1, None),
                Action::Down => self.move_sel(1, None),
                Action::Top => self.move_sel(0, Some(true)),
                _ => {
                    self.move_sel(0, Some(false));
                    self.offset = 0;
                }
            },
        }
    }

    fn selected_msg(&self) -> Option<Msg> {
        let c = self.chat()?;
        c.msg_at(c.sel?).cloned()
    }

    fn start_reply(&mut self) {
        let Some(m) = self.selected_msg() else { return };
        if m.state == State::Pending || m.state == State::Failed {
            self.say("Wait until the message is sent");
            return;
        }
        if let Some(c) = self.chat_mut() {
            c.reply_to = Some(m.id);
            c.editing = None;
        }
        self.set_focus(Focus::Composer);
    }

    fn start_edit_selected(&mut self) {
        let Some(m) = self.selected_msg() else { return };
        self.begin_edit(m);
    }

    fn start_edit_last(&mut self) {
        let last = self.chat().and_then(|c| {
            c.rows.iter().rev().find_map(|r| match r {
                Row::Msg(m) if m.mine => Some(m.clone()),
                _ => None,
            })
        });
        match last {
            Some(m) => self.begin_edit(m),
            None => self.say("You have no message to edit yet"),
        }
    }

    fn begin_edit(&mut self, m: Msg) {
        if !m.mine {
            self.say("You can only edit your own messages");
            return;
        }
        if m.state != State::Sent {
            self.say("Wait until the message is sent");
            return;
        }
        if m.att {
            self.say("Attachments cannot be edited");
            return;
        }
        if self.conn != Conn::Online {
            self.say("Offline: editing needs a connection");
            return;
        }
        if let Some(c) = self.chat_mut() {
            if c.editing.is_none() {
                c.stash = c.composer.take();
            }
            c.editing = Some(m.id.clone());
            c.reply_to = None;
            c.composer.set(&m.text);
        }
        self.set_focus(Focus::Composer);
    }

    fn start_delete(&mut self) -> Vec<Intent> {
        let Some(m) = self.selected_msg() else { return vec![] };
        if !m.mine {
            self.say("You can only delete your own messages");
            return vec![];
        }
        if m.state != State::Sent {
            self.say("Wait until the message is sent");
            return vec![];
        }
        if self.conn != Conn::Online {
            self.say("Offline: deleting needs a connection");
            return vec![];
        }
        let peer = self.chat().map(|c| c.address.clone()).unwrap_or_default();
        if self.cfg.confirm_delete {
            self.popup = Popup::ConfirmDelete { peer, id: m.id };
            vec![]
        } else {
            vec![Intent::Delete { peer, id: m.id }]
        }
    }

    fn cancel_composer(&mut self) {
        let Some(c) = self.chat_mut() else { return };
        if c.editing.is_some() {
            c.editing = None;
            let stash = std::mem::take(&mut c.stash);
            c.composer.set(&stash);
        } else if c.reply_to.is_some() {
            c.reply_to = None;
        } else {
            self.set_focus(Focus::History);
        }
    }

    fn send(&mut self) -> Vec<Intent> {
        let Some(chat) = self.chat() else { return vec![] };
        let text = js_trim(chat.composer.text()).to_string();
        if text.is_empty() {
            return vec![];
        }
        if utf16_len(&text) > MAX_TEXT {
            self.say(format!("Too long: {} of {MAX_TEXT} characters", utf16_len(&text)));
            return vec![];
        }
        let peer = chat.address.clone();
        // A `:command` typed in the composer runs the command and is never sent; `::text` sends ":text".
        let mut text = text;
        if chat.editing.is_none() && !text.contains('\n') {
            if let Some(rest) = text.strip_prefix("::") {
                text = format!(":{rest}");
            } else if let Some(body) = text.strip_prefix(':') {
                let name = body.split_whitespace().next().unwrap_or_default();
                if !name.is_empty() && !COMMANDS.contains(&name) {
                    self.say(format!("Unknown command :{name}, use ::text to send a literal colon"));
                    return vec![];
                }
                self.chat_mut().expect("chat").composer.take();
                self.offset = 0;
                return self.run_command(&text);
            }
        }
        if let Some(rest) = text.strip_prefix("/attach ") {
            let (path, caption) = match rest.split_once(" | ") {
                Some((p, c)) => (p.trim(), c.trim()),
                None => (rest.trim(), ""),
            };
            let path = path.trim_matches(|c| c == '"' || c == '\'').to_string();
            let chat = self.chat_mut().expect("chat");
            chat.composer.take();
            self.offset = 0;
            self.say("Sending the file...");
            return vec![Intent::Attach { peer, path, caption: caption.to_string() }];
        }
        if let Some(id) = chat.editing.clone() {
            let unchanged = chat.msg_by_id(&id).is_some_and(|m| m.text == text);
            let chat = self.chat_mut().expect("chat");
            chat.editing = None;
            chat.composer.set(&std::mem::take(&mut chat.stash));
            if unchanged {
                return vec![];
            }
            return vec![Intent::Edit { peer, id, text }];
        }
        let reply = chat.reply_to.as_ref().and_then(|id| chat.msg_by_id(id)).map(|m| Reply {
            id: m.id.clone(),
            from: if m.mine { self.me.clone() } else { peer.clone() },
            text: m.text.chars().take(200).collect(),
        });
        let chat = self.chat_mut().expect("chat");
        chat.composer.take();
        chat.reply_to = None;
        self.offset = 0;
        vec![Intent::Send { peer, text, reply }]
    }

    fn request_quit(&mut self) -> Vec<Intent> {
        if self.has_drafts() {
            self.popup = Popup::ConfirmQuit;
            vec![]
        } else {
            self.quit = true;
            vec![Intent::SaveState, Intent::Quit]
        }
    }

    // ---- popups ---------------------------------------------------------------------------

    fn popup_key(&mut self, key: KeyEvent) -> Vec<Intent> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let popup = std::mem::replace(&mut self.popup, Popup::None);
        match popup {
            Popup::None => vec![],
            Popup::Help { scroll } => {
                let scroll = match key.code {
                    KeyCode::Esc | KeyCode::Char('q' | '?') | KeyCode::Enter | KeyCode::F(1) => return vec![],
                    KeyCode::Down | KeyCode::Char('j') => scroll + 1,
                    KeyCode::Up | KeyCode::Char('k') => scroll.saturating_sub(1),
                    KeyCode::PageDown => scroll + 8,
                    KeyCode::PageUp => scroll.saturating_sub(8),
                    _ => scroll,
                };
                self.popup = Popup::Help { scroll };
                vec![]
            }
            Popup::Address => match key.code {
                KeyCode::Char('c' | 'y') => {
                    self.say("Address copied (terminal permitting)");
                    vec![Intent::Copy(self.me.clone())]
                }
                KeyCode::Char('r') => {
                    self.addr_reveal = !self.addr_reveal;
                    self.popup = Popup::Address;
                    vec![]
                }
                KeyCode::Char('Q') => vec![Intent::ShowQr(QrKind::Address)],
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter | KeyCode::F(2) => {
                    self.addr_reveal = false;
                    vec![]
                }
                _ => {
                    self.popup = Popup::Address;
                    vec![]
                }
            },
            Popup::Switcher { mut query, mut sel } => {
                let results = self.switcher_results(query.text());
                match key.code {
                    KeyCode::Esc => return vec![],
                    KeyCode::Enter => {
                        if let Some(i) = results.get(sel) {
                            self.open_chat(*i);
                        }
                        return vec![];
                    }
                    KeyCode::Down | KeyCode::Tab => sel = (sel + 1).min(results.len().saturating_sub(1)),
                    KeyCode::Up | KeyCode::BackTab => sel = sel.saturating_sub(1),
                    KeyCode::Char('j' | 'n') if ctrl => sel = (sel + 1).min(results.len().saturating_sub(1)),
                    KeyCode::Char('k' | 'p') if ctrl => sel = sel.saturating_sub(1),
                    _ => {
                        query.handle_key(&key, 60);
                        sel = 0;
                    }
                }
                self.popup = Popup::Switcher { query, sel };
                vec![]
            }
            Popup::NewChat { mut address, mut name, mut field, mut error } => {
                match key.code {
                    KeyCode::Esc => return vec![],
                    KeyCode::Tab | KeyCode::BackTab | KeyCode::Down | KeyCode::Up => field = 1 - field,
                    KeyCode::Enter => {
                        let addr = js_trim(address.text()).to_lowercase();
                        if !is_address(&addr) {
                            error = Some("That is not a valid MIGA address (64 hex characters)".into());
                            field = 0;
                        } else if addr == self.me {
                            error = Some("That is your own address".into());
                            field = 0;
                        } else if field == 0 && name.is_empty() {
                            field = 1;
                            error = None;
                        } else {
                            let nm = js_trim(name.text()).to_string();
                            let nm = if nm.is_empty() { format!("{}...", &addr[..8]) } else { nm };
                            let idx = self.add_chat(&addr, &nm);
                            self.sort_chats(None);
                            let idx = self.chats.iter().position(|c| c.address == addr).unwrap_or(idx);
                            self.open_chat(idx);
                            return vec![Intent::AddContact { address: addr, name: nm }];
                        }
                    }
                    _ => {
                        let target = if field == 0 { &mut address } else { &mut name };
                        target.handle_key(&key, 80);
                        error = None;
                    }
                }
                self.popup = Popup::NewChat { address, name, field, error };
                vec![]
            }
            Popup::ConfirmDelete { peer, id } => match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => vec![Intent::Delete { peer, id }],
                KeyCode::Char('n' | 'N') | KeyCode::Esc => vec![],
                _ => {
                    self.popup = Popup::ConfirmDelete { peer, id };
                    vec![]
                }
            },
            Popup::ConfirmQuit => match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                    self.quit = true;
                    vec![Intent::SaveState, Intent::Quit]
                }
                KeyCode::Char('n' | 'N') | KeyCode::Esc => vec![],
                _ => {
                    self.popup = Popup::ConfirmQuit;
                    vec![]
                }
            },
            Popup::Link { code, lines, url } => match key.code {
                KeyCode::Esc | KeyCode::Char('q') => vec![Intent::CancelLink],
                KeyCode::Char('c' | 'y') => {
                    self.say("Code copied (terminal permitting)");
                    self.popup = Popup::Link { code: code.clone(), lines, url };
                    vec![Intent::Copy(code)]
                }
                _ => {
                    self.popup = Popup::Link { code, lines, url };
                    vec![]
                }
            },
            Popup::Qr { title, lines, note } => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => vec![],
                _ => {
                    self.popup = Popup::Qr { title, lines, note };
                    vec![]
                }
            },
            Popup::Devices { mut sel } => {
                let n = self.devices.len();
                match key.code {
                    KeyCode::Esc | KeyCode::Char('q') | KeyCode::F(3) => return vec![],
                    KeyCode::Char('j') | KeyCode::Down => sel = (sel + 1).min(n.saturating_sub(1)),
                    KeyCode::Char('k') | KeyCode::Up => sel = sel.saturating_sub(1),
                    KeyCode::Char('a') => return vec![Intent::AddDevice],
                    KeyCode::Char('c') => {
                        if let Some((a, _)) = self.devices.get(sel).cloned() {
                            self.say("Copying the history from that device...");
                            return vec![Intent::CopyHistory(a)];
                        }
                    }
                    KeyCode::Char('x') => {
                        if let Some((a, l)) = self.devices.get(sel).cloned() {
                            self.popup = Popup::Confirm {
                                prompt: format!("Remove {l}? It erases itself the next time it connects."),
                                intent: Box::new(Intent::RemoveDevice(a)),
                            };
                            return vec![];
                        }
                    }
                    _ => {}
                }
                self.popup = Popup::Devices { sel };
                vec![]
            }
            Popup::Safety { peer } => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => vec![],
                KeyCode::Char('v') => {
                    let on = !self.verified.contains(&peer);
                    self.set_verified(&peer, on);
                    self.popup = Popup::Safety { peer: peer.clone() };
                    vec![Intent::Verify { peer, on }]
                }
                KeyCode::Char('c') => {
                    let n = miga_core::crypto::safety_number(&self.me, &peer).unwrap_or_default();
                    self.popup = Popup::Safety { peer };
                    vec![Intent::Copy(n)]
                }
                _ => {
                    self.popup = Popup::Safety { peer };
                    vec![]
                }
            },
            Popup::Search { mut query, global, mut sel } => {
                let results = self.search_results(query.text(), global);
                match key.code {
                    KeyCode::Esc => return vec![],
                    KeyCode::Enter => {
                        if let Some((ci, ri, _)) = results.get(sel) {
                            self.jump_to(*ci, *ri);
                        }
                        return vec![];
                    }
                    KeyCode::Down | KeyCode::Tab => sel = (sel + 1).min(results.len().saturating_sub(1)),
                    KeyCode::Up | KeyCode::BackTab => sel = sel.saturating_sub(1),
                    _ => {
                        query.handle_key(&key, 60);
                        sel = 0;
                    }
                }
                self.popup = Popup::Search { query, global, sel };
                vec![]
            }
            Popup::Confirm { prompt, intent } => match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => vec![*intent],
                KeyCode::Char('n' | 'N') | KeyCode::Esc => vec![],
                _ => {
                    self.popup = Popup::Confirm { prompt, intent };
                    vec![]
                }
            },
            Popup::Command(mut line) => match key.code {
                KeyCode::Esc => vec![],
                KeyCode::Enter => self.run_command(line.text()),
                _ => {
                    line.handle_key(&key, 60);
                    self.popup = Popup::Command(line);
                    vec![]
                }
            },
        }
    }

    fn run_command(&mut self, line: &str) -> Vec<Intent> {
        let mut parts = line.trim().trim_start_matches(':').splitn(3, ' ');
        match parts.next().unwrap_or_default() {
            "" => {}
            "q" | "quit" => return self.request_quit(),
            "help" | "h" => self.popup = Popup::Help { scroll: 0 },
            "address" => self.popup = Popup::Address,
            "bell" => {
                self.cfg.notifications.bell = parts.next() != Some("off");
                self.say(if self.cfg.notifications.bell { "Bell on" } else { "Bell off" });
            }
            "add" => {
                let addr = js_trim(parts.next().unwrap_or_default()).to_lowercase();
                if is_address(&addr) && addr != self.me {
                    let nm = parts
                        .next()
                        .map(|n| js_trim(n).to_string())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| format!("{}...", &addr[..8]));
                    self.add_chat(&addr, &nm);
                    self.sort_chats(None);
                    let idx = self.chats.iter().position(|c| c.address == addr).unwrap_or(0);
                    self.open_chat(idx);
                    return vec![Intent::AddContact { address: addr, name: nm }];
                }
                self.say("Usage: :add <address> [name]");
            }
            "link" => return vec![Intent::AddDevice],
            "devices" => self.popup = Popup::Devices { sel: 0 },
            "search" => self.open_search_with(
                false,
                parts.next().map(|a| a.to_string() + &parts.next().map(|b| format!(" {b}")).unwrap_or_default()),
            ),
            "gsearch" => self.open_search_with(
                true,
                parts.next().map(|a| a.to_string() + &parts.next().map(|b| format!(" {b}")).unwrap_or_default()),
            ),
            "qr" => return vec![Intent::ShowQr(QrKind::Address)],
            "attach" => {
                let rest = line.trim().trim_start_matches(':').trim_start_matches("attach").trim();
                let Some(peer) = self.chat().map(|c| c.address.clone()) else { return vec![] };
                if rest.is_empty() {
                    self.say("Usage: :attach <path> [| caption]");
                } else {
                    let (path, caption) = rest.split_once(" | ").unwrap_or((rest, ""));
                    self.say("Sending the file...");
                    return vec![Intent::Attach {
                        peer,
                        path: path.trim().trim_matches(|c| c == '"' || c == '\'').to_string(),
                        caption: caption.trim().to_string(),
                    }];
                }
            }
            cmd @ ("mute" | "unmute" | "block" | "unblock" | "verify" | "unverify" | "safety") => {
                let Some(peer) = self.chat().map(|c| c.address.clone()) else {
                    self.say("Open a chat first");
                    return vec![];
                };
                match cmd {
                    "mute" | "unmute" => {
                        let on = cmd == "mute";
                        toggle(&mut self.muted, &peer, on);
                        self.say(if on { "Muted: no bell or notification" } else { "Unmuted" });
                        return vec![Intent::Mute { peer, on }];
                    }
                    "block" | "unblock" => {
                        let on = cmd == "block";
                        toggle(&mut self.blocked, &peer, on);
                        self.say(if on { "Blocked: their messages are dropped" } else { "Unblocked" });
                        return vec![Intent::Block { peer, on }];
                    }
                    "verify" | "unverify" => {
                        let on = cmd == "verify";
                        self.set_verified(&peer, on);
                        self.say(if on { "Marked verified" } else { "Verification removed" });
                        return vec![Intent::Verify { peer, on }];
                    }
                    _ => self.popup = Popup::Safety { peer },
                }
            }
            "delete" => {
                let Some((peer, name)) = self.chat().map(|c| (c.address.clone(), c.name.clone())) else {
                    return vec![];
                };
                match parts.next() {
                    Some("chat") => {
                        self.popup = Popup::Confirm {
                            prompt: format!("Delete the chat with {name} on all your devices? (Their copy stays.)"),
                            intent: Box::new(Intent::DeleteChat { peer }),
                        }
                    }
                    Some("contact") => {
                        self.popup = Popup::Confirm {
                            prompt: format!("Delete the contact {name} and the chat on all your devices?"),
                            intent: Box::new(Intent::DeleteContact { peer }),
                        }
                    }
                    _ => self.say("Usage: :delete chat | :delete contact"),
                }
            }
            other => self.say(format!("Unknown command :{other}, use ::text to send a literal colon")),
        }
        vec![]
    }

    // ---- search, lists and small state ------------------------------------------------------

    fn open_search(&mut self, global: bool) {
        self.open_search_with(global, None);
    }

    fn open_search_with(&mut self, global: bool, text: Option<String>) {
        let mut query = Composer::default();
        if let Some(t) = text {
            query.insert(&t);
        }
        self.popup = Popup::Search { query, global, sel: 0 };
    }

    /// `(chat index, row index, line to show)` of messages containing `query` (case-insensitive).
    pub fn search_results(&self, query: &str, global: bool) -> Vec<(usize, usize, String)> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return vec![];
        }
        let mut out = Vec::new();
        for (ci, chat) in self.chats.iter().enumerate() {
            if !global && ci != self.cur {
                continue;
            }
            for (ri, row) in chat.rows.iter().enumerate().rev() {
                if let Row::Msg(m) = row {
                    if m.text.to_lowercase().contains(&q) {
                        let who = if global { format!("{}: ", chat.name) } else { String::new() };
                        out.push((ci, ri, format!("{who}{}", one_line(&m.text))));
                    }
                }
                if out.len() >= 200 {
                    return out;
                }
            }
        }
        out
    }

    fn jump_to(&mut self, ci: usize, ri: usize) {
        self.open_chat(ci);
        self.focus = Focus::History;
        if let Some(c) = self.chat_mut() {
            c.sel = Some(ri);
        }
        self.reveal = true;
    }

    pub fn set_verified(&mut self, peer: &str, on: bool) {
        toggle(&mut self.verified, peer, on);
    }

    pub fn is_muted(&self, peer: &str) -> bool {
        self.muted.iter().any(|m| m == peer)
    }

    pub fn is_blocked(&self, peer: &str) -> bool {
        self.blocked.iter().any(|m| m == peer)
    }

    /// Removes a chat from the list (deleted contact or conversation).
    pub fn drop_chat(&mut self, peer: &str, whole_contact: bool) {
        let keep = self.chat().map(|c| c.address.clone()).filter(|a| a != peer);
        if whole_contact {
            self.chats.retain(|c| c.address != peer);
        } else if let Some(c) = self.chats.iter_mut().find(|c| c.address == peer) {
            c.rows.clear();
            c.unread = 0;
        }
        self.sort_chats(keep);
        if self.cur >= self.chats.len() {
            self.cur = 0;
        }
    }

    /// Everything read up to `ts` (another device read it, or it is old history).
    pub fn read_up_to(&mut self, peer: &str, ts: f64) {
        if let Some(c) = self.chats.iter_mut().find(|c| c.address == peer) {
            if ts > c.last_read {
                c.last_read = ts;
            }
            c.unread = c.count_unread();
        }
    }

    /// Chat indices matching the switcher query, best first.
    pub fn switcher_results(&self, query: &str) -> Vec<usize> {
        let mut scored: Vec<(i32, usize)> = self
            .chats
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                let s = fuzzy(query, &c.name).or_else(|| fuzzy(query, &c.address).map(|s| s - 50))?;
                Some((s + if c.unread > 0 { 5 } else { 0 }, i))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.into_iter().map(|(_, i)| i).collect()
    }

    // ---- paste, mouse, focus --------------------------------------------------------------

    pub fn handle_paste(&mut self, text: &str) {
        match &mut self.popup {
            Popup::NewChat { address, name, field, .. } => {
                let t = if *field == 0 { address } else { name };
                t.insert(&text.split_whitespace().collect::<Vec<_>>().join(" "));
            }
            Popup::Switcher { query, .. } => query.insert(&one_line(text)),
            Popup::Command(c) => c.insert(&one_line(text)),
            Popup::None => {
                if self.focus != Focus::Composer && !self.chats.is_empty() {
                    self.set_focus(Focus::Composer);
                }
                if let Some(c) = self.chat_mut() {
                    c.composer.insert(text);
                }
            }
            _ => {}
        }
    }

    pub fn handle_mouse(&mut self, ev: MouseEvent) -> Vec<Intent> {
        if !self.cfg.mouse || !matches!(self.popup, Popup::None) {
            return vec![];
        }
        let inside =
            |r: Rect| ev.column >= r.x && ev.column < r.x + r.width && ev.row >= r.y && ev.row < r.y + r.height;
        match ev.kind {
            MouseEventKind::ScrollUp if inside(self.hit.hist) => {
                self.offset += 3;
                self.reveal = false;
            }
            MouseEventKind::ScrollDown if inside(self.hit.hist) => {
                self.offset = self.offset.saturating_sub(3);
                self.reveal = false;
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if inside(self.hit.list) {
                    let line = usize::from(ev.row - self.hit.list.y) / 2;
                    if let Some(i) = self.hit.list_rows.get(line).copied() {
                        self.open_chat(i);
                    }
                } else if inside(self.hit.hist) {
                    let line = usize::from(ev.row - self.hit.hist.y);
                    if let Some(Some(row)) = self.hit.hist_lines.get(line).copied() {
                        if self.chat().is_some_and(|c| c.msg_at(row).is_some()) {
                            self.focus = Focus::History;
                            if let Some(c) = self.chat_mut() {
                                c.sel = Some(row);
                            }
                        }
                    }
                } else if inside(self.hit.composer) && !self.chats.is_empty() {
                    self.set_focus(Focus::Composer);
                }
            }
            _ => {}
        }
        vec![]
    }
}

fn toggle(list: &mut Vec<String>, item: &str, on: bool) {
    list.retain(|x| x != item);
    if on {
        list.push(item.to_string());
    }
}

impl Chat {
    pub fn msg_by_id(&self, id: &str) -> Option<&Msg> {
        self.rows.iter().find_map(|r| match r {
            Row::Msg(m) if m.id == id => Some(m),
            _ => None,
        })
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::tui::config::KeybindConfig;
    use crate::tui::theme::ColorMode;

    pub const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    pub const ANNA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    pub const BORIS: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    pub fn msg(id: &str, mine: bool, text: &str, ts: f64) -> Value {
        json!({"id": id, "mine": mine, "text": text, "ts": ts, "state": if mine {"sent"} else {"received"}})
    }

    pub fn app(seeds: Vec<ChatSeed>) -> App {
        let cfg = Config::default();
        let theme = Theme::new(ColorMode::True, &cfg.theme);
        let (keys, _) = KeyMap::new(&KeybindConfig::default());
        let mut a = App::new(ME, seeds, cfg, theme, keys);
        a.tz = jiff::tz::TimeZone::UTC;
        a.now = 1_700_000_000_000.0;
        a.conn = Conn::Online;
        a
    }

    pub fn seed(addr: &str, name: &str, messages: Vec<Value>) -> ChatSeed {
        ChatSeed { address: addr.into(), name: name.into(), messages, last_read: 0.0, draft: String::new() }
    }

    pub fn key(c: KeyCode) -> KeyEvent {
        KeyEvent::new(c, KeyModifiers::NONE)
    }
    pub fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }
    pub fn typed(a: &mut App, s: &str) {
        for c in s.chars() {
            a.handle_key(key(KeyCode::Char(c)));
        }
    }

    fn two() -> App {
        let mut a = app(vec![
            seed(ANNA, "Anna", vec![msg("a1", false, "hi there", 1000.0), msg("a2", true, "hello", 2000.0)]),
            seed(BORIS, "Boris", vec![msg("b1", false, "ping", 5000.0)]),
        ]);
        a.focus = Focus::Composer;
        a
    }

    #[test]
    fn chats_sort_by_latest_and_count_unread() {
        let a = two();
        assert_eq!(a.chats[0].name, "Boris");
        assert_eq!(a.chats[0].unread, 1);
        assert_eq!(a.chats[1].unread, 1);
    }

    #[test]
    fn mark_read_emits_seen_once() {
        let mut a = two();
        let out = a.mark_read();
        assert!(out.contains(&Intent::Seen { peer: BORIS.into(), ids: vec!["b1".into()] }));
        assert_eq!(a.chats[0].unread, 0);
        assert!(a.mark_read().is_empty());
    }

    #[test]
    fn no_read_marking_when_unfocused_or_scrolled_back() {
        let mut a = two();
        a.focused = false;
        assert!(a.mark_read().is_empty());
        a.focused = true;
        a.offset = 5;
        assert!(a.mark_read().is_empty());
        assert_eq!(a.chats[0].unread, 1);
    }

    #[test]
    fn next_unread_jumps_and_wraps() {
        let mut a = two();
        a.mark_read();
        a.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT));
        assert_eq!(a.chat().unwrap().name, "Anna");
        a.mark_read();
        a.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT));
        assert!(a.notice.is_some());
    }

    #[test]
    fn enter_sends_and_alt_enter_adds_a_line() {
        let mut a = two();
        typed(&mut a, "one");
        a.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT));
        typed(&mut a, "two");
        let out = a.handle_key(key(KeyCode::Enter));
        assert_eq!(out, vec![Intent::Send { peer: BORIS.into(), text: "one\ntwo".into(), reply: None }]);
        assert!(a.chat().unwrap().composer.is_empty());
    }

    #[test]
    fn drafts_are_per_chat() {
        let mut a = two();
        typed(&mut a, "draft for boris");
        a.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT));
        assert!(a.chat().unwrap().composer.is_empty());
        typed(&mut a, "anna draft");
        a.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
        assert_eq!(a.composer_text(), "draft for boris");
        let state = a.export_state();
        assert_eq!(state["drafts"][ANNA], "anna draft");
    }

    #[test]
    fn reply_attaches_the_quoted_message() {
        let mut a = two();
        a.handle_key(key(KeyCode::Esc)); // composer -> history, last message selected
        assert_eq!(a.focus, Focus::History);
        a.handle_key(key(KeyCode::Char('r')));
        assert_eq!(a.focus, Focus::Composer);
        typed(&mut a, "answer");
        let out = a.handle_key(key(KeyCode::Enter));
        let Intent::Send { reply: Some(r), .. } = &out[0] else { panic!("{out:?}") };
        assert_eq!((r.id.as_str(), r.from.as_str(), r.text.as_str()), ("b1", BORIS, "ping"));
    }

    #[test]
    fn up_in_empty_composer_edits_last_own_message_and_enter_sends_edit() {
        let mut a = two();
        a.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT)); // Anna
        a.handle_key(key(KeyCode::Up));
        assert_eq!(a.composer_text(), "hello");
        typed(&mut a, "!");
        let out = a.handle_key(key(KeyCode::Enter));
        assert_eq!(out, vec![Intent::Edit { peer: ANNA.into(), id: "a2".into(), text: "hello!".into() }]);
        assert!(a.chat().unwrap().composer.is_empty());
    }

    #[test]
    fn up_with_text_moves_the_cursor_instead() {
        let mut a = two();
        typed(&mut a, "abc");
        a.handle_key(key(KeyCode::Up));
        assert_eq!(a.composer_text(), "abc");
        assert!(a.chat().unwrap().editing.is_none());
    }

    #[test]
    fn escape_cancels_edit_and_restores_the_draft() {
        let mut a = two();
        a.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT));
        typed(&mut a, "half");
        a.handle_key(key(KeyCode::Esc)); // composer -> history
        assert_eq!(a.focus, Focus::History);
        a.handle_key(key(KeyCode::Char('e')));
        assert_eq!(a.composer_text(), "hello");
        a.handle_key(key(KeyCode::Esc));
        assert_eq!(a.composer_text(), "half");
    }

    #[test]
    fn delete_asks_for_confirmation() {
        let mut a = two();
        a.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT)); // Anna
        a.handle_key(key(KeyCode::Esc));
        a.handle_key(key(KeyCode::Char('d')));
        assert!(matches!(a.popup, Popup::ConfirmDelete { .. }));
        assert_eq!(a.handle_key(key(KeyCode::Char('n'))), vec![]);
        a.handle_key(key(KeyCode::Char('d')));
        let out = a.handle_key(key(KeyCode::Char('y')));
        assert_eq!(out, vec![Intent::Delete { peer: ANNA.into(), id: "a2".into() }]);
    }

    #[test]
    fn cannot_delete_or_edit_what_is_not_ours() {
        let mut a = two();
        a.handle_key(key(KeyCode::Esc));
        a.handle_key(key(KeyCode::Char('d')));
        assert!(matches!(a.popup, Popup::None));
        a.handle_key(key(KeyCode::Char('e')));
        assert!(a.chat().unwrap().editing.is_none());
    }

    #[test]
    fn quit_confirms_only_with_a_draft() {
        let mut a = two();
        assert!(a.handle_key(ctrl('c')).contains(&Intent::Quit));
        let mut b = two();
        typed(&mut b, "unsent");
        assert!(b.handle_key(ctrl('c')).is_empty());
        assert_eq!(b.popup, Popup::ConfirmQuit);
        assert!(b.handle_key(key(KeyCode::Char('y'))).contains(&Intent::Quit));
    }

    #[test]
    fn q_types_in_the_composer_but_quits_elsewhere() {
        let mut a = two();
        typed(&mut a, "q");
        assert_eq!(a.composer_text(), "q");
        a.handle_key(key(KeyCode::Tab));
        assert_eq!(a.focus, Focus::List);
        a.chats[0].composer.take();
        assert!(!a.handle_key(key(KeyCode::Char('q'))).is_empty() || a.popup == Popup::ConfirmQuit);
    }

    #[test]
    fn switcher_filters_and_opens() {
        let mut a = two();
        a.handle_key(ctrl('k'));
        typed(&mut a, "ann");
        let out = a.handle_key(key(KeyCode::Enter));
        assert!(out.is_empty());
        assert_eq!(a.chat().unwrap().name, "Anna");
        assert_eq!(a.focus, Focus::Composer);
    }

    #[test]
    fn new_chat_validates_the_address() {
        let mut a = two();
        a.handle_key(ctrl('n'));
        typed(&mut a, "not-an-address");
        a.handle_key(key(KeyCode::Enter));
        assert!(matches!(&a.popup, Popup::NewChat { error: Some(_), .. }));
    }

    #[test]
    fn deleted_messages_leave_a_marker_and_edits_update_text() {
        let mut a = two();
        a.set_messages(ANNA, &[msg("a1", false, "hi there", 1000.0)]);
        let anna = a.chats.iter().find(|c| c.address == ANNA).unwrap();
        assert!(anna.rows.iter().any(|r| matches!(r, Row::Gone { mine: true, .. })));
        let mut edited = msg("a1", false, "hi again", 1000.0);
        edited["edited"] = json!(3000);
        a.set_messages(ANNA, &[edited]);
        let anna = a.chats.iter().find(|c| c.address == ANNA).unwrap();
        assert!(matches!(&anna.rows[0], Row::Msg(m) if m.edited && m.text == "hi again"));
    }

    #[test]
    fn long_messages_are_refused() {
        let mut a = two();
        a.chats[0].composer.set(&"x".repeat(4001));
        assert!(a.handle_key(key(KeyCode::Enter)).is_empty());
        assert!(a.notice.is_some());
    }

    #[test]
    fn history_navigation_and_pages() {
        let mut a = two();
        a.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT));
        a.handle_key(key(KeyCode::Esc));
        a.handle_key(key(KeyCode::Char('g')));
        assert_eq!(a.chat().unwrap().sel, Some(0));
        a.handle_key(key(KeyCode::Char('G')));
        assert_eq!(a.chat().unwrap().sel, Some(1));
        a.view_h = 12;
        a.handle_key(key(KeyCode::PageUp));
        assert_eq!(a.offset, 10);
        a.handle_key(key(KeyCode::PageDown));
        assert_eq!(a.offset, 0);
    }

    #[test]
    fn config_keybinding_override_applies() {
        let mut cfg = KeybindConfig::default();
        cfg.history.insert("x".into(), "reply".into());
        let (keys, _) = KeyMap::new(&cfg);
        let mut a = two();
        a.keys = keys;
        a.handle_key(key(KeyCode::Esc));
        a.handle_key(key(KeyCode::Char('x')));
        assert!(a.chat().unwrap().reply_to.is_some());
    }

    #[test]
    fn terminal_escapes_in_messages_are_removed() {
        let m = Msg::from_value(&msg("x", false, "a\u{1b}[31mred", 1.0), ME).unwrap();
        assert_eq!(m.text, "a[31mred");
    }

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE }
    }

    #[test]
    fn mouse_wheel_scrolls_and_click_selects_a_chat() {
        let mut a = two();
        a.hit.list = Rect::new(0, 1, 28, 20);
        a.hit.list_rows = vec![0, 1];
        a.hit.hist = Rect::new(28, 1, 70, 15);
        a.handle_mouse(mouse(MouseEventKind::ScrollUp, 40, 5));
        assert_eq!(a.offset, 3);
        a.handle_mouse(mouse(MouseEventKind::ScrollDown, 40, 5));
        assert_eq!(a.offset, 0);
        a.handle_mouse(mouse(MouseEventKind::Down(MouseButton::Left), 3, 3));
        assert_eq!(a.chat().unwrap().name, "Anna");
        a.cfg.mouse = false;
        a.handle_mouse(mouse(MouseEventKind::Down(MouseButton::Left), 3, 1));
        assert_eq!(a.chat().unwrap().name, "Anna");
    }

    #[test]
    fn open_chat_is_not_noisy_only_while_watched() {
        let mut a = two();
        let open = a.chat().unwrap().address.clone();
        assert!(a.is_watching(&open));
        assert!(!a.is_watching(ANNA));
        a.focused = false;
        assert!(!a.is_watching(&open));
        a.focused = true;
        a.offset = 4;
        assert!(!a.is_watching(&open));
        a.offset = 0;
        a.focus = Focus::List;
        assert!(!a.is_watching(&open));
    }

    #[test]
    fn paste_goes_to_the_composer_with_newlines() {
        let mut a = two();
        a.handle_paste("line one\nline two");
        assert_eq!(a.composer_text(), "line one\nline two");
    }

    #[test]
    fn narrow_terminals_collapse_to_one_pane() {
        let mut a = two();
        a.size = (60, 24);
        assert!(a.narrow());
        a.size = (100, 24);
        assert!(!a.narrow());
    }

    fn composer_line(a: &mut App, line: &str) -> Vec<Intent> {
        a.set_composer(line);
        a.handle_key(key(KeyCode::Enter))
    }

    #[test]
    fn composer_colon_commands_run_and_are_never_sent() {
        for cmd in [
            ":link",
            ":devices",
            ":qr",
            ":address",
            ":help",
            ":h",
            ":search hello",
            ":gsearch hello",
            ":mute",
            ":unmute",
            ":block",
            ":unblock",
            ":verify",
            ":unverify",
            ":safety",
            ":delete chat",
            ":delete contact",
            ":bell off",
            ":attach /tmp/x.png | cap",
            ":add",
            ":quit",
            ":q",
        ] {
            let mut a = two();
            let out = composer_line(&mut a, cmd);
            assert!(!out.iter().any(|i| matches!(i, Intent::Send { .. })), "{cmd} was sent: {out:?}");
            assert!(a.chat().unwrap().composer.is_empty(), "{cmd} left in the composer");
            assert!(!a.notice.as_ref().is_some_and(|n| n.0.starts_with("Unknown")), "{cmd} not recognised");
        }
        let mut a = two();
        assert_eq!(composer_line(&mut a, ":link"), vec![Intent::AddDevice]);
        let mut a = two();
        assert_eq!(composer_line(&mut a, ":qr"), vec![Intent::ShowQr(QrKind::Address)]);
        let mut a = two();
        composer_line(&mut a, ":safety");
        assert!(matches!(a.popup, Popup::Safety { .. }));
    }

    #[test]
    fn composer_unknown_colon_command_is_kept_and_not_sent() {
        let mut a = two();
        let out = composer_line(&mut a, ":linkk");
        assert!(out.is_empty());
        assert_eq!(a.composer_text(), ":linkk");
        assert!(a.notice.as_ref().unwrap().0.contains("::text"));
    }

    #[test]
    fn composer_double_colon_sends_a_literal_colon() {
        let mut a = two();
        let out = composer_line(&mut a, "::link");
        assert_eq!(out, vec![Intent::Send { peer: BORIS.into(), text: ":link".into(), reply: None }]);
        let mut b = two();
        let out = composer_line(&mut b, "::: x");
        assert!(matches!(&out[0], Intent::Send { text, .. } if text == ":: x"));
    }

    #[test]
    fn colon_text_inside_a_message_is_still_sent() {
        let mut a = two();
        let out = composer_line(&mut a, "note: link");
        assert!(matches!(&out[0], Intent::Send { .. }));
        let mut b = two();
        let out = composer_line(&mut b, ":link\nmore");
        assert!(matches!(&out[0], Intent::Send { .. }));
    }
}
