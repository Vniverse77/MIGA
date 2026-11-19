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
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn save_contacts(&self, list: &[Contact]) -> Result<()> {
        private_dir(&self.data)?;
        let v: Vec<Value> = list.iter().map(|c| json!({"address": c.address, "name": c.name})).collect();
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
                list.push(Contact { address: address.into(), name: name.into() });
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

/// Longest message the CLI sends (UTF-16 units, like the web client).
pub const MAX_SEND: usize = MAX_TEXT;
