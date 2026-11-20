//! Receive pipeline (ENGINE.md section 9) and send helpers on top of the store.
use crate::devices;
use crate::store::Store;
use crate::{now_ms, Error, Result};
use miga_core::crypto::pair_key;
use miga_core::identity::{is_address, Identity};
use miga_core::js::{js_trim, utf16_len};
use miga_core::payload::{
    apply_edit, clean_reply, decrypt, encrypt, encrypt_delete, encrypt_edit, encrypt_receipt, seal_json_with_nonce,
    text_json, Reply, MAX_TEXT,
};
use miga_core::sync::{Tomb, TombKind};
use serde_json::{json, Value};

/// What the caller should do after a `msg` frame was processed.
#[derive(Debug, Default, PartialEq)]
pub struct Handled {
    /// Acknowledge the message to the relay (it is stored, or deliberately dropped).
    pub ack: bool,
    /// A new ordinary message to show.
    pub shown: Option<Shown>,
    /// The id of a stored message we owe a delivery receipt for.
    pub receipt: Option<String>,
    /// Other things worth telling the user (edit, delete, receipt).
    pub notes: Vec<String>,
    /// Sync messages for the other devices (`None` = all of them).
    pub forward: Vec<(Option<String>, Value)>,
}

#[derive(Debug, PartialEq)]
pub struct Shown {
    pub from: String,
    pub name: String,
    pub id: String,
    pub text: String,
    pub ts: f64,
    pub has_attachment: bool,
}

/// Cleans a name received from a peer the way `ensureContact` does (trim, collapse, 40 units).
fn peer_name(name: Option<&str>, from: &str) -> String {
    let cleaned = miga_core::payload::clean_name(&Value::from(name.unwrap_or_default()));
    if cleaned.is_empty() {
        format!("{}...", &from[..8])
    } else {
        cleaned
    }
}

/// Processes one `msg` frame: decrypt, classify, store, and say what to do next.
pub fn handle_incoming(
    store: &Store,
    me: &Identity,
    from: &str,
    id: &str,
    body: &str,
    relay_ts: f64,
) -> Result<Handled> {
    let mut out = Handled { ack: true, ..Handled::default() };
    if store.addresses("blocked").iter().any(|b| b == from) {
        return Ok(out);
    }
    let Some(plain) = decrypt(me, from, body, now_ms() as f64) else { return Ok(out) };
    if plain.live.is_some() {
        return Ok(out);
    }
    if !plain.del.is_empty() {
        let mut list = store.chat(from)?;
        let before = list.len();
        list.retain(|m| !(m["mine"] == false && plain.del.iter().any(|d| m["id"] == d.as_str())));
        if list.len() != before {
            store.save_chat(from, &list)?;
            out.notes.push(format!("{} deleted {} message(s)", label(store, from), before - list.len()));
        }
        let now = now_ms();
        let items: Vec<Tomb> = plain
            .del
            .iter()
            .map(|id| Tomb { chat: from.into(), kind: TombKind::Message, id: Some(id.clone()), mine: false, ts: now })
            .collect();
        out.forward.extend(devices::remember_deletes(store, &items)?);
        return Ok(out);
    }
    if let Some(edit) = &plain.edit {
        let mut list = store.chat(from)?;
        if apply_edit(&mut list, &edit.id, false, &edit.text, plain.ts, now_ms() as f64) {
            store.save_chat(from, &list)?;
            out.forward.push((
                None,
                json!({"k": "edit", "peer": from, "id": edit.id, "mine": false, "text": edit.text, "ts": plain.ts}),
            ));
            out.notes.push(format!("{} edited a message: {}", label(store, from), edit.text));
        }
        return Ok(out);
    }
    if !plain.ack.is_empty() || !plain.seen.is_empty() {
        for (ids, level) in [(&plain.ack, "delivered"), (&plain.seen, "read")] {
            // Like the app: with read receipts off nobody else's are shown either.
            if level == "read" && !store.receipts_on() {
                continue;
            }
            let mut changed_ids = Vec::new();
            for mid in ids.iter() {
                let rank = |d: Option<&str>| match d {
                    Some("delivered") => 1,
                    Some("read") => 2,
                    _ => 0,
                };
                let changed = store.update_own(from, mid, |m| {
                    if rank(Some(level)) > rank(m["delivery"].as_str()) {
                        m["delivery"] = level.into();
                    }
                    if m["state"] == "pending" {
                        m["state"] = "sent".into();
                    }
                })?;
                if changed {
                    changed_ids.push(mid.clone());
                    out.notes.push(format!("{} {level} message {}", label(store, from), &mid[..mid.len().min(8)]));
                }
            }
            if !changed_ids.is_empty() {
                out.forward.push((None, json!({"k": "st", "peer": from, "ids": changed_ids, "d": level})));
            }
        }
        return Ok(out);
    }
    // Deleted earlier (a re-delivery after "delete for me"): acknowledged and dropped.
    let all_tombs = devices::tombs(store);
    if miga_core::sync::tomb_filter(&all_tombs)(from, id, false, relay_ts) {
        return Ok(out);
    }
    devices::revive_contact(store, from, relay_ts)?;
    // An ordinary message. Unknown senders become contacts; a shared name never replaces a typed one.
    let _ = peer_name;
    devices::ensure_contact(store, from, plain.name.as_deref())?;
    let ts = if relay_ts.is_finite() { relay_ts } else { f64::NAN };
    let mut message = json!({
        "id": id, "mine": false, "text": miga_core::js::slice_units_lossy(&plain.text, MAX_TEXT), "ts": miga_core::js::num_value(ts),
        "state": "received",
    });
    if let Some(r) = &plain.reply {
        message["reply"] = r.to_value();
    }
    if let Some(a) = &plain.att {
        message["att"] = a.to_value();
    }
    let added = store.merge(from, std::slice::from_ref(&message))?;
    if added {
        out.forward.push((None, json!({"k": "msg", "peer": from, "message": message, "name": plain.name})));
    }
    let contact_name = label(store, from);
    out.shown = added.then(|| Shown {
        from: from.into(),
        name: contact_name,
        id: id.into(),
        text: plain.text.clone(),
        ts,
        has_attachment: plain.att.is_some(),
    });
    out.receipt = Some(id.into());
    Ok(out)
}

fn label(store: &Store, address: &str) -> String {
    store
        .contacts()
        .ok()
        .and_then(|l| l.into_iter().find(|c| c.address == address))
        .map_or_else(|| format!("{}...", &address[..8]), |c| c.name)
}

/// Validates a typed address: trim, lowercase, `isAddress`, not our own.
pub fn parse_address(me: &Identity, input: &str) -> Result<String> {
    let a = js_trim(input).to_lowercase();
    if !is_address(&a) {
        return Err(Error::Invalid("that is not a valid MIGA address".into()));
    }
    if a == me.address() {
        return Err(Error::Invalid("that is your own address".into()));
    }
    Ok(a)
}

/// A message ready to send: the stored copy (state `pending`) and the wire frame fields.
pub struct Outgoing {
    pub id: String,
    pub body: String,
}

/// Validates the text, persists a pending message, and builds the encrypted body.
pub fn prepare_text(store: &Store, me: &Identity, peer: &str, text: &str) -> Result<Outgoing> {
    prepare_message(store, me, peer, text, None)
}

/// Like [`prepare_text`], optionally quoting an earlier message (`reply`).
pub fn prepare_message(
    store: &Store,
    me: &Identity,
    peer: &str,
    text: &str,
    reply: Option<&Reply>,
) -> Result<Outgoing> {
    let text = js_trim(text);
    if text.is_empty() {
        return Err(Error::Invalid("nothing to send".into()));
    }
    if utf16_len(text) > MAX_TEXT {
        return Err(Error::Invalid(format!("message is longer than {MAX_TEXT} characters")));
    }
    let id = miga_core::random_id()?;
    let ts = now_ms();
    let mut message = json!({"id": id, "mine": true, "text": text, "ts": ts, "state": "pending"});
    if let Some(r) = reply {
        message["reply"] = r.to_value();
    }
    store.merge(peer, &[message])?;
    let name = store.profile_name()?;
    let body = encrypt(me, peer, text, ts, name.as_deref(), reply)?;
    Ok(Outgoing { id, body })
}

/// A message carrying an uploaded file: persisted as pending (the caption is its text).
pub fn prepare_attachment(
    store: &Store,
    me: &Identity,
    peer: &str,
    caption: &str,
    att: &miga_core::attach::Att,
) -> Result<Outgoing> {
    let caption = miga_core::js::slice_units_lossy(js_trim(caption), MAX_TEXT);
    let id = miga_core::random_id()?;
    let ts = now_ms();
    let message = json!({"id": id, "mine": true, "text": caption, "ts": ts, "state": "pending", "att": att.to_value()});
    store.merge(peer, &[message])?;
    let name = store.profile_name()?;
    let body = seal_json_with_nonce(
        me,
        peer,
        &text_json(&caption, ts, name.as_deref(), None, Some(att)),
        &miga_core::random_bytes::<24>()?,
    )?;
    Ok(Outgoing { id, body })
}

/// Re-encrypts a pending message for a resend (fresh nonce and `ts`, same id), like the web app.
pub fn reseal_pending(store: &Store, me: &Identity, peer: &str, message: &Value) -> Result<Outgoing> {
    let text = message["text"].as_str().unwrap_or_default();
    let name = store.profile_name()?;
    let reply = message.get("reply").and_then(clean_reply);
    let att = message.get("att").and_then(|a| miga_core::attach::clean_att(a, true));
    let body = seal_json_with_nonce(
        me,
        peer,
        &text_json(text, now_ms(), name.as_deref(), reply.as_ref(), att.as_ref()),
        &miga_core::random_bytes::<24>()?,
    )?;
    Ok(Outgoing { id: message["id"].as_str().unwrap_or_default().into(), body })
}

/// A control frame (edit or delete) ready to go out; apply the change locally once the relay says `sent`.
pub struct Control {
    /// Id of the relay frame (not the message id).
    pub frame_id: String,
    pub body: String,
    /// The cleaned text for an edit.
    pub text: String,
    pub ts: i64,
}

/// Validates an edit of one of our own messages (ENGINE.md section 9, "Edit (sender)").
pub fn prepare_edit(me: &Identity, peer: &str, id: &str, text: &str) -> Result<Control> {
    let text = js_trim(text);
    if text.is_empty() {
        return Err(Error::Invalid("an edited message cannot be empty".into()));
    }
    if utf16_len(text) > MAX_TEXT {
        return Err(Error::Invalid(format!("message is longer than {MAX_TEXT} characters")));
    }
    let ts = now_ms();
    Ok(Control {
        frame_id: miga_core::random_id()?,
        body: encrypt_edit(me, peer, id, text, ts)?,
        text: text.to_string(),
        ts,
    })
}

/// A "delete for everyone" request for one of our own messages.
pub fn prepare_delete(me: &Identity, peer: &str, id: &str) -> Result<Control> {
    let ts = now_ms();
    Ok(Control {
        frame_id: miga_core::random_id()?,
        body: encrypt_delete(me, peer, std::slice::from_ref(&id.to_string()), ts)?,
        text: String::new(),
        ts,
    })
}

/// Applies a confirmed edit of our own message. `ts` must be larger than any earlier edit.
pub fn apply_own_edit(store: &Store, peer: &str, id: &str, text: &str, ts: i64) -> Result<bool> {
    let mut list = store.chat(peer)?;
    let ok = apply_edit(&mut list, id, true, text, ts as f64, now_ms() as f64);
    if ok {
        store.save_chat(peer, &list)?;
    }
    Ok(ok)
}

/// Removes one of our own messages after the delete request was accepted.
pub fn apply_own_delete(store: &Store, peer: &str, id: &str) -> Result<bool> {
    let mut list = store.chat(peer)?;
    let before = list.len();
    list.retain(|m| !(m["mine"] == true && m["id"] == id));
    let removed = list.len() != before;
    if removed {
        store.save_chat(peer, &list)?;
    }
    Ok(removed)
}

/// A read receipt (`seen`) for the given ids.
pub fn seen_receipt(me: &Identity, peer: &str, ids: &[String]) -> Result<String> {
    Ok(encrypt_receipt(me, peer, "seen", ids, now_ms())?)
}

/// A delivery receipt for the given ids.
pub fn delivery_receipt(me: &Identity, peer: &str, ids: &[String]) -> Result<String> {
    Ok(encrypt_receipt(me, peer, "ack", ids, now_ms())?)
}

/// Proves the pair key can be derived (a cheap address sanity check before connecting).
pub fn check_peer(me: &Identity, peer: &str) -> Result<()> {
    pair_key(me, peer).map(|_| ()).map_err(Error::from)
}
