//! Background daemon (`acornd`) — owns persistent PTY sessions across Acorn
//! app launches. See the design discussion captured in the conversation
//! summary for the 27 decisions that shape this module; key invariants:
//!
//! * Two-socket IPC (control + stream) to avoid head-of-line blocking.
//! * Acorn app's `sessions.json` is the rich SoT; the daemon keeps only
//!   the minimum metadata it needs to reconcile (Q8).
//! * Daemon survives Acorn-app exit (explicit `Shutdown` only — Q2).
//! * Crash recovery: panic hook writes timestamped crash file; the app
//!   auto-respawns the daemon on socket probe failure (Q27).

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
