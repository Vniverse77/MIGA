//! Linked devices (ENGINE.md section 12): link codes, sync messages between the devices of one
//! account, tombstones and the pull-based history transfer. Pure logic over the [`Store`]; the
//! network side lives in `hub.rs`.
use crate::store::{Contact, Store};
use crate::{now_ms, Result};
use miga_core::crypto::{safety_number, sync_key};
use miga_core::identity::{is_address, Identity};
use miga_core::js::{is_id, js_number};
use miga_core::link::{open_value, seal_value, sync_aad};
use miga_core::payload::{clean_ids, clean_name, MAX_TEXT};
use miga_core::sync::{
    add_tombs, clean_cursor, clean_message, clean_tombs, contact_tomb_ts, history_page, prune_tombs, tomb_filter,
    Cursor, Tomb, TombKind, HISTORY_PAGE_BYTES,
};
use serde_json::{json, Map, Value};

pub const MAX_BLOCKED: usize = 500;
/// A request for a history page is repeated after this long without an answer.
pub const HX_RETRY_MS: i64 = 20_000;

/// Both identities and the sync key of this device.
pub struct Keys {
    pub account: Identity,
    pub device: Identity,
    pub sync: [u8; 32],
}

impl Keys {
    pub fn load(store: &Store) -> Result<Keys> {
        let account = store.identity()?;
        let device = store.device()?;
        let sync = sync_key(&account);
        Ok(Keys { account, device, sync })
    }

    pub fn seal_to(&self, to: &str, message: &Value) -> Result<String> {
        Ok(seal_value(&self.sync, message, &sync_aad(self.device.address(), to))?)
    }
}

/// A short label such as `Linux · MIGA CLI`.
pub fn device_label() -> String {
    let os = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "macOS",
        "windows" => "Windows",
        _ => "Device",
    };
    format!("{os} \u{b7} MIGA CLI")
}

/// What processing one message changed or wants sent.
#[derive(Debug, Default)]
pub struct Effects {
    /// Sync messages to send: `(Some(device), msg)` to one device, `(None, msg)` to all others.
    pub send: Vec<(Option<String>, Value)>,
    /// Chats (peer addresses) whose messages or contact changed.
    pub changed: Vec<String>,
    /// Chats read on another device (or copied as history) up to this time.
    pub read: Vec<(String, f64)>,
    pub notes: Vec<String>,
    /// This device was removed from the account: erase everything.
    pub erase: bool,
    /// History copy: `(done, total)`; `None` when no job is running.
    pub progress: Option<(u64, u64)>,
    pub hx_finished: bool,
    /// The device list changed.
    pub devices: bool,
}

/// In-memory state of the history request currently open.
#[derive(Debug, Default)]
pub struct HxRuntime {
    pub pending: Option<(String, i64)>,
    pub tries: u32,
}

pub fn devices(store: &Store) -> Vec<Value> {
    store.meta_list("devices")
}

pub fn other_devices(store: &Store, keys: &Keys) -> Vec<String> {
    devices(store)
        .iter()
        .filter_map(|d| d["address"].as_str())
        .filter(|a| *a != keys.device.address())
        .map(str::to_string)
        .collect()
}

/// `cleanDevices`: at most 20, valid unique addresses.
pub fn clean_devices(value: &Value, now: i64) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in value.as_array().into_iter().flatten().take(20) {
        let Some(address) = item["address"].as_str().filter(|a| is_address(a)) else { continue };
        if !seen.insert(address.to_string()) {
            continue;
        }
        let label = clean_name(&item["label"]);
        let added = js_number(item.get("added"));
        out.push(json!({
            "address": address,
            "label": if label.is_empty() { "Device".to_string() } else { label },
            "added": if added.is_finite() && added != 0.0 { added as i64 } else { now },
        }));
    }
    out
}

fn clean_addresses(value: &Value, own: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in value.as_array().into_iter().flatten() {
        if let Some(a) = a.as_str().filter(|a| *a != own && is_address(a)) {
            if !out.iter().any(|o| o == a) {
                out.push(a.to_string());
            }
        }
    }
    out.truncate(MAX_BLOCKED);
    out
}

pub fn tombs(store: &Store) -> Vec<Tomb> {
    clean_tombs(&store.meta("tombs"), now_ms() as f64 + 1e12)
}

pub fn save_tombs(store: &Store, list: &[Tomb]) -> Result<()> {
    store.set_meta("tombs", Value::Array(list.iter().map(Tomb::to_value).collect()))
}

/// Records deletes made here; returns the sync messages that tell the other devices.
pub fn remember_deletes(store: &Store, items: &[Tomb]) -> Result<Vec<(Option<String>, Value)>> {
    let mut list = tombs(store);
    let now = now_ms();
    prune_tombs(&mut list, now);
    let added = add_tombs(&mut list, items);
    if added.is_empty() {
        return Ok(vec![]);
    }
    save_tombs(store, &list)?;
    Ok(added
        .chunks(100)
        .map(|c| (None, json!({"k": "tomb", "items": c.iter().map(Tomb::to_value).collect::<Vec<_>>()})))
        .collect())
}

/// Applies tombstones to the stored chats and contacts. Returns the affected chats.
pub fn apply_tombstones(store: &Store, added: &[Tomb]) -> Result<Vec<String>> {
    let all = tombs(store);
    let deleted = tomb_filter(&all);
    let mut changed = Vec::new();
    let mut peers: Vec<String> = added.iter().map(|t| t.chat.clone()).collect();
    peers.sort();
    peers.dedup();
    for peer in peers {
        let mut list = store.chat(&peer)?;
        let before = list.len();
        list.retain(|m| {
            !deleted(&peer, m["id"].as_str().unwrap_or_default(), m["mine"] == true, m["ts"].as_f64().unwrap_or(0.0))
        });
        if list.len() != before {
            if list.is_empty() {
                store.delete_chat(&peer)?;
            } else {
                store.save_chat(&peer, &list)?;
            }
            changed.push(peer.clone());
        }
        if added.iter().any(|t| t.chat == peer && t.kind == TombKind::Contact) {
            store.remove_contact(&peer)?;
            if !changed.contains(&peer) {
                changed.push(peer.clone());
            }
        }
    }
    Ok(changed)
}

/// Forgets a contact tombstone when the contact is added again or writes after the delete.
pub fn revive_contact(store: &Store, address: &str, ts: f64) -> Result<()> {
    let mut list = tombs(store);
    let at = contact_tomb_ts(&list, address);
    if at > 0 && ts > at as f64 {
        list.retain(|t| !(t.kind == TombKind::Contact && t.chat == address));
        save_tombs(store, &list)?;
    }
    Ok(())
}

/// Creates a contact from a peer's shared name (or placeholder) when it is unknown.
pub fn ensure_contact(store: &Store, address: &str, name: Option<&str>) -> Result<()> {
    let placeholder = format!("{}...", &address[..8]);
    let cleaned = clean_name(&Value::from(name.unwrap_or_default()));
    let mut list = store.contacts()?;
    match list.iter_mut().find(|c| c.address == address) {
        Some(c) => {
            if !c.custom && !cleaned.is_empty() && c.name != cleaned {
                c.name = cleaned;
                store.save_contacts(&list)?;
            }
        }
        None => {
            let name = if cleaned.is_empty() { placeholder } else { cleaned };
            list.push(Contact { address: address.into(), name, custom: false, verified: None });
            store.save_contacts(&list)?;
        }
    }
    Ok(())
}

/// Messages of one chat that pass the tombstone filter and the validators.
fn clean_page(store: &Store, chats: &Value, mark_seen: bool, fx: &mut Effects) -> Result<u64> {
    let all = tombs(store);
    let deleted = tomb_filter(&all);
    let now = now_ms() as f64;
    let mut seen = 0u64;
    for (peer, list) in chats.as_object().into_iter().flatten() {
        let Some(list) = list.as_array().filter(|_| is_address(peer)) else { continue };
        seen += list.len() as u64;
        let clean: Vec<Value> = list
            .iter()
            .filter_map(|x| clean_message(x, MAX_TEXT, now))
            .filter(|m| {
                !deleted(peer, m["id"].as_str().unwrap_or_default(), m["mine"] == true, m["ts"].as_f64().unwrap_or(0.0))
            })
            .collect();
        if clean.is_empty() {
            continue;
        }
        ensure_contact(store, peer, None)?;
        store.merge(peer, &clean)?;
        if mark_seen {
            let newest =
                clean.iter().filter(|m| m["mine"] == false).filter_map(|m| m["ts"].as_f64()).fold(0.0, f64::max);
            if newest > 0.0 {
                fx.read.push((peer.clone(), newest));
            }
        }
        fx.changed.push(peer.clone());
    }
    Ok(seen)
}

pub fn count_messages(chats: &Map<String, Value>) -> u64 {
    chats.values().filter_map(Value::as_array).map(|l| l.len() as u64).sum()
}

pub fn hx_job(store: &Store) -> Option<Value> {
    let j = store.meta("hx");
    (j.is_object() && is_id(j["sid"].as_str().unwrap_or_default())).then_some(j)
}

/// Starts (or restarts) copying the history from `from`.
pub fn start_hx(store: &Store, from: &str) -> Result<()> {
    store.set_meta("hx", json!({"sid": miga_core::random_id()?, "from": from, "cursor": null, "done": 0, "total": 0}))
}

/// The next `hxq` to send, if a job is open and no request is pending or the pending one timed out.
pub fn hx_query(store: &Store, keys: &Keys, rt: &mut HxRuntime, now: i64) -> Result<Option<(String, Value)>> {
    let Some(job) = hx_job(store) else { return Ok(None) };
    if let Some((_, at)) = &rt.pending {
        if now - at <= HX_RETRY_MS {
            return Ok(None);
        }
        rt.tries += 1;
    }
    let first = job["from"].as_str().unwrap_or_default().to_string();
    let mut others = vec![first.clone()];
    others.extend(other_devices(store, keys).into_iter().filter(|a| *a != first));
    let to = others[(rt.tries as usize / 3) % others.len()].clone();
    let q = miga_core::random_id()?;
    rt.pending = Some((q.clone(), now));
    Ok(Some((to, json!({"k": "hxq", "sid": job["sid"], "q": q, "after": job["cursor"]}))))
}

/// What the device that showed a link code sends to the new device after its `hello`.
pub fn sponsor_snapshot(store: &Store, keys: &Keys, to: &str) -> Result<Vec<Value>> {
    let mut everyone = vec![json!({"address": keys.device.address(), "label": device_label(), "added": now_ms()})];
    everyone.extend(devices(store).into_iter().filter(|d| d["address"] != to));
    let mut out = vec![
        json!({"k": "state", "profile": profile_value(store), "devices": everyone}),
        json!({"k": "state", "blocked": store.addresses("blocked")}),
        json!({"k": "state", "muted": store.addresses("muted")}),
        json!({"k": "receipts", "on": store.receipts_on()}),
    ];
    let contacts: Vec<Value> = store.contacts()?.iter().map(contact_value).collect();
    for c in contacts.chunks(50) {
        out.push(json!({"k": "state", "contacts": c}));
    }
    Ok(out)
}

pub fn contact_value(c: &Contact) -> Value {
    let mut v = json!({"address": c.address, "name": c.name});
    if c.custom {
        v["custom"] = true.into();
    }
    if let Some(n) = &c.verified {
        v["verified"] = n.clone().into();
    }
    v
}

pub fn profile_value(store: &Store) -> Value {
    json!({"name": store.profile_name().ok().flatten().unwrap_or_default(), "share": store.meta("share").as_bool().unwrap_or(true)})
}

fn is_safety_number(v: &str) -> bool {
    v.len() == 60 && v.bytes().all(|b| b.is_ascii_digit())
}

/// A sync message from another device. `None` means "do not acknowledge" (never happens today).
pub fn handle_sync(
    store: &Store,
    keys: &Keys,
    rt: &mut HxRuntime,
    from: &str,
    body: &str,
    relay_ts: f64,
) -> Result<Effects> {
    let mut fx = Effects::default();
    let Some(m) = open_value(&keys.sync, body, &sync_aad(from, keys.device.address())) else { return Ok(fx) };
    let now = now_ms();
    let me = keys.account.address();
    // Anything from a device proves it is ours; a pending "hello" is done once someone answers.
    if store.meta("hello_pending").as_bool() == Some(true)
        && matches!(m["k"].as_str(), Some("state" | "hx" | "receipts"))
    {
        store.set_meta("hello_pending", Value::Null)?;
    }
    match m["k"].as_str().unwrap_or_default() {
        "hello" => {
            let mut list = devices(store);
            if !list.iter().any(|d| d["address"] == from) {
                list.extend(clean_devices(&json!([{"address": from, "label": m["label"]}]), now));
                store.set_meta("devices", Value::Array(list))?;
                fx.devices = true;
            }
            if m["sponsor"] == keys.device.address() {
                fx.notes.push("linked".into());
                for s in sponsor_snapshot(store, keys, from)? {
                    fx.send.push((Some(from.to_string()), s));
                }
            }
        }
        "state" => {
            if m.get("profile").is_some_and(Value::is_object) {
                store.set_profile_name(&clean_name(&m["profile"]["name"]))?;
                store.set_meta("share", (m["profile"]["share"] != false).into())?;
            }
            let all = tombs(store);
            for raw in m["contacts"].as_array().into_iter().flatten() {
                let Some(address) = raw["address"].as_str().filter(|a| is_address(a) && *a != me) else { continue };
                let name = clean_name(&raw["name"]);
                if name.is_empty() || contact_tomb_ts(&all, address) as f64 >= relay_ts {
                    continue;
                }
                revive_contact(store, address, relay_ts)?;
                let theirs = raw["verified"].as_str().filter(|v| is_safety_number(v));
                let verified = theirs.filter(|v| safety_number(me, address).is_ok_and(|n| n == *v)).map(str::to_string);
                let mut list = store.contacts()?;
                let custom = raw["custom"] == true;
                match list.iter_mut().find(|c| c.address == address) {
                    Some(c) => {
                        c.name = name;
                        c.custom = custom;
                        c.verified = verified;
                    }
                    None => list.push(Contact { address: address.into(), name, custom, verified }),
                }
                store.save_contacts(&list)?;
                fx.changed.push(address.to_string());
            }
            if m.get("blocked").is_some() {
                store.set_meta("blocked", json!(clean_addresses(&m["blocked"], me)))?;
            }
            if m.get("muted").is_some() {
                store.set_meta("muted", json!(clean_addresses(&m["muted"], me)))?;
            }
            if let Some(list) = m.get("devices") {
                let mut mine = devices(store);
                for d in clean_devices(list, now) {
                    if d["address"] != keys.device.address() && !mine.iter().any(|x| x["address"] == d["address"]) {
                        mine.push(d);
                        fx.devices = true;
                    }
                }
                store.set_meta("devices", Value::Array(mine))?;
            }
        }
        "history" => {
            clean_page(store, &m["chats"], false, &mut fx)?;
        }
        "hxq" => {
            let (sid, q) = (m["sid"].as_str().unwrap_or_default(), m["q"].as_str().unwrap_or_default());
            if !is_id(sid) || !is_id(q) {
                return Ok(fx);
            }
            let after = if m["after"].is_null() {
                None
            } else {
                match clean_cursor(&m["after"]) {
                    Some(c) => Some(c),
                    None => return Ok(fx),
                }
            };
            if after.is_none() {
                for c in tombs(store).chunks(100) {
                    fx.send.push((
                        Some(from.to_string()),
                        json!({"k": "tomb", "items": c.iter().map(Tomb::to_value).collect::<Vec<_>>()}),
                    ));
                }
            }
            let chats = store.all_chats();
            let page = history_page(&chats, after.as_ref(), HISTORY_PAGE_BYTES);
            fx.send.push((
                Some(from.to_string()),
                json!({"k": "hx", "sid": sid, "q": q, "chats": page.chats, "next": page.next.as_ref().map(Cursor::to_value),
                       "total": count_messages(&chats)}),
            ));
        }
        "hx" => {
            let Some(job) = hx_job(store) else { return Ok(fx) };
            let ok = rt.pending.as_ref().is_some_and(|(q, _)| m["q"] == q.as_str()) && m["sid"] == job["sid"];
            if !ok {
                return Ok(fx);
            }
            rt.pending = None;
            rt.tries = 0;
            let seen = clean_page(store, &m["chats"], true, &mut fx)?;
            let next = if m["next"].is_null() { None } else { clean_cursor(&m["next"]) };
            let done = job["done"].as_u64().unwrap_or(0) + seen;
            let total = job["total"].as_u64().unwrap_or(0).max(js_number(m.get("total")).max(0.0) as u64);
            match next {
                None => {
                    store.set_meta("hx", Value::Null)?;
                    fx.hx_finished = true;
                    fx.progress = Some((total, total));
                }
                Some(c) => {
                    let mut j = job.clone();
                    j["cursor"] = c.to_value();
                    j["done"] = done.into();
                    j["total"] = total.into();
                    store.set_meta("hx", j)?;
                    fx.progress = Some((done, total));
                }
            }
        }
        "tomb" => {
            let mut list = tombs(store);
            let added = add_tombs(&mut list, &clean_tombs(&m["items"], now as f64));
            if !added.is_empty() {
                save_tombs(store, &list)?;
                fx.changed.extend(apply_tombstones(store, &added)?);
            }
        }
        "read" => {
            if let (Some(peer), Some(up)) = (m["peer"].as_str().filter(|p| is_address(p)), m["upTo"].as_f64()) {
                fx.read.push((peer.to_string(), up));
            }
        }
        "msg" => {
            let (Some(peer), Some(clean)) =
                (m["peer"].as_str().filter(|p| is_address(p)), clean_message(&m["message"], MAX_TEXT, now as f64))
            else {
                return Ok(fx);
            };
            let ts = clean["ts"].as_f64().unwrap_or(0.0);
            let all = tombs(store);
            if tomb_filter(&all)(peer, clean["id"].as_str().unwrap_or_default(), clean["mine"] == true, ts) {
                return Ok(fx);
            }
            revive_contact(store, peer, ts)?;
            ensure_contact(store, peer, if clean["mine"] == true { None } else { m["name"].as_str() })?;
            store.merge(peer, &[clean])?;
            fx.changed.push(peer.to_string());
        }
        "del" => {
            if let Some(peer) = m["peer"].as_str().filter(|p| is_address(p)) {
                let items: Vec<Tomb> = m["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(100)
                    .filter_map(|i| {
                        let id = clean_ids(&json!([i["id"]])).into_iter().next()?;
                        Some(Tomb {
                            chat: peer.into(),
                            kind: TombKind::Message,
                            id: Some(id),
                            mine: i["mine"].as_bool()?,
                            ts: relay_ts as i64,
                        })
                    })
                    .collect();
                let mut list = tombs(store);
                let added = add_tombs(&mut list, &items);
                if !added.is_empty() {
                    save_tombs(store, &list)?;
                    fx.changed.extend(apply_tombstones(store, &added)?);
                }
            }
        }
        "edit" => {
            if let (Some(peer), Some(mine), Some(id), Some(text)) = (
                m["peer"].as_str().filter(|p| is_address(p)),
                m["mine"].as_bool(),
                m["id"].as_str(),
                m["text"].as_str(),
            ) {
                let mut list = store.chat(peer)?;
                if miga_core::payload::apply_edit(&mut list, id, mine, text, js_number(m.get("ts")), now as f64) {
                    store.save_chat(peer, &list)?;
                    fx.changed.push(peer.to_string());
                }
            }
        }
        "st" => {
            let level = m["d"].as_str().unwrap_or_default();
            if let Some(peer) = m["peer"].as_str().filter(|p| is_address(p)) {
                if matches!(level, "delivered" | "read") && (level != "read" || store.receipts_on()) {
                    let mut any = false;
                    for id in clean_ids(&m["ids"]) {
                        any |= apply_status(store, peer, &id, level)?;
                    }
                    if any {
                        fx.changed.push(peer.to_string());
                    }
                }
            }
        }
        "receipts" => {
            store.set_meta("receipts", (m["on"] == true).into())?;
        }
        "bye" => {
            if m["address"] == keys.device.address() {
                fx.erase = true;
            } else if let Some(a) = m["address"].as_str() {
                let list: Vec<Value> = devices(store).into_iter().filter(|d| d["address"] != a).collect();
                store.set_meta("devices", Value::Array(list))?;
                fx.devices = true;
            }
        }
        _ => {}
    }
    fx.changed.sort();
    fx.changed.dedup();
    Ok(fx)
}

/// Raises the delivery state of one own message. True if it changed.
pub fn apply_status(store: &Store, peer: &str, id: &str, level: &str) -> Result<bool> {
    let rank = |d: Option<&str>| match d {
        Some("delivered") => 1,
        Some("read") => 2,
        _ => 0,
    };
    store.update_own(peer, id, |m| {
        if rank(Some(level)) > rank(m["delivery"].as_str()) {
            m["delivery"] = level.into();
        }
        if m["state"] == "pending" {
            m["state"] = "sent".into();
        }
    })
}

/// A link code on offer: the sealed bundle waits on the relay at the mailbox address.
pub struct LinkOffer {
    pub code: String,
    pub mailbox: Identity,
    pub expires: i64,
    pub body: String,
}

/// Makes a code and the bundle for the new device (ENGINE.md section 12, "Linking").
pub fn new_offer(store: &Store, keys: &Keys) -> Result<LinkOffer> {
    let code = miga_core::link::new_link_code()?;
    let derived = miga_core::link::derive_link(&code)?;
    let expires = now_ms() + miga_core::link::LINK_TTL_MS;
    let mut list = vec![json!({"address": keys.device.address(), "label": device_label(), "added": now_ms()})];
    list.extend(devices(store));
    let bundle = json!({
        "k": "link", "secret": keys.account.seed_hex(), "sponsor": keys.device.address(), "exp": expires,
        "profile": profile_value(store), "devices": list,
    });
    let body = seal_value(&derived.bundle_key, &bundle, "")?;
    store.set_meta("open_link", derived.mailbox.seed_hex().into())?;
    Ok(LinkOffer { code, mailbox: derived.mailbox, expires, body })
}

/// Adopts the account from a valid bundle (the new device side). Returns the sponsor address.
pub fn adopt_bundle(store: &Store, bundle: &Value) -> Result<String> {
    let secret = bundle["secret"].as_str().unwrap_or_default();
    store.adopt_account(secret, None)?;
    let device = store.device()?;
    store.set_profile_name(&clean_name(&bundle["profile"]["name"]))?;
    store.set_meta("share", (bundle["profile"]["share"] != false).into())?;
    let list: Vec<Value> =
        clean_devices(&bundle["devices"], now_ms()).into_iter().filter(|d| d["address"] != device.address()).collect();
    store.set_meta("devices", Value::Array(list))?;
    let sponsor = bundle["sponsor"].as_str().unwrap_or_default().to_string();
    if is_address(&sponsor) {
        start_hx(store, &sponsor)?;
        store.set_meta("hello_pending", true.into())?;
        store.set_meta("hello_sponsor", sponsor.clone().into())?;
    }
    Ok(sponsor)
}
