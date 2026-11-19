//! Checks every case of every file in `protocol/test-vectors/` (generated from the TypeScript
//! client). Decrypt, re-encrypt with the stored nonce (byte-identical), validators, negatives.
//!
//! Lone UTF-16 surrogates (`\udXXX` in validators.json) cannot live in a Rust `String`; the
//! loader maps each to a private-use character U+F000 + (unit - 0xD800), which counts as one
//! unit and one code point exactly like the lone surrogate does. Functions that can produce a
//! lone surrogate return UTF-16 units and are compared after mapping back.
use miga_core::attach::{chunk_nonce, clean_att, decrypt_file, encrypt_file_with, CHUNK};
use miga_core::crypto::{envelope_nonce, group_safety, open, pad, pair_key, safety_number, seal_with_nonce, sync_key};
use miga_core::identity::{address_to_montgomery, is_address, x25519_secret_from_seed, Identity};
use miga_core::js::{is_js_space_unit, js_number, utf16_len};
use miga_core::link::{
    accept_bundle, derive_link, format_link_code, normalize_link_code, open_value, seal_value_with_nonce, sync_aad,
    ALPHABET,
};
use miga_core::payload::{
    apply_edit, clean_edit, clean_ids, clean_name_units, clean_reply_units, decrypt, delete_json, edit_json, edit_time,
    live_json, parse_plaintext, receipt_json, text_json, Reply, MAX_TEXT,
};
use miga_core::sync::{
    add_tombs, clean_cursor, clean_message, clean_tombs, history_page, merge_messages, tomb_filter, Cursor, Tomb,
};
use miga_core::{from_hex, from_hex_array, to_hex};
use serde_json::{Map, Value};
use std::path::PathBuf;

const NOW: f64 = 1_700_000_000_000.0;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/test-vectors")
}

/// Loads a vector file; lone surrogate escapes become private-use characters (see module docs).
fn load(name: &str) -> Value {
    let text = std::fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    let lower = text.to_ascii_lowercase();
    for hi in 0xf0..=0xf7u32 {
        assert!(
            !lower.contains(&format!("\\u{hi:02x}")),
            "{name}: file uses the private-use range the loader reserves"
        );
    }
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut last) = (0, 0);
    let hex4 = |at: usize| u32::from_str_radix(&text[at..at + 4], 16).ok();
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        if b.get(i + 1) == Some(&b'u') {
            let u = hex4(i + 2).expect("hex escape");
            if (0xD800..0xDC00).contains(&u) {
                let paired = b.get(i + 6) == Some(&b'\\')
                    && b.get(i + 7) == Some(&b'u')
                    && hex4(i + 8).is_some_and(|l| (0xDC00..0xE000).contains(&l));
                if paired {
                    i += 12;
                } else {
                    out.push_str(&text[last..i]);
                    out.push_str(&format!("\\u{:04x}", 0xF000 + (u - 0xD800)));
                    i += 6;
                    last = i;
                }
                continue;
            }
            if (0xDC00..0xE000).contains(&u) {
                out.push_str(&text[last..i]);
                out.push_str(&format!("\\u{:04x}", 0xF000 + (u - 0xD800)));
                i += 6;
                last = i;
                continue;
            }
            i += 6;
        } else {
            i += 2;
        }
    }
    out.push_str(&text[last..]);
    serde_json::from_str(&out).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Maps private-use stand-ins back to lone surrogates.
fn norm(units: impl IntoIterator<Item = u16>) -> Vec<u16> {
    units.into_iter().map(|u| if (0xF000..0xF800).contains(&u) { u - 0xF000 + 0xD800 } else { u }).collect()
}

fn units_of(s: &str) -> Vec<u16> {
    norm(s.encode_utf16())
}

struct Counter(usize);
impl Counter {
    fn ok(&mut self, cond: bool, what: impl FnOnce() -> String) {
        self.0 += 1;
        assert!(cond, "{}", what());
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing string {k} in {v}"))
}

fn ident(seed: &str) -> Identity {
    Identity::from_seed_hex(seed).expect("seed")
}

fn cases<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key].as_array().unwrap_or_else(|| panic!("no array {key}"))
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().expect("array")
}

#[test]
fn all_vectors() {
    let mut c = Counter(0);
    identity_auth_pair_safety(&mut c);
    addresses(&mut c);
    envelopes(&mut c);
    padding(&mut c);
    validators(&mut c);
    links_and_sync_seal(&mut c);
    files(&mut c);
    sync_logic(&mut c);
    println!("vector checks passed: {}", c.0);
}

fn identity_auth_pair_safety(c: &mut Counter) {
    for case in cases(&load("identity.json"), "cases") {
        let name = s(case, "name");
        let seed: [u8; 32] = from_hex_array(s(case, "seed")).unwrap();
        let id = Identity::from_seed(seed);
        c.ok(id.address() == s(case, "address"), || format!("identity {name}: address"));
        let (first, clamped) = x25519_secret_from_seed(&seed);
        c.ok(to_hex(&first) == s(case, "sha512_first32"), || format!("identity {name}: sha512"));
        c.ok(to_hex(&*clamped) == s(case, "x25519_secret"), || format!("identity {name}: x25519 secret"));
        let public = address_to_montgomery(id.address()).map(|u| to_hex(&u));
        c.ok(public.as_deref() == Some(s(case, "x25519_public")), || format!("identity {name}: x25519 public"));
        c.ok(is_address(id.address()) == case["is_address"].as_bool().unwrap(), || {
            format!("identity {name}: is_address")
        });
    }
    for case in cases(&load("auth.json"), "cases") {
        let id = ident(s(case, "seed"));
        c.ok(id.address() == s(case, "address"), || "auth address".into());
        c.ok(id.sign_auth(s(case, "nonce")) == s(case, "signature"), || "auth signature".into());
    }
    for case in cases(&load("pair-key.json"), "cases") {
        let me = ident(s(case, "seed"));
        let peer = s(case, "peer");
        let shared = me.shared_secret(peer).expect("shared secret");
        c.ok(to_hex(&*shared) == s(case, "shared"), || "pair shared".into());
        let mut both = [me.address(), peer];
        both.sort_unstable();
        c.ok(both.concat() == s(case, "info"), || "pair info".into());
        c.ok(to_hex(&pair_key(&me, peer).unwrap()) == s(case, "key"), || "pair key".into());
    }
    for case in cases(&load("safety.json"), "cases") {
        let n = safety_number(s(case, "mine"), s(case, "theirs")).unwrap();
        c.ok(n == s(case, "number"), || "safety number".into());
        c.ok(group_safety(&n) == s(case, "grouped"), || "safety grouped".into());
    }
}

fn addresses(c: &mut Counter) {
    for case in cases(&load("address.json"), "cases") {
        let (name, input) = (s(case, "name"), s(case, "input"));
        c.ok(is_address(input) == case["valid"].as_bool().unwrap(), || format!("address {name}"));
    }
}

fn envelopes(c: &mut Counter) {
    for file in ["envelope.json", "envelope-raw.json"] {
        for case in cases(&load(file), "cases") {
            let name = s(case, "name");
            let recipient = ident(s(case, "recipient_seed"));
            let sender = ident(s(case, "sender_seed"));
            let (sender_addr, body) = (s(case, "sender"), s(case, "body"));
            let got = decrypt(&recipient, sender_addr, body, NOW).map(|p| p.to_value()).unwrap_or(Value::Null);
            c.ok(got == case["expect"], || format!("{file} {name}: decrypt\n got {got}\n want {}", case["expect"]));
            // The sender reads its own message with the same key.
            let back = decrypt(&sender, s(case, "recipient"), body, NOW).map(|p| p.to_value()).unwrap_or(Value::Null);
            c.ok(back == case["expect"], || format!("{file} {name}: sender decrypt"));
            let key = pair_key(&recipient, sender_addr).unwrap();
            let padded = open(&key, body, b"").expect("opens");
            let plaintext = s(case, "plaintext");
            let unpadded = name == "no_padding_still_opens";
            c.ok(unpadded || padded.len() % 256 == 0, || format!("{file} {name}: padding multiple"));
            c.ok(
                padded.starts_with(plaintext.as_bytes()) && padded[plaintext.len()..].iter().all(|&b| b == 0x20),
                || format!("{file} {name}: plaintext"),
            );
            let nonce: [u8; 24] = from_hex_array(s(case, "nonce")).unwrap();
            c.ok(envelope_nonce(body) == Some(nonce), || format!("{file} {name}: nonce"));
            if !unpadded {
                let again = seal_with_nonce(&key, &nonce, plaintext.as_bytes(), b"");
                c.ok(again == body, || format!("{file} {name}: re-encrypt is byte identical"));
            }
            if s(case, "source") == "real" {
                real_builders(c, case, &sender, name);
            }
        }
    }
    for case in cases(&load("envelope-negative.json"), "cases") {
        let name = s(case, "name");
        let me = ident(s(case, "recipient_seed"));
        let got =
            decrypt(&me, s(case, "claimed_sender"), s(case, "body"), NOW).map(|p| p.to_value()).unwrap_or(Value::Null);
        c.ok(got == case["expect"], || format!("negative {name}: {got}"));
    }
}

/// For vectors made by the app's own encrypt functions the Rust builders must produce the very
/// same plaintext JSON (key order included).
fn real_builders(c: &mut Counter, case: &Value, sender: &Identity, name: &str) {
    let e = &case["expect"];
    let Some(ts) = e["ts"].as_i64() else { return };
    let peer = s(case, "recipient");
    let reply =
        e.get("reply").map(|r| Reply { id: s(r, "id").into(), from: s(r, "from").into(), text: s(r, "text").into() });
    let ids = |k: &str| e[k].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>());
    let built = if name.starts_with("text_") && !name.contains("over_limit") && name != "text_empty_name_ignored" {
        Some(text_json(s(e, "text"), ts, e.get("name").and_then(Value::as_str), reply.as_ref(), None))
    } else if name == "text_empty_name_ignored" {
        Some(text_json(s(e, "text"), ts, Some(""), None, None))
    } else if name.starts_with("att_") {
        let att = clean_att(&e["att"], false).unwrap();
        Some(text_json(s(e, "text"), ts, e.get("name").and_then(Value::as_str), reply.as_ref(), Some(&att)))
    } else if name == "delete_one" || name == "delete_dedup_invalid" {
        Some(delete_json(ts, &ids("del").unwrap()))
    } else if name == "edit" || name == "edit_default_ts" {
        Some(edit_json(ts, s(&e["edit"], "id"), s(&e["edit"], "text")))
    } else if name == "ack" {
        Some(receipt_json(ts, "ack", &ids("ack").unwrap()))
    } else if name == "seen" {
        Some(receipt_json(ts, "seen", &ids("seen").unwrap()))
    } else if name == "live_text" || name == "live_cleared" {
        Some(live_json(ts, s(e, "live")))
    } else {
        None
    };
    if let Some(v) = built {
        let json = serde_json::to_string(&v).unwrap();
        c.ok(json == s(case, "plaintext"), || {
            format!("real {name}: builder JSON\n got  {json}\n want {}", s(case, "plaintext"))
        });
        let key = pair_key(sender, peer).unwrap();
        let nonce: [u8; 24] = from_hex_array(s(case, "nonce")).unwrap();
        c.ok(seal_with_nonce(&key, &nonce, json.as_bytes(), b"") == s(case, "body"), || {
            format!("real {name}: builder body")
        });
    }
}

fn padding(c: &mut Counter) {
    let ids = load("identity.json");
    let id = &ids["cases"];
    let me = ident(s(&id[2], "seed"));
    let key = pair_key(&me, s(&id[3], "address")).unwrap();
    for case in cases(&load("padding.json"), "cases") {
        let (filler, target) = (s(case, "filler"), case["target_json_bytes"].as_u64().unwrap());
        let body = s(case, "body");
        let padded = open(&key, body, b"").expect("opens");
        let json_bytes = case["json_bytes"].as_u64().unwrap() as usize;
        c.ok(padded.len() == case["padded_len"].as_u64().unwrap() as usize, || {
            format!("padding {filler} {target}: padded_len")
        });
        c.ok(padded.len() == json_bytes.div_ceil(256) * 256, || format!("padding {filler} {target}: multiple"));
        let json = &padded[..json_bytes];
        c.ok(padded[json_bytes..].iter().all(|&b| b == 0x20) && json.last() == Some(&b'}'), || {
            format!("padding {filler} {target}: spaces")
        });
        c.ok(pad(json) == padded, || format!("padding {filler} {target}: pad()"));
        let nonce: [u8; 24] = from_hex_array(s(case, "nonce")).unwrap();
        c.ok(seal_with_nonce(&key, &nonce, json, b"") == body, || format!("padding {filler} {target}: re-encrypt"));
        c.ok(body.len() == case["body_base64_len"].as_u64().unwrap() as usize, || {
            format!("padding {filler} {target}: base64 length")
        });
    }
}

fn validators(c: &mut Counter) {
    let v = load("validators.json");
    let consts = &v["constants"];
    c.ok(consts["MAX_TEXT"] == MAX_TEXT, || "const MAX_TEXT".into());
    c.ok(consts["CHUNK"] == CHUNK, || "const CHUNK".into());
    c.ok(consts["ATT_PLACEHOLDER"] == miga_core::payload::ATT_PLACEHOLDER, || "const placeholder".into());
    c.ok(consts["LINK_TTL_MS"] == miga_core::link::LINK_TTL_MS, || "const link ttl".into());

    let listed: Vec<u16> = cases(&v, "js_whitespace_code_units").iter().map(|u| u.as_u64().unwrap() as u16).collect();
    let actual: Vec<u16> = (0..=u16::MAX).filter(|&u| is_js_space_unit(u)).collect();
    c.ok(listed == actual, || format!("js whitespace set {listed:?} vs {actual:?}"));

    for case in cases(&v, "utf16_lengths") {
        let t = s(case, "text");
        c.ok(utf16_len(t) as u64 == case["utf16_units"], || format!("utf16 units of {t:?}"));
        c.ok(t.chars().count() as u64 == case["code_points"], || format!("code points of {t:?}"));
        // The stand-in is 3 bytes in UTF-8 like the lone surrogate's WTF-8 / replacement form.
        c.ok(t.len() as u64 == case["utf8_bytes"], || format!("utf8 bytes of {t:?}"));
        c.ok((utf16_len(t) > MAX_TEXT) == case["over_max_text_4000"].as_bool().unwrap(), || "over max text".into());
    }
    for case in cases(&v, "clean_edit") {
        let got = clean_edit(&case["input"]).map_or(Value::Null, |e| serde_json::json!({"id": e.id, "text": e.text}));
        c.ok(got == case["output"], || format!("clean_edit {}", case["input"]));
    }
    for case in cases(&v, "clean_reply") {
        let got = clean_reply_units(&case["input"]);
        match (&got, &case["output"]) {
            (None, Value::Null) => c.ok(true, String::new),
            (Some((id, from, text)), out) if out.is_object() => {
                c.ok(id == s(out, "id") && from == s(out, "from"), || "clean_reply ids".into());
                c.ok(norm(text.iter().copied()) == units_of(s(out, "text")), || {
                    format!("clean_reply text of {}", case["input"])
                });
            }
            _ => c.ok(false, || format!("clean_reply shape {}", case["input"])),
        }
    }
    for case in cases(&v, "clean_ids") {
        c.ok(Value::from(clean_ids(&case["input"])) == case["output"], || format!("clean_ids {}", case["input"]));
    }
    for case in cases(&v, "clean_att") {
        let with_delete = case["with_delete"].as_bool().unwrap();
        let got = clean_att(&case["input"], with_delete).map_or(Value::Null, |a| a.to_value());
        c.ok(got == case["output"], || format!("clean_att {}:\n got {got}\n want {}", s(case, "name"), case["output"]));
    }
    for case in cases(&v, "clean_name") {
        c.ok(norm(clean_name_units(&case["input"])) == units_of(s_or_empty(&case["output"])), || {
            format!("clean_name {}", case["input"])
        });
    }
    for case in cases(&v, "normalize_link_code") {
        let got = normalize_link_code(case["input"].as_str().unwrap());
        c.ok(got.as_deref() == case["output"].as_str(), || format!("normalize_link_code {}", case["input"]));
    }
    for case in cases(&v, "edit_time") {
        let got = edit_time(js_number(Some(&case["ts"])), case["now"].as_f64().unwrap());
        c.ok(got == case["output"].as_f64().unwrap(), || format!("edit_time {case}"));
    }
    for case in cases(&v, "apply_edit") {
        let name = s(case, "name");
        let mut list = arr(&case["list"]).clone();
        let e = &case["edit"];
        let got =
            apply_edit(&mut list, s(e, "id"), e["mine"].as_bool().unwrap(), s(e, "text"), js_number(e.get("ts")), NOW);
        c.ok(got == case["returns"].as_bool().unwrap(), || format!("apply_edit {name}: returns"));
        c.ok(Value::Array(list) == case["list_after"], || format!("apply_edit {name}: list"));
    }
}

fn s_or_empty(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn links_and_sync_seal(c: &mut Counter) {
    let link = load("link.json");
    c.ok(link["alphabet"] == ALPHABET, || "link alphabet".into());
    for case in cases(&link, "cases") {
        let code = s(case, "code");
        let rb: [u8; 12] = from_hex_array(s(case, "random_bytes")).unwrap();
        let made: String = rb.iter().map(|b| ALPHABET.as_bytes()[(b & 31) as usize] as char).collect();
        c.ok(made == code, || format!("link code from bytes {code}"));
        c.ok(format_link_code(code) == s(case, "grouped"), || "link grouped".into());
        c.ok(normalize_link_code(s(case, "grouped")).as_deref() == Some(code), || "link normalize grouped".into());
        let keys = derive_link(code).unwrap();
        c.ok(to_hex(&*keys.scrypt_out) == s(case, "scrypt_out"), || "link scrypt".into());
        c.ok(keys.mailbox.seed_hex() == s(case, "mailbox_seed"), || "link mailbox seed".into());
        c.ok(keys.mailbox.address() == s(case, "mailbox_address"), || "link mailbox address".into());
        c.ok(to_hex(&*keys.bundle_key) == s(case, "bundle_key"), || "link bundle key".into());
        let body = s(case, "body");
        let bundle = open_value(&keys.bundle_key, body, "");
        c.ok(bundle.as_ref() == Some(&case["bundle"]) && case["open_ok"] == case["bundle"], || {
            "link bundle open".into()
        });
        c.ok(open_value(&keys.bundle_key, body, "x").is_none(), || "link bundle wrong aad".into());
        c.ok(
            case["open_with_other_key"].is_null()
                && open_value(&miga_core::crypto::sha256(&*keys.bundle_key), body, "").is_none(),
            || "link other key".into(),
        );
        let nonce: [u8; 24] = from_hex_array(s(case, "nonce")).unwrap();
        let plain = s(case, "plaintext");
        c.ok(parse_plaintext(plain.as_bytes()).as_ref() == Some(&case["bundle"]), || "link plaintext parses".into());
        c.ok(seal_with_nonce(&keys.bundle_key, &nonce, plain.as_bytes(), b"") == body, || "link re-encrypt".into());
        let b = &case["bundle"];
        let exp = b["exp"].as_f64().unwrap();
        c.ok(accept_bundle(b, exp - 1.0) && !accept_bundle(b, exp), || "link bundle exp rule".into());
    }

    let ss = load("sync-seal.json");
    let account = ident(s(&ss, "account_seed"));
    c.ok(account.address() == s(&ss, "account_address"), || "sync account address".into());
    let key = sync_key(&account);
    c.ok(to_hex(&key) == s(&ss, "sync_key"), || "sync key".into());
    for case in cases(&ss, "cases") {
        let name = s(case, "name");
        let (from, to) = (s(case, "from"), s(case, "to"));
        let aad = sync_aad(from, to);
        c.ok(aad == s(case, "aad"), || format!("sync {name}: aad"));
        let body = s(case, "body");
        c.ok(open_value(&key, body, &aad).as_ref() == Some(&case["value"]), || format!("sync {name}: open"));
        c.ok(open_value(&key, body, &sync_aad(to, from)).is_none(), || format!("sync {name}: swapped aad"));
        c.ok(open_value(&key, body, "").is_none(), || format!("sync {name}: empty aad"));
        let wrong = miga_core::crypto::sha256(&key);
        c.ok(open_value(&wrong, body, &aad).is_none(), || format!("sync {name}: wrong key"));
        let nonce: [u8; 24] = from_hex_array(s(case, "nonce")).unwrap();
        c.ok(seal_value_with_nonce(&key, &case["value"], &aad, &nonce) == body, || format!("sync {name}: re-encrypt"));
        let plain = s(case, "plaintext");
        c.ok(seal_with_nonce(&key, &nonce, plain.as_bytes(), aad.as_bytes()) == body, || {
            format!("sync {name}: re-encrypt plaintext")
        });
    }
}

fn files(c: &mut Counter) {
    let f = load("file-chunks.json");
    let table = &f["chunk_nonce_table"];
    let base: [u8; 24] = from_hex_array(s(table, "base_nonce")).unwrap();
    for e in cases(table, "entries") {
        let counter: u64 = s(e, "counter").parse().unwrap();
        c.ok(to_hex(&chunk_nonce(&base, counter)) == s(e, "nonce"), || format!("chunk nonce {counter}"));
    }
    for case in cases(&f, "cases") {
        let size = case["size"].as_u64().unwrap() as usize;
        let plain: Vec<u8> = (0..size).map(|j| ((j * 131 + 17) % 251) as u8).collect();
        let key: [u8; 32] = from_hex_array(s(case, "key")).unwrap();
        let nonce: [u8; 24] = from_hex_array(s(case, "base_nonce")).unwrap();
        let enc = encrypt_file_with(&plain, &key, &nonce);
        c.ok(enc.hash == s(case, "hash"), || format!("file {size}: hash"));
        c.ok(enc.cipher.len() as u64 == case["cipher_len"], || format!("file {size}: cipher len"));
        c.ok(to_hex(&miga_core::crypto::sha256(&enc.cipher)) == s(case, "cipher_sha256"), || {
            format!("file {size}: cipher sha")
        });
        if let Some(full) = case["cipher"].as_str() {
            c.ok(to_hex(&enc.cipher) == full, || format!("file {size}: cipher bytes"));
        }
        let chunks = cases(case, "chunks");
        c.ok(chunks.len() as u64 == case["chunk_count"], || format!("file {size}: chunk count"));
        let mut at = 0;
        for (i, ch) in chunks.iter().enumerate() {
            let clen = ch["cipher_len"].as_u64().unwrap() as usize;
            c.ok(to_hex(&chunk_nonce(&nonce, i as u64)) == s(ch, "nonce"), || format!("file {size}: chunk {i} nonce"));
            c.ok(ch["aad"] == if i == chunks.len() - 1 { "01" } else { "00" }, || {
                format!("file {size}: chunk {i} aad")
            });
            c.ok(to_hex(&miga_core::crypto::sha256(&enc.cipher[at..at + clen])) == s(ch, "cipher_sha256"), || {
                format!("file {size}: chunk {i} sha")
            });
            at += clen;
        }
        let hash = s(case, "hash");
        let back = decrypt_file(&enc.cipher, s(case, "key"), s(case, "base_nonce"), hash, size);
        c.ok(back.as_ref().ok() == Some(&plain), || format!("file {size}: decrypt"));
        for neg in cases(case, "negative") {
            let name = s(neg, "name");
            let mut cipher = enc.cipher.clone();
            let (mut h, mut sz) = (hash.to_string(), size);
            match name {
                "flip_last_byte" => *cipher.last_mut().unwrap() ^= 1,
                "wrong_hash" => h = "0".repeat(64),
                "wrong_size_plus_1" => sz += 1,
                "drop_last_chunk" => cipher.truncate(cipher.len() - (cipher.len() - (chunks.len() - 1) * (CHUNK + 16))),
                other => panic!("unknown negative {other}"),
            }
            let r = decrypt_file(&cipher, s(case, "key"), s(case, "base_nonce"), &h, sz);
            c.ok(r.is_err() && neg["result"] == "error", || format!("file {size}: negative {name}"));
            if let Err(e) = r {
                if name != "drop_last_chunk" {
                    c.ok(e.to_string() == s(neg, "reason"), || format!("file {size}: negative {name} reason {e}"));
                }
            }
        }
    }
}

fn tomb_list(v: &Value) -> Vec<Tomb> {
    clean_tombs(v, f64::MAX / 4.0)
}

fn tombs_value(list: &[Tomb]) -> Value {
    Value::Array(list.iter().map(Tomb::to_value).collect())
}

fn sync_logic(c: &mut Counter) {
    let v = load("sync-logic.json");
    for case in cases(&v, "merge_messages") {
        let name = s(case, "name");
        let mut list = arr(&case["list"]).clone();
        let added = merge_messages(&mut list, arr(&case["incoming"]));
        c.ok(added == case["returns_added"].as_bool().unwrap(), || format!("merge {name}: returns"));
        c.ok(Value::Array(list) == case["list_after"], || format!("merge {name}: list"));
    }
    let mut tombs: Vec<Tomb> = Vec::new();
    for (i, case) in cases(&v, "add_tombs").iter().enumerate() {
        let added = add_tombs(&mut tombs, &tomb_list(&case["incoming"]));
        c.ok(tombs_value(&added) == case["returns_added"], || format!("add_tombs {i}: added"));
        c.ok(tombs_value(&tombs) == case["tombs_after"], || format!("add_tombs {i}: after"));
    }
    let deleted = tomb_filter(&tombs);
    for (i, case) in cases(&v, "tomb_filter_checks").iter().enumerate() {
        let m = &case["message"];
        let got = deleted(s(case, "chat"), s(m, "id"), m["mine"].as_bool().unwrap(), m["ts"].as_f64().unwrap());
        c.ok(got == case["deleted"].as_bool().unwrap(), || format!("tomb_filter {i}"));
    }
    for case in cases(&v, "clean_message") {
        let got = clean_message(&case["input"], MAX_TEXT, NOW).unwrap_or(Value::Null);
        c.ok(got == case["output"], || format!("clean_message {}\n got {got}", case["input"]));
    }
    for case in cases(&v, "clean_tombs") {
        let got = tombs_value(&clean_tombs(&case["input"], case["now"].as_f64().unwrap()));
        c.ok(got == case["output"], || format!("clean_tombs {}", case["input"]));
    }
    for case in cases(&v, "clean_cursor") {
        let got = clean_cursor(&case["input"]).map_or(Value::Null, |c| c.to_value());
        c.ok(got == case["output"], || format!("clean_cursor {}", case["input"]));
    }
    let h = &v["history_pages"];
    let chats: &Map<String, Value> = h["chats"].as_object().unwrap();
    let max = h["max_bytes"].as_u64().unwrap() as usize;
    for (i, page) in cases(h, "pages").iter().enumerate() {
        let after: Option<Cursor> =
            if page["after"].is_null() { None } else { Some(clean_cursor(&page["after"]).expect("cursor")) };
        let got = history_page(chats, after.as_ref(), max);
        c.ok(Value::Object(got.chats) == page["chats"], || format!("history page {i}: chats"));
        c.ok(got.next.as_ref().map_or(Value::Null, Cursor::to_value) == page["next"], || {
            format!("history page {i}: next")
        });
        c.ok(got.count as u64 == page["count"], || format!("history page {i}: count"));
    }
    let _ = from_hex("");
}
