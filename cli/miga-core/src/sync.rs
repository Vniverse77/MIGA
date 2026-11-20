//! Pure helpers for linked devices: tombstones, history pages, message merge and the
//! `clean*` validators for data from other devices (ENGINE.md sections 10, 12, 13).
//! Messages stay `serde_json::Value`, mirroring the dynamic TypeScript objects.
use crate::attach::clean_att;
use crate::identity::is_address;
use crate::js::{is_id, js_number, num_value, slice_units_lossy};
use crate::payload::{clean_reply, edit_time};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const TOMB_TTL_MS: i64 = 90 * 24 * 3600 * 1000;
pub const MAX_TOMBS: usize = 5000;
pub const HISTORY_PAGE_BYTES: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TombKind {
    /// One message.
    Message,
    /// A whole conversation up to `ts`.
    Conversation,
    /// The contact and its conversation up to `ts`.
    Contact,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tomb {
    pub chat: String,
    pub kind: TombKind,
    pub id: Option<String>,
    pub mine: bool,
    pub ts: i64,
}

impl Tomb {
    pub fn to_value(&self) -> Value {
        let s = match self.kind {
            TombKind::Message => "m",
            TombKind::Conversation => "c",
            TombKind::Contact => "k",
        };
        let mut m = Map::new();
        m.insert("c".into(), self.chat.clone().into());
        m.insert("s".into(), s.into());
        if self.kind == TombKind::Message {
            m.insert("id".into(), self.id.clone().unwrap_or_default().into());
            m.insert("mine".into(), self.mine.into());
        }
        m.insert("ts".into(), self.ts.into());
        Value::Object(m)
    }

    fn key(&self) -> String {
        match self.kind {
            TombKind::Message => {
                format!("m|{}|{}|{}", self.chat, if self.mine { 'm' } else { 't' }, self.id.as_deref().unwrap_or(""))
            }
            TombKind::Conversation => format!("c|{}", self.chat),
            TombKind::Contact => format!("k|{}", self.chat),
        }
    }
}

/// `cleanTombs`: reads at most 500 items, drops invalid ones and anything more than 24 h ahead.
pub fn clean_tombs(value: &Value, now: f64) -> Vec<Tomb> {
    let mut out = Vec::new();
    let Some(list) = value.as_array() else { return out };
    for item in list.iter().take(500) {
        let Some(chat) = item.get("c").and_then(Value::as_str).filter(|c| is_address(c)) else { continue };
        let ts = js_number(item.get("ts"));
        if !ts.is_finite() || ts <= 0.0 || ts > now + 24.0 * 3_600_000.0 {
            continue;
        }
        let ts = ts.floor() as i64;
        match item.get("s").and_then(Value::as_str) {
            Some("c") => out.push(Tomb { chat: chat.into(), kind: TombKind::Conversation, id: None, mine: false, ts }),
            Some("k") => out.push(Tomb { chat: chat.into(), kind: TombKind::Contact, id: None, mine: false, ts }),
            Some("m") => {
                if let (Some(id), Some(mine)) = (
                    item.get("id").and_then(Value::as_str).filter(|i| is_id(i)),
                    item.get("mine").and_then(Value::as_bool),
                ) {
                    out.push(Tomb { chat: chat.into(), kind: TombKind::Message, id: Some(id.into()), mine, ts });
                }
            }
            _ => {}
        }
    }
    out
}

/// Forgets tombstones older than 90 days. Returns true if any went.
pub fn prune_tombs(list: &mut Vec<Tomb>, now: i64) -> bool {
    let before = list.len();
    list.retain(|t| now - t.ts < TOMB_TTL_MS);
    list.len() != before
}

/// Adds tombstones (newest per item wins). Returns the ones that were new or newer.
pub fn add_tombs(list: &mut Vec<Tomb>, incoming: &[Tomb]) -> Vec<Tomb> {
    let mut index: HashMap<String, usize> = list.iter().enumerate().map(|(i, t)| (t.key(), i)).collect();
    let mut added = Vec::new();
    for t in incoming {
        let key = t.key();
        match index.get(&key) {
            None => {
                list.push(t.clone());
                index.insert(key, list.len() - 1);
                added.push(t.clone());
            }
            Some(&at) if list[at].ts < t.ts => {
                list[at] = t.clone();
                added.push(t.clone());
            }
            _ => {}
        }
    }
    // A conversation or contact tombstone covers older message tombstones of that chat.
    if added.iter().any(|t| t.kind != TombKind::Message) {
        let cut: HashMap<String, i64> = cuts(list).into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        list.retain(|t| t.kind != TombKind::Message || t.ts > cut.get(&t.chat).copied().unwrap_or(0));
    }
    if list.len() > MAX_TOMBS {
        list.drain(..list.len() - MAX_TOMBS);
    }
    added
}

fn cuts(list: &[Tomb]) -> HashMap<&str, i64> {
    let mut cut: HashMap<&str, i64> = HashMap::new();
    for t in list.iter().filter(|t| t.kind != TombKind::Message) {
        let e = cut.entry(t.chat.as_str()).or_insert(0);
        *e = (*e).max(t.ts);
    }
    cut
}

/// Answers "was this message deleted?" for `(chat, id, mine, ts)`.
pub fn tomb_filter(tombs: &[Tomb]) -> impl Fn(&str, &str, bool, f64) -> bool + '_ {
    let msgs: HashSet<String> = tombs.iter().filter(|t| t.kind == TombKind::Message).map(Tomb::key).collect();
    let cut = cuts(tombs);
    move |chat, id, mine, ts| {
        msgs.contains(&format!("m|{chat}|{}|{id}", if mine { 'm' } else { 't' }))
            || ts <= cut.get(chat).copied().unwrap_or(0) as f64
    }
}

// ---- messages -----------------------------------------------------------------------------

fn msg_key(m: &Value) -> String {
    format!(
        "{}{}",
        if m.get("mine").and_then(Value::as_bool) == Some(true) { 'm' } else { 't' },
        m.get("id").and_then(Value::as_str).unwrap_or("")
    )
}

fn delivery_rank(m: &Value) -> u8 {
    match m.get("delivery").and_then(Value::as_str) {
        Some("delivered") => 1,
        Some("read") => 2,
        _ => 0,
    }
}

fn ts_of(m: &Value) -> f64 {
    m.get("ts").and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `mergeMessages`: adds unknown messages, keeps time order (stable); for known ones the newer
/// edit wins and a receipt never goes backwards. Returns true if a NEW message was added.
pub fn merge_messages(list: &mut Vec<Value>, incoming: &[Value]) -> bool {
    let mut known: HashMap<String, usize> = list.iter().enumerate().map(|(i, m)| (msg_key(m), i)).collect();
    let mut added = false;
    for message in incoming {
        let key = msg_key(message);
        if let Some(&at) = known.get(&key) {
            let new_edit = message.get("edited").and_then(Value::as_f64).unwrap_or(0.0);
            let have_edit = list[at].get("edited").and_then(Value::as_f64).unwrap_or(0.0);
            if new_edit > have_edit {
                list[at]["text"] = message.get("text").cloned().unwrap_or(Value::Null);
                list[at]["edited"] = message.get("edited").cloned().unwrap_or(Value::Null);
            }
            let have_mine = list[at].get("mine").and_then(Value::as_bool) == Some(true);
            if have_mine && delivery_rank(message) > delivery_rank(&list[at]) {
                list[at]["delivery"] = message["delivery"].clone();
            }
            continue;
        }
        known.insert(key, list.len());
        list.push(message.clone());
        added = true;
    }
    if added {
        list.sort_by(|a, b| ts_of(a).partial_cmp(&ts_of(b)).unwrap_or(std::cmp::Ordering::Equal));
    }
    added
}

/// `cleanMessage` for a message from another device.
pub fn clean_message(value: &Value, max_text: usize, now: f64) -> Option<Value> {
    let id = value.get("id").and_then(Value::as_str).filter(|i| is_id(i))?;
    let text = value.get("text").and_then(Value::as_str)?;
    let mine = value.get("mine").and_then(Value::as_bool)?;
    let ts = js_number(value.get("ts"));
    if !ts.is_finite() {
        return None;
    }
    let state = if mine && value.get("state").and_then(Value::as_str) == Some("failed") {
        "failed"
    } else if mine {
        "sent"
    } else {
        "received"
    };
    let reply = match value.get("reply") {
        None => None,
        Some(r) => clean_reply(r),
    };
    let att = match value.get("att") {
        None => None,
        Some(a) => Some(clean_att(a, mine)?),
    };
    let mut m = Map::new();
    m.insert("id".into(), id.into());
    m.insert("mine".into(), mine.into());
    m.insert("text".into(), slice_units_lossy(text, max_text).into());
    m.insert("ts".into(), num_value(ts));
    m.insert("state".into(), state.into());
    if let Some(r) = reply {
        m.insert("reply".into(), r.to_value());
    }
    if let Some(a) = att {
        m.insert("att".into(), a.to_value());
    }
    let edited = js_number(value.get("edited"));
    if edited.is_finite() && edited > 0.0 {
        m.insert("edited".into(), num_value(edit_time(edited, now)));
    }
    if mine {
        if let Some(d) = value.get("delivery").and_then(Value::as_str).filter(|d| matches!(*d, "delivered" | "read")) {
            m.insert("delivery".into(), d.into());
        }
    }
    Some(Value::Object(m))
}

// ---- history ------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Cursor {
    pub c: String,
    pub t: f64,
    pub i: String,
}

impl Cursor {
    pub fn to_value(&self) -> Value {
        json!({"c": self.c, "t": num_value(self.t), "i": self.i})
    }
}

pub fn clean_cursor(value: &Value) -> Option<Cursor> {
    let c = value.get("c")?.as_str().filter(|c| is_address(c))?;
    let t = value.get("t")?.as_f64()?;
    let i = value.get("i")?.as_str().filter(|i| is_id(i))?;
    Some(Cursor { c: c.into(), t, i: i.into() })
}

fn by_time(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let ts = ts_of(a).partial_cmp(&ts_of(b)).unwrap_or(Equal);
    if ts != Equal {
        return ts;
    }
    let (ia, ib) =
        (a.get("id").and_then(Value::as_str).unwrap_or(""), b.get("id").and_then(Value::as_str).unwrap_or(""));
    if ia != ib {
        return ia.cmp(ib);
    }
    let (ma, mb) =
        (a.get("mine").and_then(Value::as_bool) == Some(true), b.get("mine").and_then(Value::as_bool) == Some(true));
    match (ma, mb) {
        (true, false) => Less,
        (false, true) => Greater,
        _ => Equal,
    }
}

pub struct Page {
    pub chats: Map<String, Value>,
    pub next: Option<Cursor>,
    pub count: usize,
}

/// `historyPage`: the next page after `after` in the canonical order (chat address, ts, id, mine),
/// at least one message per page. `next` is `None` when this was the last page.
pub fn history_page(chats: &Map<String, Value>, after: Option<&Cursor>, max_bytes: usize) -> Page {
    let mut out: Map<String, Value> = Map::new();
    let (mut size, mut count) = (0usize, 0usize);
    let mut last: Option<Cursor> = None;
    let mut peers: Vec<&String> = chats.keys().collect();
    peers.sort();
    for peer in peers {
        if after.is_some_and(|a| peer.as_str() < a.c.as_str()) {
            continue;
        }
        let mut list: Vec<&Value> = chats[peer].as_array().map(|l| l.iter().collect()).unwrap_or_default();
        list.sort_by(|a, b| by_time(a, b));
        for m in list {
            if let Some(a) = after {
                let (mts, mid) = (ts_of(m), m.get("id").and_then(Value::as_str).unwrap_or(""));
                if peer == &a.c && (mts < a.t || (mts == a.t && mid <= a.i.as_str())) {
                    continue;
                }
            }
            let bytes = serde_json::to_string(m).map_or(0, |s| s.len()) + 20;
            if count > 0 && size + bytes > max_bytes {
                return Page { chats: out, next: last, count };
            }
            out.entry(peer.clone())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("array")
                .push(m.clone());
            size += bytes;
            count += 1;
            last = Some(Cursor {
                c: peer.clone(),
                t: ts_of(m),
                i: m.get("id").and_then(Value::as_str).unwrap_or("").into(),
            });
        }
    }
    Page { chats: out, next: None, count }
}

/// Timestamp of the contact tombstone of `address`, or 0.
pub fn contact_tomb_ts(tombs: &[Tomb], address: &str) -> i64 {
    tombs.iter().filter(|t| t.kind == TombKind::Contact && t.chat == address).map(|t| t.ts).max().unwrap_or(0)
}
