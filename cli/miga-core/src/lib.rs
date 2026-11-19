//! MIGA protocol v0, pure and I/O free: identity, address checks, pair keys, envelopes,
//! payload classification, validators, link codes, sync seals, attachment chunk crypto.
//!
//! The behaviour reference is the TypeScript client (`web/src/lib`), described in
//! `docs/PROTOCOL.md` and `docs/ENGINE.md`. Every rule here is checked against the shared test
//! vectors in `protocol/test-vectors/`.
#![forbid(unsafe_code)]

pub mod attach;
pub mod crypto;
pub mod identity;
pub mod js;
pub mod link;
pub mod payload;
pub mod sync;

use std::fmt;

/// All failures are deliberately coarse: the protocol treats any problem as "unreadable".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Malformed input (bad hex, wrong length, invalid address).
    Invalid(&'static str),
    /// Authentication failed or the data was tampered with.
    Crypto(&'static str),
    /// A size, hash or structure check failed.
    Mismatch(&'static str),
    /// The system random number generator failed.
    Random,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(m) | Error::Crypto(m) | Error::Mismatch(m) => f.write_str(m),
            Error::Random => f.write_str("random number generator failed"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Lowercase hex.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// Strict hex decoding (either case, even length).
pub fn from_hex(text: &str) -> Result<Vec<u8>> {
    let b = text.as_bytes();
    if b.len() % 2 != 0 {
        return Err(Error::Invalid("odd hex length"));
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(Error::Invalid("bad hex digit")),
    };
    b.chunks(2).map(|p| Ok(nib(p[0])? << 4 | nib(p[1])?)).collect()
}

/// Hex of exactly `N` bytes.
pub fn from_hex_array<const N: usize>(text: &str) -> Result<[u8; N]> {
    from_hex(text)?.try_into().map_err(|_| Error::Invalid("wrong length"))
}

/// Fresh random bytes from the operating system.
pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).map_err(|_| Error::Random)?;
    Ok(out)
}

/// `randomId()` of the web client: 16 random bytes as 32 lowercase hex characters.
pub fn random_id() -> Result<String> {
    Ok(to_hex(&random_bytes::<16>()?))
}
