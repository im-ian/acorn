//! Background daemon (`acornd`) — owns persistent PTY sessions across
//! Acorn app launches. Key invariants:
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
