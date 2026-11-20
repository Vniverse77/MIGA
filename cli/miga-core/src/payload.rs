//! Payload JSON: validators (`clean*`), receive classification (`decrypt`) and the sender side
//! (`encrypt*`) of ENGINE.md section 6.
use crate::attach::{clean_att, Att};
use crate::crypto::{open, pair_key, seal, seal_with_nonce, NONCE_LEN};
use crate::identity::{is_address, Identity};
use crate::js::{
    is_id, is_js_space_unit, js_number, js_trim, num_value, sanitize_lone_surrogates, slice_units_lossy, trim_units,
    units, utf16_len,
};
use crate::Result;
use serde_json::{json, Map, Value};

/// Longest text of a message, caption, edit or live frame (UTF-16 units).
pub const MAX_TEXT: usize = 4000;
/// Most ids in one delete request or receipt.
pub const MAX_DELETE: usize = 50;
/// Reply preview length in code points.
pub const REPLY_PREVIEW: usize = 120;
/// Old-client fallback text of an attachment message.
pub const ATT_PLACEHOLDER: &str = "[photo \u{2014} update MIGA to view]";

#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub id: String,
    pub from: String,
    pub text: String,
}

impl Reply {
    pub fn to_value(&self) -> Value {
        json!({"id": self.id, "from": self.from, "text": self.text})
    }
}

/// What `decrypt` returns, mirroring the TypeScript `Plain`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plain {
    pub text: String,
    pub ts: f64,
    pub name: Option<String>,
    pub reply: Option<Reply>,
    pub att: Option<Att>,
    pub del: Vec<String>,
    pub edit: Option<Edit>,
    /// Live typing text (ephemeral); `Some("")` means cleared.
    pub live: Option<String>,
    pub ack: Vec<String>,
    pub seen: Vec<String>,
}

impl Plain {
    /// The JSON shape the vectors use for `expect`.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("text".into(), self.text.clone().into());
        if let Some(att) = &self.att {
            m.insert("att".into(), att.to_value());
        }
        m.insert("ts".into(), num_value(self.ts));
        if let Some(n) = &self.name {
            m.insert("name".into(), n.clone().into());
        }
        if let Some(r) = &self.reply {
            m.insert("reply".into(), r.to_value());
        }
        if !self.del.is_empty() {
            m.insert("del".into(), json!(self.del));
        }
        if let Some(e) = &self.edit {
            m.insert("edit".into(), json!({"id": e.id, "text": e.text}));
        }
        if let Some(l) = &self.live {
            m.insert("live".into(), l.clone().into());
        }
        if !self.ack.is_empty() {
            m.insert("ack".into(), json!(self.ack));
        }
        if !self.seen.is_empty() {
            m.insert("seen".into(), json!(self.seen));
        }
        Value::Object(m)
    }
}

// ---- validators ---------------------------------------------------------------------------

/// `cleanIds`: strings matching the id pattern, deduplicated, at most 50.
pub fn clean_ids(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(list) = value.as_array() {
        for id in list.iter().filter_map(Value::as_str).filter(|s| is_id(s)) {
            if !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        }
    }
    out.truncate(MAX_DELETE);
    out
}

/// `cleanEdit`: the length limit is checked BEFORE trimming.
pub fn clean_edit(value: &Value) -> Option<Edit> {
    let id = value.get("id")?.as_str().filter(|s| is_id(s))?;
    let text = value.get("text")?.as_str().filter(|t| utf16_len(t) <= MAX_TEXT)?;
    let text = js_trim(text);
    (!text.is_empty()).then(|| Edit { id: id.to_string(), text: text.to_string() })
}

/// The preview text of a reply as UTF-16 units: `text.slice(0, 2000)`, trim, first line, trim,
/// first 120 code points. A cut can leave a lone surrogate, hence units.
pub fn reply_preview_units(text: &str) -> Vec<u16> {
    let mut u = units(text);
    u.truncate(2000);
    let t = trim_units(&u);
    let end = match t.iter().position(|&c| c == 0x0A) {
        Some(i) if i > 0 && t[i - 1] == 0x0D => i - 1,
        Some(i) => i,
        None => t.len(),
    };
    let line = trim_units(&t[..end]);
    let (mut count, mut i) = (0, 0);
    while i < line.len() && count < REPLY_PREVIEW {
        let pair = (0xD800..0xDC00).contains(&line[i]) && line.get(i + 1).is_some_and(|l| (0xDC00..0xE000).contains(l));
        i += if pair { 2 } else { 1 };
        count += 1;
    }
    line[..i].to_vec()
}

/// `cleanReply` with the preview as units; see [`clean_reply`] for the `String` form.
pub fn clean_reply_units(value: &Value) -> Option<(String, String, Vec<u16>)> {
    let id = value.get("id")?.as_str().filter(|s| is_id(s))?;
    let from = value.get("from")?.as_str().filter(|s| is_address(s))?;
    let text = value.get("text")?.as_str()?;
    let preview = reply_preview_units(text);
    (!preview.is_empty()).then(|| (id.to_string(), from.to_string(), preview))
}

pub fn clean_reply(value: &Value) -> Option<Reply> {
    let (id, from, text) = clean_reply_units(value)?;
    Some(Reply { id, from, text: String::from_utf16_lossy(&text) })
}

/// `cleanName` as units: trim, collapse whitespace runs to one space, `slice(0, 40)`.
pub fn clean_name_units(value: &Value) -> Vec<u16> {
    let Some(s) = value.as_str() else { return Vec::new() };
    let u = units(s);
    let t = trim_units(&u);
    let mut out = Vec::with_capacity(t.len());
    let mut in_space = false;
    for &c in t {
        if is_js_space_unit(c) {
            if !in_space {
                out.push(0x20);
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out.truncate(40);
    out
}

pub fn clean_name(value: &Value) -> String {
    String::from_utf16_lossy(&clean_name_units(value))
}

/// `editTime`: a valid positive number, at most `now + 24 h`; otherwise `now`.
pub fn edit_time(ts: f64, now: f64) -> f64 {
    if ts.is_finite() && ts > 0.0 {
        ts.min(now + 86_400_000.0)
    } else {
        now
    }
}

// ---- receive ------------------------------------------------------------------------------

/// `decrypt()` of the web client. `now` is `Date.now()` in ms. `None` means "unreadable".
pub fn decrypt(me: &Identity, peer: &str, body: &str, now: f64) -> Option<Plain> {
    let key = pair_key(me, peer).ok()?;
    let padded = open(&key, body, b"")?;
    classify(&parse_plaintext(&padded)?, now)
}

/// UTF-8 (lossy, BOM stripped like `TextDecoder`) then `JSON.parse`.
pub fn parse_plaintext(bytes: &[u8]) -> Option<Value> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(&sanitize_lone_surrogates(&text)).ok()
}

/// The classification rules of ENGINE.md section 6, in order.
pub fn classify(parsed: &Value, now: f64) -> Option<Plain> {
    if parsed.get("v").and_then(Value::as_f64) != Some(0.0) {
        return None;
    }
    let ts_raw = js_number(parsed.get("ts"));
    let ts = if ts_raw.is_nan() || ts_raw == 0.0 { now } else { ts_raw };
    let Some(text) = parsed.get("text").and_then(Value::as_str) else {
        let mut p = Plain { ts, ..Plain::default() };
        let del = clean_ids(parsed.get("del").unwrap_or(&Value::Null));
        if !del.is_empty() {
            p.del = del;
            return Some(p);
        }
        if let Some(edit) = parsed.get("edit").and_then(clean_edit) {
            p.edit = Some(edit);
            return Some(p);
        }
        if let Some(live) = parsed.get("live").and_then(|l| l.get("text")).and_then(Value::as_str) {
            p.live = Some(slice_units_lossy(live, MAX_TEXT));
            return Some(p);
        }
        p.ack = clean_ids(parsed.get("ack").unwrap_or(&Value::Null));
        p.seen = clean_ids(parsed.get("seen").unwrap_or(&Value::Null));
        return (!p.ack.is_empty() || !p.seen.is_empty()).then_some(p);
    };
    let att = match parsed.get("att") {
        None => None,
        Some(a) => Some(clean_att(a, false)?),
    };
    let shown = if att.is_some() {
        parsed.get("cap").and_then(Value::as_str).map(|c| slice_units_lossy(c, MAX_TEXT)).unwrap_or_default()
    } else {
        text.to_string()
    };
    Some(Plain {
        text: shown,
        ts,
        att,
        name: parsed.get("name").and_then(Value::as_str).map(str::to_string),
        reply: parsed.get("reply").and_then(clean_reply),
        ..Plain::default()
    })
}

// ---- send ---------------------------------------------------------------------------------

fn seal_json(me: &Identity, peer: &str, value: &Value) -> Result<String> {
    seal(&pair_key(me, peer)?, serde_json::to_string(value).expect("a Value always serializes").as_bytes(), b"")
}

/// Same as [`seal_json`] with a chosen nonce (test hook).
pub fn seal_json_with_nonce(me: &Identity, peer: &str, value: &Value, nonce: &[u8; NONCE_LEN]) -> Result<String> {
    Ok(seal_with_nonce(
        &pair_key(me, peer)?,
        nonce,
        serde_json::to_string(value).expect("a Value always serializes").as_bytes(),
        b"",
    ))
}

/// The plaintext JSON of an ordinary message (ENGINE.md 6.1). Key order matches the web client.
pub fn text_json(text: &str, ts: i64, name: Option<&str>, reply: Option<&Reply>, att: Option<&Att>) -> Value {
    let mut m = Map::new();
    m.insert("v".into(), 0.into());
    if let Some(att) = att {
        let wire = if text.is_empty() { ATT_PLACEHOLDER.to_string() } else { format!("{text}\n{ATT_PLACEHOLDER}") };
        m.insert("text".into(), wire.into());
        m.insert("cap".into(), text.into());
        m.insert("att".into(), att.to_value_without_delete());
    } else {
        m.insert("text".into(), text.into());
    }
    m.insert("ts".into(), ts.into());
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        m.insert("name".into(), n.into());
    }
    if let Some(r) = reply {
        m.insert("reply".into(), r.to_value());
    }
    Value::Object(m)
}

pub fn encrypt(
    me: &Identity,
    peer: &str,
    text: &str,
    ts: i64,
    name: Option<&str>,
    reply: Option<&Reply>,
) -> Result<String> {
    seal_json(me, peer, &text_json(text, ts, name, reply, None))
}

pub fn delete_json(ts: i64, ids: &[String]) -> Value {
    json!({"v": 0, "ts": ts, "del": clean_ids(&json!(ids))})
}

pub fn edit_json(ts: i64, id: &str, text: &str) -> Value {
    json!({"v": 0, "ts": ts, "edit": {"id": id, "text": text}})
}

/// `kind` is `"ack"` (stored) or `"seen"` (read).
pub fn receipt_json(ts: i64, kind: &str, ids: &[String]) -> Value {
    let mut m = Map::new();
    m.insert("v".into(), 0.into());
    m.insert("ts".into(), ts.into());
    m.insert(kind.into(), json!(clean_ids(&json!(ids))));
    Value::Object(m)
}

pub fn live_json(ts: i64, text: &str) -> Value {
    json!({"v": 0, "ts": ts, "live": {"text": slice_units_lossy(text, MAX_TEXT)}})
}

pub fn encrypt_receipt(me: &Identity, peer: &str, kind: &str, ids: &[String], ts: i64) -> Result<String> {
    seal_json(me, peer, &receipt_json(ts, kind, ids))
}

pub fn encrypt_delete(me: &Identity, peer: &str, ids: &[String], ts: i64) -> Result<String> {
    seal_json(me, peer, &delete_json(ts, ids))
}

pub fn encrypt_edit(me: &Identity, peer: &str, id: &str, text: &str, ts: i64) -> Result<String> {
    seal_json(me, peer, &edit_json(ts, id, text))
}

pub fn encrypt_live(me: &Identity, peer: &str, text: &str, ts: i64) -> Result<String> {
    seal_json(me, peer, &live_json(ts, text))
}

/// Applies an edit to the message `(mine, id)` of `list` (ENGINE.md section 9, `applyEdit`).
pub fn apply_edit(list: &mut [Value], id: &str, mine: bool, text: &str, ts: f64, now: f64) -> bool {
    let Some(clean) = clean_edit(&json!({"id": id, "text": text})) else { return false };
    let ts = edit_time(ts, now);
    let Some(target) = list.iter_mut().find(|m| {
        m.get("mine").and_then(Value::as_bool) == Some(mine) && m.get("id").and_then(Value::as_str) == Some(&clean.id)
    }) else {
        return false;
    };
    let edited = target.get("edited").and_then(Value::as_f64).unwrap_or(0.0);
    if ts <= edited {
        return false;
    }
    target["edited"] = num_value(ts);
    if target.get("text").and_then(Value::as_str) != Some(&clean.text) {
        target["text"] = clean.text.into();
    }
    true
}
