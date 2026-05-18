//! `acorn-ipc`: protocol types, socket-path resolution, bundled-CLI PATH
//! helpers, and the control-session primer used to brief agents.
//!
//! Shared by the in-app IPC server (still wired in the main `acorn` crate
//! because it touches `AppState`, `SessionStore`, persistence, and worktree
//! creation) and by the out-of-process `acorn-ipc` CLI binary in this same
//! crate's `bin/` directory.
//!
//! Nothing in this crate depends on Tauri or on the host app's module
//! graph — every helper takes plain primitives so the binary can link
//! against this crate without dragging in the full app.

pub mod cli_path;
pub mod primer;
pub mod proto;
pub mod socket_path;
