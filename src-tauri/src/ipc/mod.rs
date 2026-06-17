//! `acorn-ipc` IPC server wiring.
//!
//! The wire protocol, socket-path resolver, bundled-CLI PATH helpers,
//! and control-session primer live in the standalone `acorn-ipc` crate
//! so the CLI binary can link against them without dragging in the
//! host app's module graph.
//!
//! `server.rs` stays in the host crate because it touches `AppState`,
//! `SessionStore`, `persistence`, and worktree-creation helpers in
//! `commands` — none of which are available to a leaf crate.

pub mod server;
pub mod workspaces;
