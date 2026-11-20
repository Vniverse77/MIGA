//! The network task is shared with the headless commands: see `miga_client::hub`.
pub use miga_client::hub::{run, After, Cmd, Conn as HubConn, HubEvent as NetEvent};
