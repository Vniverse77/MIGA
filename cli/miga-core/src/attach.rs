//! Encrypted attachments: metadata validation and chunked file crypto (ENGINE.md section 11).
use crate::crypto::{sha256, NONCE_LEN, TAG_LEN};
use crate::js::{is_lower_hex, js_number, js_round};
use crate::{from_hex_array, random_bytes, to_hex, Error, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{Map, Value};

/// Plaintext bytes per chunk.
pub const CHUNK: usize = 64 * 1024;
/// Largest file (plaintext): 25 MiB.
pub const MAX_ATTACHMENT: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Att {
    pub blob: String,
    pub key: String,
    pub nonce: String,
    pub hash: String,
    pub mime: String,
    pub size: u64,
    pub w: u32,
    pub h: u32,
    pub thumb: String,
    pub del: Option<String>,
}

impl Att {
    pub fn to_value(&self) -> Value {
        let mut m = self.base();
        if let Some(d) = &self.del {
            m.insert("del".into(), d.clone().into());
        }
        Value::Object(m)
    }

    /// What goes on the wire to a recipient: the delete token never does.
    pub fn to_value_without_delete(&self) -> Value {
        Value::Object(self.base())
    }

    fn base(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("blob".into(), self.blob.clone().into());
        m.insert("key".into(), self.key.clone().into());
        m.insert("nonce".into(), self.nonce.clone().into());
        m.insert("hash".into(), self.hash.clone().into());
        m.insert("mime".into(), self.mime.clone().into());
        m.insert("size".into(), self.size.into());
        m.insert("w".into(), self.w.into());
        m.insert("h".into(), self.h.into());
        m.insert("thumb".into(), self.thumb.clone().into());
        m
    }
}

const MIMES: [&str; 6] = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"];

fn thumb_ok(t: &str) -> bool {
    let Some(rest) = ["webp", "jpeg", "png"].iter().find_map(|k| t.strip_prefix(&format!("data:image/{k};base64,")))
    else {
        return false;
    };
    rest.len() <= 4000 && rest.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
}

/// `cleanAtt`: `None` when malformed. `with_delete` keeps the sender's own delete token.
pub fn clean_att(value: &Value, with_delete: bool) -> Option<Att> {
    let s = |k: &str| value.get(k).and_then(Value::as_str);
    let blob = s("blob").filter(|v| is_lower_hex(v, 32))?;
    let key = s("key").filter(|v| is_lower_hex(v, 64))?;
    let nonce = s("nonce").filter(|v| is_lower_hex(v, 48))?;
    let hash = s("hash").filter(|v| is_lower_hex(v, 64))?;
    let mime = s("mime").filter(|v| MIMES.contains(v))?;
    let size = js_number(value.get("size"));
    if size.fract() != 0.0 || !(1.0..=MAX_ATTACHMENT as f64).contains(&size) {
        return None;
    }
    let w = js_round(js_number(value.get("w")));
    let h = js_round(js_number(value.get("h")));
    if !((1.0..=20000.0).contains(&w) && (1.0..=20000.0).contains(&h)) {
        return None;
    }
    let thumb = s("thumb").filter(|t| thumb_ok(t)).unwrap_or("");
    let del = s("del").filter(|d| with_delete && is_lower_hex(d, 32));
    Some(Att {
        blob: blob.into(),
        key: key.into(),
        nonce: nonce.into(),
        hash: hash.into(),
        mime: mime.into(),
        size: size as u64,
        w: w as u32,
        h: h as u32,
        thumb: thumb.into(),
        del: del.map(str::to_string),
    })
}

/// The nonce of chunk `i`: the base nonce with the counter XORed into its last 8 bytes, big endian.
pub fn chunk_nonce(base: &[u8; NONCE_LEN], i: u64) -> [u8; NONCE_LEN] {
    let mut n = *base;
    for (b, c) in n[16..].iter_mut().zip(i.to_be_bytes()) {
        *b ^= c;
    }
    n
}

fn aad(last: bool) -> [u8; 1] {
    [u8::from(last)]
}

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

/// One chunk of a file, sealed.
pub fn seal_chunk(key: &[u8; 32], base: &[u8; NONCE_LEN], index: u64, last: bool, plain: &[u8]) -> Vec<u8> {
    cipher(key)
        .encrypt(XNonce::from_slice(&chunk_nonce(base, index)), Payload { msg: plain, aad: &aad(last) })
        .expect("encryption of an in-memory buffer cannot fail")
}

pub struct EncryptedFile {
    pub cipher: Vec<u8>,
    pub key: String,
    pub nonce: String,
    pub hash: String,
}

/// Encrypts a whole file with the given key and base nonce (test hook).
pub fn encrypt_file_with(plain: &[u8], key: &[u8; 32], base: &[u8; NONCE_LEN]) -> EncryptedFile {
    let count = plain.len().div_ceil(CHUNK).max(1);
    let mut out = Vec::with_capacity(plain.len() + count * TAG_LEN);
    for i in 0..count {
        let part = &plain[(i * CHUNK).min(plain.len())..((i + 1) * CHUNK).min(plain.len())];
        out.extend(seal_chunk(key, base, i as u64, i == count - 1, part));
    }
    EncryptedFile { cipher: out, key: to_hex(key), nonce: to_hex(base), hash: to_hex(&sha256(plain)) }
}

pub fn encrypt_file(plain: &[u8]) -> Result<EncryptedFile> {
    Ok(encrypt_file_with(plain, &random_bytes::<32>()?, &random_bytes::<NONCE_LEN>()?))
}

/// Decrypts and verifies a file: exact length, every chunk tag, then size and SHA-256.
pub fn decrypt_file(
    cipher_bytes: &[u8],
    key_hex: &str,
    nonce_hex: &str,
    hash_hex: &str,
    size: usize,
) -> Result<Vec<u8>> {
    let key: [u8; 32] = from_hex_array(key_hex)?;
    let base: [u8; NONCE_LEN] = from_hex_array(nonce_hex)?;
    let full = CHUNK + TAG_LEN;
    let count = cipher_bytes.len().div_ceil(full).max(1);
    if size > MAX_ATTACHMENT || cipher_bytes.len() != size + count * TAG_LEN {
        return Err(Error::Mismatch("size mismatch"));
    }
    let mut plain = Vec::with_capacity(size);
    for i in 0..count {
        let part = &cipher_bytes[(i * full).min(cipher_bytes.len())..((i + 1) * full).min(cipher_bytes.len())];
        let opened = cipher(&key)
            .decrypt(
                XNonce::from_slice(&chunk_nonce(&base, i as u64)),
                Payload { msg: part, aad: &aad(i == count - 1) },
            )
            .map_err(|_| Error::Crypto("invalid tag"))?;
        if plain.len() + opened.len() > size {
            return Err(Error::Mismatch("size mismatch"));
        }
        plain.extend(opened);
    }
    if plain.len() != size || to_hex(&sha256(&plain)) != hash_hex {
        return Err(Error::Mismatch("hash mismatch"));
    }
    Ok(plain)
}
