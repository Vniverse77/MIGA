//! Device linking: link codes, the scrypt derivation and the sealed bundle (ENGINE.md section 12),
//! plus sync-message sealing with its sender/recipient AAD.
use crate::crypto::{open, seal, seal_with_nonce, NONCE_LEN};
use crate::identity::Identity;
use crate::js::is_lower_hex;
use crate::{random_bytes, Error, Result};
use serde_json::Value;
use zeroize::Zeroizing;

/// How long a link code stays valid (10 minutes).
pub const LINK_TTL_MS: i64 = 600_000;
/// Crockford base32 without I, L, O, U.
pub const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH: usize = 12;

/// A fresh code: 12 characters, each `random byte & 31`.
pub fn new_link_code() -> Result<String> {
    let alphabet = ALPHABET.as_bytes();
    Ok(random_bytes::<CODE_LENGTH>()?.iter().map(|b| alphabet[(b & 31) as usize] as char).collect())
}

/// `G857-6A7E-NR5M`
pub fn format_link_code(code: &str) -> String {
    code.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

/// What a person types: any case, separators ignored, O is 0, I and L are 1. `None` when it is not
/// exactly 12 characters of the alphabet (so `U` is invalid).
pub fn normalize_link_code(input: &str) -> Option<String> {
    // `toUpperCase` first (it can change the character count, e.g. the sharp s), then the filter.
    let code: String = input
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect();
    (code.len() == CODE_LENGTH && code.chars().all(|c| ALPHABET.contains(c))).then_some(code)
}

/// The throwaway mailbox identity and the bundle key derived from a (normalized) code.
pub struct LinkKeys {
    pub mailbox: Identity,
    pub bundle_key: Zeroizing<[u8; 32]>,
    /// The full scrypt output (for vectors).
    pub scrypt_out: Zeroizing<[u8; 64]>,
}

/// `scrypt(utf8(code), "miga-link-v0", N = 2^15, r = 8, p = 1, 64)`: bytes 0..32 are the mailbox
/// seed, 32..64 the bundle key.
pub fn derive_link(code: &str) -> Result<LinkKeys> {
    let params = scrypt::Params::new(15, 8, 1, 64).map_err(|_| Error::Invalid("scrypt parameters"))?;
    let mut out = Zeroizing::new([0u8; 64]);
    scrypt::scrypt(code.as_bytes(), b"miga-link-v0", &params, &mut *out).map_err(|_| Error::Invalid("scrypt"))?;
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&out[..32]);
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&out[32..]);
    Ok(LinkKeys { mailbox: Identity::from_seed(seed), bundle_key: key, scrypt_out: out })
}

/// Seals a JSON value (bundle or sync message) with no AAD (bundle) or the given AAD (sync).
pub fn seal_value(key: &[u8; 32], value: &Value, aad: &str) -> Result<String> {
    seal(key, serde_json::to_string(value).expect("a Value always serializes").as_bytes(), aad.as_bytes())
}

pub fn seal_value_with_nonce(key: &[u8; 32], value: &Value, aad: &str, nonce: &[u8; NONCE_LEN]) -> String {
    seal_with_nonce(
        key,
        nonce,
        serde_json::to_string(value).expect("a Value always serializes").as_bytes(),
        aad.as_bytes(),
    )
}

/// `open()`: decrypt and parse; `None` on any failure.
pub fn open_value(key: &[u8; 32], body: &str, aad: &str) -> Option<Value> {
    crate::payload::parse_plaintext(&open(key, body, aad.as_bytes())?)
}

/// AAD of a sync message: `senderDeviceAddr + recipientDeviceAddr`.
pub fn sync_aad(from: &str, to: &str) -> String {
    format!("{from}{to}")
}

/// A new device accepts a bundle only if `k == "link"`, `secret` is 64 lowercase hex, `sponsor` is a
/// string and `exp` is in the future.
pub fn accept_bundle(bundle: &Value, now_ms: f64) -> bool {
    bundle.get("k").and_then(Value::as_str) == Some("link")
        && bundle.get("secret").and_then(Value::as_str).is_some_and(|s| is_lower_hex(s, 64))
        && bundle.get("sponsor").is_some_and(Value::is_string)
        && bundle.get("exp").and_then(Value::as_f64).is_some_and(|e| e > now_ms)
}
