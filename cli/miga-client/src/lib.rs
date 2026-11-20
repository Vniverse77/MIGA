//! MIGA relay client (WebSocket, rustls) and a simple file store.
#![forbid(unsafe_code)]

pub mod devices;
pub mod engine;
pub mod files;
pub mod hub;
pub mod relay;
pub mod store;

use std::fmt;

#[derive(Debug)]
pub enum Error {
    Core(miga_core::Error),
    Io(std::io::Error),
    Ws(String),
    /// The relay refused or closed the connection, or an answer did not arrive in time.
    Relay(String),
    /// Bad user input or damaged local data.
    Invalid(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Core(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Ws(m) | Error::Relay(m) | Error::Invalid(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl From<miga_core::Error> for Error {
    fn from(e: miga_core::Error) -> Self {
        Error::Core(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Default relay of the hosted service.
pub const DEFAULT_RELAY: &str = "wss://miga.vniverse77.com/ws";

/// `Date.now()`
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
