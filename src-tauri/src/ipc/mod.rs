//! `acorn-ipc` IPC: in-process Unix-socket server and shared wire protocol.
//!
//! The server (in `server.rs`) is started once at app boot from `lib.rs`.
//! The protocol types in `proto.rs` are reused by the `acorn-ipc` CLI
//! binary (`src/bin/acorn-ipc.rs`), so they intentionally avoid any
//! Tauri- or runtime-specific types.

pub mod proto;
pub mod server;
pub mod socket_path;
