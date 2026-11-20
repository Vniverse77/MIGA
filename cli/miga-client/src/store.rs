//! A simple file store: one JSON file per concern, written atomically, identity file `0600`.
//!
//! Layout: `<config>/identity.json` (seed, optional display name) and `<data>/contacts.json`,
//! `<data>/chats/<address>.json`. `MIGA_HOME` puts everything under one directory (used for
//! throwaway profiles); otherwise XDG: `$XDG_CONFIG_HOME/miga` and `$XDG_DATA_HOME/miga`.
use crate::{Error, Result};
use miga_core::identity::Identity;
use miga_core::payload::MAX_TEXT;
use miga_core::sync::merge_messages;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Store {
    config: PathBuf,
    data: PathBuf,
}

/// A saved contact.
#[derive(Debug, Clone, PartialEq)]
pub struct Contact {
    pub address: String,
    pub name: String,
    /// The user typed this name (a shared name never replaces it).
    pub custom: bool,
    /// The safety number the user marked as verified.
    pub verified: Option<String>,
}

fn xdg(var: &str, fallback: &str) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os(var).filter(|p| !p.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute()) {
        return Ok(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| Error::Invalid("HOME is not set".into()))?;
    Ok(home.join(fallback))
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `bytes` to `path` through a temp file and a rename, fsynced. `mode` applies on Unix.
fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    Ok(())
}

fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map(Some).map_err(|e| Error::Invalid(format!("{}: {e}", path.display())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

impl Store {
    /// The default location (see module docs). `profile` selects a separate account.
    pub fn open(profile: Option<&str>) -> Result<Store> {
        if let Some(home) = std::env::var_os("MIGA_HOME").filter(|h| !h.is_empty()) {
            let root = PathBuf::from(home);
            return Ok(Store { config: root.join("config"), data: root.join("data") });
        }
        let mut config = xdg("XDG_CONFIG_HOME", ".config")?.join("miga");
        let mut data = xdg("XDG_DATA_HOME", ".local/share")?.join("miga");
        if let Some(p) = profile.filter(|p| !p.is_empty()) {
            if !p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                return Err(Error::Invalid("profile names may contain letters, digits, - and _".into()));
            }
            config = config.join("profiles").join(p);
            data = data.join("profiles").join(p);
        }
        Ok(Store { config, data })
    }

    pub fn in_dirs(config: PathBuf, data: PathBuf) -> Store {
        Store { config, data }
    }

    fn identity_path(&self) -> PathBuf {
        self.config.join("identity.json")
    }

    /// Creates the identity. Refuses to overwrite an existing one.
    pub fn create_identity(&self, name: Option<&str>) -> Result<Identity> {
        if self.identity_path().exists() {
            return Err(Error::Invalid("an identity already exists here; refusing to overwrite it".into()));
        }
        private_dir(&self.config)?;
        let id = Identity::generate()?;
        let mut v = json!({"seed": id.seed_hex()});
        if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
            v["name"] = n.into();
        }
        write_atomic(&self.identity_path(), serde_json::to_string_pretty(&v).expect("json").as_bytes(), 0o600)?;
        Ok(id)
    }

    pub fn identity(&self) -> Result<Identity> {
        let v = read_json(&self.identity_path())?
            .ok_or_else(|| Error::Invalid("no identity yet; run `miga init`".into()))?;
        let seed = v.get("seed").and_then(Value::as_str).unwrap_or_default();
        Ok(Identity::from_seed_hex(seed)?)
    }

    /// The display name shared with contacts, if any.
    pub fn profile_name(&self) -> Result<Option<String>> {
        Ok(read_json(&self.identity_path())?
            .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
            .filter(|n| !n.is_empty()))
    }

    // ---- contacts -------------------------------------------------------------------------

    pub fn contacts(&self) -> Result<Vec<Contact>> {
        let list = read_json(&self.data.join("contacts.json"))?.unwrap_or(Value::Null);
        Ok(list
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        Some(Contact {
                            address: c.get("address")?.as_str()?.into(),
                            name: c.get("name")?.as_str()?.into(),
                            custom: c.get("custom").and_then(Value::as_bool).unwrap_or(false),
                            verified: c.get("verified").and_then(Value::as_str).map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn save_contacts(&self, list: &[Contact]) -> Result<()> {
        private_dir(&self.data)?;
        let v: Vec<Value> = list
            .iter()
            .map(|c| {
                let mut v = json!({"address": c.address, "name": c.name});
                if c.custom {
                    v["custom"] = true.into();
                }
                if let Some(n) = &c.verified {
                    v["verified"] = n.clone().into();
                }
                v
            })
            .collect();
        write_atomic(
            &self.data.join("contacts.json"),
            serde_json::to_string_pretty(&v).expect("json").as_bytes(),
            0o600,
        )
    }

    /// Adds a contact or renames an existing one. Returns true if it was new.
    pub fn upsert_contact(&self, address: &str, name: &str) -> Result<bool> {
        let mut list = self.contacts()?;
        let new = match list.iter_mut().find(|c| c.address == address) {
            Some(c) => {
                c.name = name.to_string();
                false
            }
            None => {
                list.push(Contact { address: address.into(), name: name.into(), custom: false, verified: None });
                true
            }
        };
        self.save_contacts(&list)?;
        Ok(new)
    }

    /// Finds a contact by exact name (any case), full address or unique address prefix.
    pub fn find_contact(&self, query: &str) -> Result<Option<Contact>> {
        let list = self.contacts()?;
        let q = query.trim().to_lowercase();
        if let Some(c) = list.iter().find(|c| c.address == q || c.name.to_lowercase() == q) {
            return Ok(Some(c.clone()));
        }
        let hits: Vec<&Contact> = list.iter().filter(|c| q.len() >= 4 && c.address.starts_with(&q)).collect();
        match hits.as_slice() {
            [one] => Ok(Some((*one).clone())),
            [] => Ok(None),
            _ => Err(Error::Invalid(format!("`{query}` matches more than one contact"))),
        }
    }

    // ---- chats ----------------------------------------------------------------------------

    fn chat_path(&self, peer: &str) -> PathBuf {
        self.data.join("chats").join(format!("{peer}.json"))
    }

    pub fn chat(&self, peer: &str) -> Result<Vec<Value>> {
        Ok(read_json(&self.chat_path(peer))?.and_then(|v| v.as_array().cloned()).unwrap_or_default())
    }

    pub fn save_chat(&self, peer: &str, list: &[Value]) -> Result<()> {
        private_dir(&self.data)?;
        private_dir(&self.data.join("chats"))?;
        write_atomic(&self.chat_path(peer), serde_json::to_string(list).expect("json").as_bytes(), 0o600)
    }

    /// Merges messages into a chat (dedupe by `(mine, id)`), durably. True if a new one was added.
    pub fn merge(&self, peer: &str, incoming: &[Value]) -> Result<bool> {
        let mut list = self.chat(peer)?;
        let added = merge_messages(&mut list, incoming);
        self.save_chat(peer, &list)?;
        Ok(added)
    }

    /// Changes one of our own messages (state, delivery) and saves.
    pub fn update_own(&self, peer: &str, id: &str, change: impl FnOnce(&mut Value)) -> Result<bool> {
        let mut list = self.chat(peer)?;
        let Some(m) = list.iter_mut().find(|m| m["mine"] == true && m["id"] == id) else { return Ok(false) };
        change(m);
        self.save_chat(peer, &list)?;
        Ok(true)
    }

    /// Own messages that were created but not confirmed by the relay.
    pub fn pending(&self, peer: &str) -> Result<Vec<Value>> {
        Ok(self.chat(peer)?.into_iter().filter(|m| m["mine"] == true && m["state"] == "pending").collect())
    }
}

impl Store {
    // ---- interface state ------------------------------------------------------------------

    /// Small per-profile state of the terminal UI (read markers, drafts). Never holds secrets.
    pub fn ui_state(&self) -> Value {
        read_json(&self.data.join("ui.json")).ok().flatten().filter(Value::is_object).unwrap_or_else(|| json!({}))
    }

    pub fn save_ui_state(&self, state: &Value) -> Result<()> {
        private_dir(&self.data)?;
        write_atomic(&self.data.join("ui.json"), serde_json::to_string(state).expect("json").as_bytes(), 0o600)
    }

    // ---- one interactive session per profile ------------------------------------------------

    /// Takes the exclusive "terminal UI is open" lock. `Ok(None)` means another process holds it.
    /// The lock lives as long as the returned file.
    pub fn lock_ui(&self) -> Result<Option<fs::File>> {
        private_dir(&self.data)?;
        let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(self.data.join("ui.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(e)) => Err(e.into()),
        }
    }

    /// True while a terminal UI holds the lock for this profile.
    pub fn ui_running(&self) -> bool {
        matches!(self.lock_ui(), Ok(None))
    }
}

impl Store {
    // ---- account, device and sync metadata ---------------------------------------------------

    fn device_path(&self) -> PathBuf {
        self.config.join("device.json")
    }

    /// This device's own key (never shared); made on first use.
    pub fn device(&self) -> Result<Identity> {
        if let Some(v) = read_json(&self.device_path())? {
            return Ok(Identity::from_seed_hex(v.get("seed").and_then(Value::as_str).unwrap_or_default())?);
        }
        private_dir(&self.config)?;
        let id = Identity::generate()?;
        write_atomic(&self.device_path(), json!({"seed": id.seed_hex()}).to_string().as_bytes(), 0o600)?;
        Ok(id)
    }

    /// Makes this profile a copy of an existing account (device linking). Refuses to overwrite.
    pub fn adopt_account(&self, seed_hex: &str, name: Option<&str>) -> Result<Identity> {
        if self.identity_path().exists() {
            return Err(Error::Invalid("an identity already exists here; refusing to overwrite it".into()));
        }
        let id = Identity::from_seed_hex(seed_hex)?;
        private_dir(&self.config)?;
        let mut v = json!({"seed": id.seed_hex()});
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            v["name"] = n.into();
        }
        write_atomic(&self.identity_path(), v.to_string().as_bytes(), 0o600)?;
        Ok(id)
    }

    pub fn has_identity(&self) -> bool {
        self.identity_path().exists()
    }

    /// Changes the shared display name (empty clears it).
    pub fn set_profile_name(&self, name: &str) -> Result<()> {
        let mut v = read_json(&self.identity_path())?.ok_or_else(|| Error::Invalid("no identity yet".into()))?;
        if name.is_empty() {
            v.as_object_mut().map(|o| o.remove("name"));
        } else {
            v["name"] = name.into();
        }
        write_atomic(&self.identity_path(), v.to_string().as_bytes(), 0o600)
    }

    pub fn meta(&self, key: &str) -> Value {
        read_json(&self.data.join("meta.json")).ok().flatten().and_then(|v| v.get(key).cloned()).unwrap_or(Value::Null)
    }

    pub fn set_meta(&self, key: &str, value: Value) -> Result<()> {
        private_dir(&self.data)?;
        let path = self.data.join("meta.json");
        let mut all = read_json(&path)?.filter(Value::is_object).unwrap_or_else(|| json!({}));
        if value.is_null() {
            all.as_object_mut().map(|o| o.remove(key));
        } else {
            all[key] = value;
        }
        write_atomic(&path, all.to_string().as_bytes(), 0o600)
    }

    pub fn meta_list(&self, key: &str) -> Vec<Value> {
        self.meta(key).as_array().cloned().unwrap_or_default()
    }

    pub fn addresses(&self, key: &str) -> Vec<String> {
        self.meta_list(key).iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
    }

    pub fn receipts_on(&self) -> bool {
        self.meta("receipts").as_bool().unwrap_or(true)
    }

    /// Every stored conversation, keyed by peer address.
    pub fn all_chats(&self) -> serde_json::Map<String, Value> {
        let mut out = serde_json::Map::new();
        if let Ok(dir) = fs::read_dir(self.data.join("chats")) {
            for e in dir.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(peer) = name.strip_suffix(".json") {
                    if let Ok(Some(Value::Array(list))) = read_json(&e.path()) {
                        if !list.is_empty() {
                            out.insert(peer.to_string(), Value::Array(list));
                        }
                    }
                }
            }
        }
        out
    }

    pub fn delete_chat(&self, peer: &str) -> Result<()> {
        match fs::remove_file(self.chat_path(peer)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    pub fn remove_contact(&self, address: &str) -> Result<()> {
        let list: Vec<Contact> = self.contacts()?.into_iter().filter(|c| c.address != address).collect();
        self.save_contacts(&list)
    }

    /// Directory for received files.
    pub fn files_dir(&self) -> PathBuf {
        self.data.join("files")
    }

    pub fn data_dir(&self) -> &Path {
        &self.data
    }

    pub fn config_dir(&self) -> &Path {
        &self.config
    }
}

/// Longest message the CLI sends (UTF-16 units, like the web client).
pub const MAX_SEND: usize = MAX_TEXT;

impl Store {
    /// A second handle on the same directories (the hub task owns one).
    pub fn open_like(other: &Store) -> Store {
        Store { config: other.config.clone(), data: other.data.clone() }
    }
}
