//! Key combinations, actions and the default key map with config overrides.
use super::config::KeybindConfig;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    Global,
    List,
    History,
    Composer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Quit,
    Help,
    Address,
    Switcher,
    NewChat,
    NextUnread,
    PrevChat,
    NextChat,
    FocusNext,
    FocusPrev,
    Back,
    Command,
    Up,
    Down,
    Top,
    Bottom,
    PageUp,
    PageDown,
    OpenChat,
    Reply,
    Edit,
    Delete,
    Copy,
    OpenLink,
    Compose,
    Send,
    Newline,
    EditLast,
    OpenEditor,
    Cancel,
}

/// (action, config name, description for the help popup)
pub const ACTIONS: &[(Action, &str, &str)] = &[
    (Action::Switcher, "switcher", "Quick switcher (fuzzy search chats)"),
    (Action::NewChat, "new_chat", "New chat (add by address)"),
    (Action::NextUnread, "next_unread", "Jump to the next unread chat"),
    (Action::PrevChat, "prev_chat", "Previous chat"),
    (Action::NextChat, "next_chat", "Next chat"),
    (Action::FocusNext, "focus_next", "Next pane (list, messages, composer)"),
    (Action::FocusPrev, "focus_prev", "Previous pane"),
    (Action::Back, "back", "Back to the chat list"),
    (Action::Address, "address", "Show your address"),
    (Action::Help, "help", "This help"),
    (Action::Command, "command", "Command line"),
    (Action::Quit, "quit", "Quit"),
    (Action::Up, "up", "Move up"),
    (Action::Down, "down", "Move down"),
    (Action::Top, "top", "Go to the top"),
    (Action::Bottom, "bottom", "Go to the bottom"),
    (Action::PageUp, "page_up", "Scroll up one page"),
    (Action::PageDown, "page_down", "Scroll down one page"),
    (Action::OpenChat, "open_chat", "Open the chat"),
    (Action::Reply, "reply", "Reply to the selected message"),
    (Action::Edit, "edit", "Edit your selected message"),
    (Action::Delete, "delete", "Delete your message for everyone"),
    (Action::Copy, "copy", "Copy the message text (OSC 52)"),
    (Action::OpenLink, "open_link", "Open the first link in the message"),
    (Action::Compose, "compose", "Write a message"),
    (Action::Send, "send", "Send"),
    (Action::Newline, "newline", "New line in the message"),
    (Action::EditLast, "edit_last", "Edit your last message (empty composer)"),
    (Action::OpenEditor, "open_editor", "Write in $EDITOR"),
    (Action::Cancel, "cancel", "Cancel / close / leave the composer"),
];

pub fn action_from_name(name: &str) -> Option<Action> {
    ACTIONS.iter().find(|(_, n, _)| *n == name).map(|(a, _, _)| *a)
}

pub fn describe(action: Action) -> &'static str {
    ACTIONS.iter().find(|(a, _, _)| *a == action).map_or("", |(_, _, d)| d)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Combo {
    pub code: KeyCode,
    pub mods: KeyModifiers,
}

impl Combo {
    /// Normalises an event: Shift is implied by an upper-case letter and by BackTab.
    pub fn from_event(e: &KeyEvent) -> Combo {
        let mut mods = e.modifiers & (KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SHIFT);
        let code = match e.code {
            KeyCode::Char(c) => {
                mods.remove(KeyModifiers::SHIFT);
                if mods.contains(KeyModifiers::CONTROL) {
                    KeyCode::Char(c.to_ascii_lowercase())
                } else {
                    KeyCode::Char(c)
                }
            }
            KeyCode::BackTab => {
                mods.remove(KeyModifiers::SHIFT);
                KeyCode::BackTab
            }
            c => c,
        };
        Combo { code, mods }
    }

    /// Parses `ctrl+k`, `alt+enter`, `G`, `shift+tab`, `pgup`, `f1`.
    pub fn parse(spec: &str) -> Option<Combo> {
        let spec = spec.trim();
        if spec.is_empty() {
            return None;
        }
        let (mods_part, key) = match spec.rfind('+') {
            Some(i) if i + 1 < spec.len() => (&spec[..i], &spec[i + 1..]),
            _ => ("", spec),
        };
        let mut mods = KeyModifiers::empty();
        for m in mods_part.split('+').filter(|m| !m.is_empty()) {
            match m.to_lowercase().as_str() {
                "ctrl" | "control" => mods |= KeyModifiers::CONTROL,
                "alt" | "meta" => mods |= KeyModifiers::ALT,
                "shift" => mods |= KeyModifiers::SHIFT,
                _ => return None,
            }
        }
        let lower = key.to_lowercase();
        let code = match lower.as_str() {
            "enter" | "return" => KeyCode::Enter,
            "esc" | "escape" => KeyCode::Esc,
            "tab" if mods.contains(KeyModifiers::SHIFT) => {
                mods.remove(KeyModifiers::SHIFT);
                KeyCode::BackTab
            }
            "tab" => KeyCode::Tab,
            "backtab" => KeyCode::BackTab,
            "space" => KeyCode::Char(' '),
            "backspace" => KeyCode::Backspace,
            "delete" | "del" => KeyCode::Delete,
            "up" => KeyCode::Up,
            "down" => KeyCode::Down,
            "left" => KeyCode::Left,
            "right" => KeyCode::Right,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "pgup" | "pageup" => KeyCode::PageUp,
            "pgdn" | "pagedown" => KeyCode::PageDown,
            f if f.len() > 1 && f.starts_with('f') && f[1..].parse::<u8>().is_ok() => KeyCode::F(f[1..].parse().ok()?),
            _ => {
                let mut chars = key.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                if mods.contains(KeyModifiers::SHIFT) {
                    mods.remove(KeyModifiers::SHIFT);
                    KeyCode::Char(c.to_ascii_uppercase())
                } else if mods.is_empty() {
                    KeyCode::Char(c)
                } else {
                    KeyCode::Char(c.to_ascii_lowercase())
                }
            }
        };
        Some(Combo { code, mods })
    }

    pub fn label(&self) -> String {
        let mut s = String::new();
        if self.mods.contains(KeyModifiers::CONTROL) {
            s.push_str("Ctrl+");
        }
        if self.mods.contains(KeyModifiers::ALT) {
            s.push_str("Alt+");
        }
        if self.mods.contains(KeyModifiers::SHIFT) {
            s.push_str("Shift+");
        }
        let key = match self.code {
            KeyCode::Char(' ') => "Space".to_string(),
            KeyCode::Char(c) if self.mods.contains(KeyModifiers::CONTROL) || self.mods.contains(KeyModifiers::ALT) => {
                c.to_ascii_uppercase().to_string()
            }
            KeyCode::Char(c) => c.to_string(),
            KeyCode::Enter => "Enter".into(),
            KeyCode::Esc => "Esc".into(),
            KeyCode::Tab => "Tab".into(),
            KeyCode::BackTab => "Shift+Tab".into(),
            KeyCode::Backspace => "Backspace".into(),
            KeyCode::Delete => "Del".into(),
            KeyCode::Up => "\u{2191}".into(),
            KeyCode::Down => "\u{2193}".into(),
            KeyCode::Left => "\u{2190}".into(),
            KeyCode::Right => "\u{2192}".into(),
            KeyCode::Home => "Home".into(),
            KeyCode::End => "End".into(),
            KeyCode::PageUp => "PgUp".into(),
            KeyCode::PageDown => "PgDn".into(),
            KeyCode::F(n) => format!("F{n}"),
            _ => "?".into(),
        };
        s + &key
    }
}

#[derive(Debug, Clone, Default)]
pub struct KeyMap {
    /// `None` is an explicit unbinding (it also hides the global binding in that mode).
    map: HashMap<(Mode, Combo), Option<Action>>,
    /// Defaults in definition order, for the help popup.
    order: Vec<(Mode, Combo, Action)>,
}

const DEFAULTS: &[(Mode, &str, Action)] = &[
    (Mode::Global, "ctrl+k", Action::Switcher),
    (Mode::Global, "ctrl+p", Action::Switcher),
    (Mode::Global, "ctrl+n", Action::NewChat),
    (Mode::Global, "alt+a", Action::NextUnread),
    (Mode::Global, "alt+up", Action::PrevChat),
    (Mode::Global, "alt+down", Action::NextChat),
    (Mode::Global, "tab", Action::FocusNext),
    (Mode::Global, "shift+tab", Action::FocusPrev),
    (Mode::Global, "ctrl+b", Action::Back),
    (Mode::Global, "f1", Action::Help),
    (Mode::Global, "f2", Action::Address),
    (Mode::Global, "ctrl+c", Action::Quit),
    (Mode::Global, "ctrl+q", Action::Quit),
    (Mode::List, "j", Action::Down),
    (Mode::List, "down", Action::Down),
    (Mode::List, "k", Action::Up),
    (Mode::List, "up", Action::Up),
    (Mode::List, "g", Action::Top),
    (Mode::List, "G", Action::Bottom),
    (Mode::List, "enter", Action::OpenChat),
    (Mode::List, "l", Action::OpenChat),
    (Mode::List, "?", Action::Help),
    (Mode::List, "q", Action::Quit),
    (Mode::List, ":", Action::Command),
    (Mode::History, "j", Action::Down),
    (Mode::History, "down", Action::Down),
    (Mode::History, "k", Action::Up),
    (Mode::History, "up", Action::Up),
    (Mode::History, "g", Action::Top),
    (Mode::History, "G", Action::Bottom),
    (Mode::History, "pgup", Action::PageUp),
    (Mode::History, "pgdn", Action::PageDown),
    (Mode::History, "ctrl+u", Action::PageUp),
    (Mode::History, "ctrl+d", Action::PageDown),
    (Mode::History, "r", Action::Reply),
    (Mode::History, "e", Action::Edit),
    (Mode::History, "d", Action::Delete),
    (Mode::History, "y", Action::Copy),
    (Mode::History, "o", Action::OpenLink),
    (Mode::History, "enter", Action::Compose),
    (Mode::History, "i", Action::Compose),
    (Mode::History, "esc", Action::Compose),
    (Mode::History, "?", Action::Help),
    (Mode::History, "q", Action::Quit),
    (Mode::History, ":", Action::Command),
    (Mode::Composer, "enter", Action::Send),
    (Mode::Composer, "alt+enter", Action::Newline),
    (Mode::Composer, "shift+enter", Action::Newline),
    (Mode::Composer, "ctrl+j", Action::Newline),
    (Mode::Composer, "up", Action::EditLast),
    (Mode::Composer, "ctrl+e", Action::OpenEditor),
    (Mode::Composer, "esc", Action::Cancel),
    (Mode::Composer, "pgup", Action::PageUp),
    (Mode::Composer, "pgdn", Action::PageDown),
];

impl KeyMap {
    /// Builds the map; the second value lists config problems (unknown action or key).
    pub fn new(cfg: &KeybindConfig) -> (KeyMap, Vec<String>) {
        let mut km = KeyMap::default();
        let mut problems = Vec::new();
        if cfg.default_keybindings {
            for (mode, spec, action) in DEFAULTS {
                if let Some(c) = Combo::parse(spec) {
                    km.map.insert((*mode, c), Some(*action));
                    km.order.push((*mode, c, *action));
                }
            }
        }
        let tables = [
            (Mode::Global, &cfg.global),
            (Mode::List, &cfg.list),
            (Mode::History, &cfg.history),
            (Mode::Composer, &cfg.composer),
        ];
        for (mode, table) in tables {
            for (spec, name) in table {
                let Some(combo) = Combo::parse(spec) else {
                    problems.push(format!("keybinds: unknown key `{spec}`"));
                    continue;
                };
                if name.is_empty() {
                    km.map.insert((mode, combo), None);
                } else if let Some(a) = action_from_name(name) {
                    km.map.insert((mode, combo), Some(a));
                    km.order.push((mode, combo, a));
                } else {
                    problems.push(format!("keybinds: unknown action `{name}`"));
                }
            }
        }
        (km, problems)
    }

    pub fn lookup(&self, mode: Mode, key: &KeyEvent) -> Option<Action> {
        let combo = Combo::from_event(key);
        match self.map.get(&(mode, combo)) {
            Some(found) => *found,
            None => self.map.get(&(Mode::Global, combo)).copied().flatten(),
        }
    }

    /// Keys currently bound to `action` (first in a mode, then global), for help and the footer.
    pub fn keys_for(&self, action: Action) -> Vec<Combo> {
        let mut v: Vec<Combo> = Vec::new();
        for (mode, combo, a) in &self.order {
            if *a == action && self.map.get(&(*mode, *combo)) == Some(&Some(action)) && !v.contains(combo) {
                v.push(*combo);
            }
        }
        v
    }

    /// `Ctrl+K` style label of the first key for an action, or `?`.
    pub fn label(&self, action: Action) -> String {
        self.keys_for(action).first().map_or_else(|| "-".into(), Combo::label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventKind;

    fn ev(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        let mut e = KeyEvent::new(code, mods);
        e.kind = KeyEventKind::Press;
        e
    }

    #[test]
    fn parse_variants() {
        assert_eq!(Combo::parse("ctrl+k"), Some(Combo { code: KeyCode::Char('k'), mods: KeyModifiers::CONTROL }));
        assert_eq!(Combo::parse("G"), Some(Combo { code: KeyCode::Char('G'), mods: KeyModifiers::empty() }));
        assert_eq!(Combo::parse("shift+tab").unwrap().code, KeyCode::BackTab);
        assert_eq!(Combo::parse("alt+enter").unwrap().mods, KeyModifiers::ALT);
        assert!(Combo::parse("hyper+x").is_none());
    }

    #[test]
    fn shifted_letter_matches_upper_case_binding() {
        let (km, _) = KeyMap::new(&KeybindConfig::default());
        let e = ev(KeyCode::Char('G'), KeyModifiers::SHIFT);
        assert_eq!(km.lookup(Mode::History, &e), Some(Action::Bottom));
    }

    #[test]
    fn mode_binding_beats_global_and_global_applies() {
        let (km, _) = KeyMap::new(&KeybindConfig::default());
        assert_eq!(km.lookup(Mode::Composer, &ev(KeyCode::Char('k'), KeyModifiers::CONTROL)), Some(Action::Switcher));
        assert_eq!(km.lookup(Mode::Composer, &ev(KeyCode::Char('q'), KeyModifiers::NONE)), None);
        assert_eq!(km.lookup(Mode::History, &ev(KeyCode::Char('q'), KeyModifiers::NONE)), Some(Action::Quit));
    }

    #[test]
    fn overrides_rebind_and_unbind() {
        let mut cfg = KeybindConfig::default();
        cfg.history.insert("x".into(), "reply".into());
        cfg.history.insert("r".into(), String::new());
        cfg.history.insert("z".into(), "nonsense".into());
        let (km, problems) = KeyMap::new(&cfg);
        assert_eq!(km.lookup(Mode::History, &ev(KeyCode::Char('x'), KeyModifiers::NONE)), Some(Action::Reply));
        assert_eq!(km.lookup(Mode::History, &ev(KeyCode::Char('r'), KeyModifiers::NONE)), None);
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn labels() {
        assert_eq!(Combo::parse("ctrl+k").unwrap().label(), "Ctrl+K");
        assert_eq!(Combo::parse("alt+enter").unwrap().label(), "Alt+Enter");
    }
}
