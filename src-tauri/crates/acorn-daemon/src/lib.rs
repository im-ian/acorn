//! Background daemon (`acornd`) — owns persistent PTY sessions across
//! Acorn app launches. Pulled out of the main `acorn` crate as its own
//! workspace member so changes to UI / Tauri command surfaces do not
//! force a recompile of the daemon's protocol + lifecycle layer (and
//! vice versa). The `acornd` binary still lives in the main crate's
//! `src/bin/` because it threads a host-defined env-applier policy
//! (from `pty_env` + `shell_env`) into [`pty::PtyManager`] at spawn
//! time — keeping that policy out of this leaf crate.
//!
//! Key invariants:
//!
//! * Two-socket IPC (control + stream) to avoid head-of-line blocking.
//! * Acorn app's `sessions.json` is the rich source-of-truth; the
//!   daemon keeps only the minimum metadata needed to reconcile.
//! * Daemon survives Acorn-app exit. Only an explicit `Shutdown` RPC
//!   (or a `SIGKILL` from outside) terminates it.
//! * Crash recovery: panic hook writes a timestamped crash file; the
//!   app auto-respawns the daemon on socket-probe failure.

pub mod client;
pub mod crash;
pub mod lifecycle;
pub mod logging;
pub mod paths;
pub mod protocol;
pub mod pty;
pub mod ring_buffer;
pub mod server;
pub mod session;
pub mod socket;
pub mod wire;

#[cfg(test)]
mod test_env;
