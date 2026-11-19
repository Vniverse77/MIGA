//! Receive pipeline (ENGINE.md section 9) and send helpers on top of the store.
use crate::store::Store;
use crate::{now_ms, Error, Result};
use miga_core::crypto::pair_key;
use miga_core::identity::{is_address, Identity};
use miga_core::js::{js_trim, utf16_len};
use miga_core::payload::{apply_edit, decrypt, encrypt, encrypt_receipt, seal_json_with_nonce, text_json, MAX_TEXT};
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
        return Ok(out);
    }
    if let Some(edit) = &plain.edit {
        let mut list = store.chat(from)?;
        if apply_edit(&mut list, &edit.id, false, &edit.text, plain.ts, now_ms() as f64) {
            store.save_chat(from, &list)?;
            out.notes.push(format!("{} edited a message: {}", label(store, from), edit.text));
        }
        return Ok(out);
    }
    if !plain.ack.is_empty() || !plain.seen.is_empty() {
        for (ids, level) in [(&plain.ack, "delivered"), (&plain.seen, "read")] {
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
                    out.notes.push(format!("{} {level} message {}", label(store, from), &mid[..mid.len().min(8)]));
                }
            }
        }
        return Ok(out);
    }
    // An ordinary message. Unknown senders become contacts.
    let name = peer_name(plain.name.as_deref(), from);
    let placeholder = format!("{}...", &from[..8]);
    match store.contacts()?.iter().find(|c| c.address == from) {
        None => {
            store.upsert_contact(from, &name)?;
        }
        // Like the web app: a shared name replaces a placeholder, never a name the user typed.
        Some(c) if c.name == placeholder && name != placeholder => {
            store.upsert_contact(from, &name)?;
        }
        Some(_) => {}
    }
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
    store.merge(from, &[message])?;
    let contact_name = label(store, from);
    out.shown = Some(Shown {
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
    let text = js_trim(text);
    if text.is_empty() {
        return Err(Error::Invalid("nothing to send".into()));
    }
    if utf16_len(text) > MAX_TEXT {
        return Err(Error::Invalid(format!("message is longer than {MAX_TEXT} characters")));
    }
    let id = miga_core::random_id()?;
    let ts = now_ms();
    store.merge(peer, &[json!({"id": id, "mine": true, "text": text, "ts": ts, "state": "pending"})])?;
    let name = store.profile_name()?;
    let body = encrypt(me, peer, text, ts, name.as_deref(), None)?;
    Ok(Outgoing { id, body })
}

/// Re-encrypts a pending message for a resend (fresh nonce and `ts`, same id), like the web app.
pub fn reseal_pending(store: &Store, me: &Identity, peer: &str, message: &Value) -> Result<Outgoing> {
    let text = message["text"].as_str().unwrap_or_default();
    let name = store.profile_name()?;
    let body = seal_json_with_nonce(
        me,
        peer,
        &text_json(text, now_ms(), name.as_deref(), None, None),
        &miga_core::random_bytes::<24>()?,
    )?;
    Ok(Outgoing { id: message["id"].as_str().unwrap_or_default().into(), body })
}

/// A delivery receipt for the given ids.
pub fn delivery_receipt(me: &Identity, peer: &str, ids: &[String]) -> Result<String> {
    Ok(encrypt_receipt(me, peer, "ack", ids, now_ms())?)
}

/// Proves the pair key can be derived (a cheap address sanity check before connecting).
pub fn check_peer(me: &Identity, peer: &str) -> Result<()> {
    pair_key(me, peer).map(|_| ()).map_err(Error::from)
}
