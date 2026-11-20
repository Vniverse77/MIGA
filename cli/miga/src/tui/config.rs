//! `~/.config/miga/config.toml`: read-only. A missing file means built-in defaults; the app never writes it.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub mouse: bool,
    pub ascii_borders: bool,
    pub sidebar_width: u16,
    pub sidebar_collapse_below: u16,
    /// `"default"` means `$VISUAL`, then `$EDITOR`.
    pub editor: String,
    /// Program used to open links; empty means "show the link instead".
    pub open_command: String,
    pub confirm_delete: bool,
    /// Send read receipts (`seen`) for chats you look at.
    pub show_receipts: bool,
    /// Send what you type to the open chat as it is typed (ephemeral; off by default).
    pub live_text: bool,
    pub theme: ThemeConfig,
    pub notifications: NotifyConfig,
    pub keybinds: KeybindConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ThemeConfig {
    /// `miga-dark`, `transparent` or `mono`.
    pub name: String,
    /// `auto`, `truecolor`, `256`, `16` or `none`.
    pub color: String,
    pub bg: Option<String>,
    pub card: Option<String>,
    pub primary: Option<String>,
    pub secondary: Option<String>,
    pub muted: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct NotifyConfig {
    pub bell: bool,
    pub desktop: bool,
    /// Program and arguments; `{title}` and `{body}` are replaced per argument (no shell involved).
    pub notify_cmd: String,
    /// Put the sender and text into the desktop notification. Off by default for privacy.
    pub show_text: bool,
    /// Notify even for the open chat while the terminal has focus.
    pub when_focused: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct KeybindConfig {
    pub default_keybindings: bool,
    pub global: BTreeMap<String, String>,
    pub list: BTreeMap<String, String>,
    pub history: BTreeMap<String, String>,
    pub composer: BTreeMap<String, String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mouse: true,
            ascii_borders: false,
            sidebar_width: 28,
            sidebar_collapse_below: 80,
            editor: "default".into(),
            open_command: "xdg-open".into(),
            confirm_delete: true,
            show_receipts: true,
            live_text: false,
            theme: ThemeConfig::default(),
            notifications: NotifyConfig::default(),
            keybinds: KeybindConfig::default(),
        }
    }
}

impl Default for ThemeConfig {
    fn default() -> Self {
        ThemeConfig {
            name: "miga-dark".into(),
            color: "auto".into(),
            bg: None,
            card: None,
            primary: None,
            secondary: None,
            muted: None,
            text: None,
        }
    }
}

impl Default for NotifyConfig {
    fn default() -> Self {
        NotifyConfig {
            bell: true,
            desktop: false,
            notify_cmd: "notify-send {title} {body}".into(),
            show_text: false,
            when_focused: false,
        }
    }
}

impl Default for KeybindConfig {
    fn default() -> Self {
        KeybindConfig {
            default_keybindings: true,
            global: BTreeMap::new(),
            list: BTreeMap::new(),
            history: BTreeMap::new(),
            composer: BTreeMap::new(),
        }
    }
}

/// `$XDG_CONFIG_HOME/miga/config.toml` (or `~/.config/miga/config.toml`).
pub fn default_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("miga").join("config.toml"))
}

/// Loads the config. A missing file is fine; a broken one is reported and defaults are used.
pub fn load(path: Option<&Path>) -> (Config, Option<String>) {
    let explicit = path.is_some();
    let Some(path) = path.map(Path::to_path_buf).or_else(default_path) else { return (Config::default(), None) };
    match std::fs::read_to_string(&path) {
        Ok(text) => match toml::from_str::<Config>(&text) {
            Ok(c) => (c, None),
            Err(e) => (Config::default(), Some(format!("config {}: {}", path.display(), first_line(&e.to_string())))),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !explicit => (Config::default(), None),
        Err(e) => (Config::default(), Some(format!("config {}: {e}", path.display()))),
    }
}

fn first_line(s: &str) -> String {
    s.lines().find(|l| !l.trim().is_empty() && !l.contains('|')).unwrap_or(s).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_file_is_defaults() {
        let c: Config = toml::from_str("").unwrap();
        assert!(c.mouse && c.notifications.bell && !c.notifications.desktop);
        assert_eq!(c.sidebar_width, 28);
    }

    #[test]
    fn overrides_and_unknown_keys() {
        let c: Config = toml::from_str(
            "mouse = false\nfuture_key = 1\n[theme]\nprimary = \"#ff0000\"\n[keybinds.history]\n\"x\" = \"reply\"\n\"r\" = \"\"\n",
        )
        .unwrap();
        assert!(!c.mouse);
        assert_eq!(c.theme.primary.as_deref(), Some("#ff0000"));
        assert_eq!(c.keybinds.history["r"], "");
    }
}
