//! Pair key, envelope sealing (padding, XChaCha20-Poly1305), sync key, safety number
//! (ENGINE.md sections 4 and 5).
use crate::identity::Identity;
use crate::js::{from_base64, to_base64};
use crate::{random_bytes, Error, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256, Sha512};

pub const PAD: usize = 256;
pub const NONCE_LEN: usize = 24;
pub const TAG_LEN: usize = 16;

/// `HKDF-SHA256(ikm = shared, salt = "miga-v0", info = sorted([me, peer]).join(""), 32)`.
pub fn pair_key(me: &Identity, peer: &str) -> Result<[u8; 32]> {
    let shared = me.shared_secret(peer).ok_or(Error::Invalid("invalid peer address"))?;
    let mut both = [me.address(), peer];
    both.sort_unstable();
    Ok(hkdf32(&*shared, both.concat().as_bytes()))
}

/// Sync key of an account: `HKDF(ikm = account seed, salt = "miga-v0", info = "sync", 32)`.
pub fn sync_key(account: &Identity) -> [u8; 32] {
    hkdf32(account.seed(), b"sync")
}

fn hkdf32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"miga-v0"), ikm).expand(info, &mut out).expect("32 bytes is a valid HKDF length");
    out
}

/// Pads with spaces (0x20) to a multiple of 256 bytes. Empty input stays empty.
pub fn pad(json: &[u8]) -> Vec<u8> {
    let mut out = json.to_vec();
    out.resize(json.len().div_ceil(PAD) * PAD, 0x20);
    out
}

/// `base64(nonce || XChaCha20-Poly1305(key, nonce, pad(plaintext), aad))` with a given nonce.
pub fn seal_with_nonce(key: &[u8; 32], nonce: &[u8; NONCE_LEN], plaintext: &[u8], aad: &[u8]) -> String {
    let cipher = XChaCha20Poly1305::new(key.into());
    let sealed = cipher
        .encrypt(XNonce::from_slice(nonce), Payload { msg: &pad(plaintext), aad })
        .expect("encryption of an in-memory buffer cannot fail");
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    to_base64(&out)
}

/// Same with a fresh random nonce.
pub fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<String> {
    Ok(seal_with_nonce(key, &random_bytes::<NONCE_LEN>()?, plaintext, aad))
}

/// Opens an envelope and returns the padded plaintext bytes (receivers do not unpad).
pub fn open(key: &[u8; 32], body: &str, aad: &[u8]) -> Option<Vec<u8>> {
    let raw = from_base64(body)?;
    if raw.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let (nonce, sealed) = raw.split_at(NONCE_LEN);
    XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad }).ok()
}

/// Splits an envelope into its nonce (for tests and diagnostics).
pub fn envelope_nonce(body: &str) -> Option<[u8; NONCE_LEN]> {
    from_base64(body)?.get(..NONCE_LEN)?.try_into().ok()
}

/// 60-digit safety number of two addresses (lowercased first, then sorted).
pub fn safety_number(mine: &str, theirs: &str) -> Result<String> {
    let (a, b) = (mine.to_ascii_lowercase(), theirs.to_ascii_lowercase());
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut h = Sha512::new();
    h.update(b"MIGA-safety-v1");
    h.update([0u8]);
    h.update(crate::from_hex(&lo)?);
    h.update(crate::from_hex(&hi)?);
    let hash = h.finalize();
    let mut out = String::with_capacity(60);
    for i in 0..12 {
        let n = hash[i * 5..i * 5 + 5].iter().fold(0u64, |n, &b| n * 256 + u64::from(b));
        out.push_str(&format!("{:05}", n % 100_000));
    }
    Ok(out)
}

/// `"12345 67890 ..."`
pub fn group_safety(number: &str) -> String {
    number.as_bytes().chunks(5).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}
