//! Bridge between the Acorn Tauri app and the out-of-process `acornd`
//! daemon. Encapsulates:
//!
//! * Daemon spawn lifecycle (probe → spawn detached → wait for socket
//!   to come up → cache a persistent `ControlConn`).
//! * Settings-gated routing — when the user has the daemon disabled,
//!   every helper short-circuits to `Err(BridgeError::Disabled)` so
//!   the caller can fall back to the legacy in-process PTY path.
//! * Auto-respawn on connection failure up to `MAX_SPAWN_RETRIES`
//!   before surfacing the error to the user.
//!
//! Threading: the cached `ControlConn` is wrapped in a `Mutex` so the
//! single connection serializes the app's outgoing requests. The daemon
//! protocol allows multiple in-flight requests on a persistent
//! connection (sequenced via `req.seq`), but the app's call sites are
//! synchronous Tauri commands, so the simpler "one request at a time
//! per connection" model is sufficient and avoids a per-request seq
//! correlation table on the app side.

use std::io;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use uuid::Uuid;

use crate::daemon::client::ControlConn;
use crate::daemon::protocol::{
    AgentKind, ControlPayload, ControlResult, SessionKind, SessionSummary, SpawnSpec,
    StatusSnapshot,
};
use crate::daemon::{client, paths};

/// How long the bridge waits for `acornd` to become reachable after
/// spawning it. Conservative because the first launch on a cold disk
/// has to fault in the binary + linker; subsequent launches are
/// near-instant.
const SOCKET_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Maximum daemon (re)spawn attempts before the bridge gives up and
/// surfaces the failure to the user. Five is enough to absorb a
/// transient `bind()` race on a stale socket file without hiding a
/// real "daemon binary is missing" misconfiguration.
const MAX_SPAWN_RETRIES: u32 = 5;

#[derive(Debug)]
pub enum BridgeError {
    /// The user has the daemon toggle off in Settings — the caller
    /// should fall back to the legacy in-process PTY path.
    Disabled,
    /// The `acornd` binary could not be located on disk. Returned with
    /// the path we expected to find it at so the caller can render a
    /// helpful error in the UI.
    BinaryNotFound(PathBuf),
    /// The daemon spawned but did not become reachable within the
    /// timeout window.
    SpawnTimeout,
    /// The daemon exited unexpectedly during a request. The caller
    /// (Tauri command) typically wants to retry once before surfacing
    /// this to the user.
    Disconnected,
    /// The daemon answered with a typed protocol error. The original
    /// error code and message are preserved for UI surfacing.
    Daemon {
        code: crate::daemon::protocol::ErrorCode,
        message: String,
    },
    /// Anything else (OS I/O, JSON parse, etc.).
    Io(io::Error),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "daemon disabled by setting"),
            Self::BinaryNotFound(p) => write!(f, "acornd binary not found at {}", p.display()),
            Self::SpawnTimeout => write!(f, "acornd did not become reachable in time"),
            Self::Disconnected => write!(f, "acornd connection lost mid-request"),
            Self::Daemon { code, message } => {
                write!(f, "acornd error ({code:?}): {message}")
            }
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for BridgeError {}

impl From<io::Error> for BridgeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

pub type BridgeResult<T> = Result<T, BridgeError>;

/// Successful spawn payload. Mirrors the daemon's
/// `ControlResult::SessionSpawned` so callers can wire the pid into
/// status polling without re-listing sessions.
pub struct SpawnOutcome {
    pub session_id: Uuid,
    pub pid: Option<u32>,
}

/// Cached, lazily-spawned daemon connection. Held on `AppState`.
pub struct DaemonBridge {
    enabled: AtomicBool,
    conn: Mutex<Option<ControlConn>>,
    /// Path to the `acornd` binary discovered at app startup. Cached so
    /// we do not re-resolve it on every reconnect.
    binary_path: Mutex<Option<PathBuf>>,
}

impl DaemonBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            // Default ON so a fresh install gets persistent sessions
            // out of the box. The Settings toggle flips this at
            // runtime via `set_enabled`.
            enabled: AtomicBool::new(true),
            conn: Mutex::new(None),
            binary_path: Mutex::new(None),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Toggle the daemon path on/off. Off-flip drops the cached
    /// connection so the next call cannot accidentally hit a stale
    /// daemon channel; the daemon process itself is left running
    /// (the user may flip back on; killing the daemon should be
    /// explicit).
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            *self.conn.lock() = None;
        }
    }

    /// Resolve and cache the bundled `acornd` binary path. macOS app
    /// bundle layout: the GUI binary lives at `Contents/MacOS/acorn`
    /// and the daemon sits next to it as `Contents/MacOS/acornd`. In
    /// `bun run tauri dev` mode the daemon is at `target/debug/acornd`
    /// next to `target/debug/acorn`.
    pub fn cache_binary_path(&self, hint: Option<PathBuf>) -> Option<PathBuf> {
        let resolved = hint.or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("acornd")))
        });
        *self.binary_path.lock() = resolved.clone();
        resolved
    }

    fn binary_path(&self) -> Option<PathBuf> {
        self.binary_path.lock().clone()
    }

    /// Ensure a daemon is running and we have a live `ControlConn` to
    /// it. Spawns the daemon if no instance answers the canonical
    /// socket. Returns `Err(Disabled)` when the killswitch is off so
    /// the caller can route to the in-process PTY path.
    pub fn ensure_connection(&self) -> BridgeResult<()> {
        if !self.is_enabled() {
            return Err(BridgeError::Disabled);
        }
        if self.conn.lock().is_some() {
            return Ok(());
        }
        // No cached conn — probe; if down, spawn; then connect.
        if client::probe_status()?.is_none() {
            self.spawn_daemon_with_retries()?;
        }
        let conn = ControlConn::persistent("acorn-app")?;
        *self.conn.lock() = Some(conn);
        Ok(())
    }

    fn spawn_daemon_with_retries(&self) -> BridgeResult<()> {
        let mut last_err: Option<BridgeError> = None;
        for attempt in 1..=MAX_SPAWN_RETRIES {
            match self.spawn_daemon_once() {
                Ok(()) => return Ok(()),
                Err(err) => {
                    tracing::warn!(attempt, error = %err, "acornd spawn attempt failed");
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(BridgeError::SpawnTimeout))
    }

    fn spawn_daemon_once(&self) -> BridgeResult<()> {
        let Some(path) = self.binary_path() else {
            return Err(BridgeError::BinaryNotFound(PathBuf::from("acornd")));
        };
        if !path.exists() {
            return Err(BridgeError::BinaryNotFound(path));
        }
        // `--detach` so the daemon survives the app's exit. Spawn
        // returns immediately; the detached grandchild keeps running.
        Command::new(&path).arg("serve").arg("--detach").spawn()?;
        // Wait for the socket to come up.
        let deadline = Instant::now() + SOCKET_WAIT_TIMEOUT;
        while Instant::now() < deadline {
            if client::probe_status()?.is_some() {
                return Ok(());
            }
            std::thread::sleep(SOCKET_POLL_INTERVAL);
        }
        Err(BridgeError::SpawnTimeout)
    }

    /// Single-shot RPC: ensures connection, sends the payload, returns
    /// the typed result. On `Disconnected` automatically drops the
    /// cached connection so the next call re-establishes.
    fn call(&self, payload: ControlPayload) -> BridgeResult<ControlResult> {
        self.ensure_connection()?;
        // First attempt over the persistent conn.
        let result = {
            let mut guard = self.conn.lock();
            let conn = guard.as_mut().expect("ensure_connection set this");
            conn.call(payload.clone())
        };
        match result {
            Ok(resp) => Ok(resp.payload),
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof
                || e.kind() == io::ErrorKind::BrokenPipe =>
            {
                // Stale connection — drop and reconnect once.
                *self.conn.lock() = None;
                self.ensure_connection()?;
                let mut guard = self.conn.lock();
                let conn = guard.as_mut().expect("reconnected");
                let resp = conn.call(payload).map_err(BridgeError::from)?;
                Ok(resp.payload)
            }
            Err(e) => Err(BridgeError::from(e)),
        }
    }

    fn unpack_error(result: ControlResult) -> BridgeResult<ControlResult> {
        match result {
            ControlResult::Error { code, message } => Err(BridgeError::Daemon { code, message }),
            other => Ok(other),
        }
    }

    // --- High-level helpers used by Tauri commands ---

    pub fn status(&self) -> BridgeResult<StatusSnapshot> {
        // Status uses a one-shot connection — keeps the persistent conn
        // free for spawn/kill traffic and lets a stale persistent conn
        // be transparently rebuilt without affecting the status probe.
        if !self.is_enabled() {
            return Err(BridgeError::Disabled);
        }
        match client::probe_status()? {
            Some(snap) => Ok(snap),
            None => Err(BridgeError::Disconnected),
        }
    }

    pub fn list_sessions(&self) -> BridgeResult<Vec<SessionSummary>> {
        match Self::unpack_error(self.call(ControlPayload::ListSessions)?)? {
            ControlResult::Sessions { sessions } => Ok(sessions),
            other => Err(unexpected(other)),
        }
    }

    /// Lightweight check: does the daemon currently hold an alive PTY
    /// for `id`? Used by `commands::pty_spawn` to decide between a
    /// re-spawn (no entry / dead entry) and a stream-attach (still
    /// alive). Returns `false` on any bridge error — the caller will
    /// then re-spawn, which is the conservative outcome.
    pub fn is_alive(&self, id: Uuid) -> bool {
        match self.list_sessions() {
            Ok(sessions) => sessions.iter().any(|s| s.id == id && s.alive),
            Err(_) => false,
        }
    }

    pub fn spawn(
        &self,
        session_id: Uuid,
        name: String,
        cwd: PathBuf,
        command: String,
        args: Vec<String>,
        env: std::collections::HashMap<String, String>,
        cols: u16,
        rows: u16,
        kind: SessionKind,
        repo_path: Option<PathBuf>,
        branch: Option<String>,
        agent_kind: Option<AgentKind>,
        agent_resume_token: Option<String>,
    ) -> BridgeResult<SpawnOutcome> {
        let spec = SpawnSpec {
            session_id: Some(session_id),
            name,
            cwd,
            command,
            args,
            env,
            cols,
            rows,
            kind,
            repo_path,
            branch,
            agent_kind,
            agent_resume_token,
        };
        match Self::unpack_error(self.call(ControlPayload::SpawnSession { spec })?)? {
            ControlResult::SessionSpawned { session_id, pid } => {
                Ok(SpawnOutcome { session_id, pid })
            }
            other => Err(unexpected(other)),
        }
    }

    /// Look up the immediate PTY child pid for a daemon-managed session
    /// via `ListSessions`. Returns `None` when the daemon does not know
    /// about the session or the bridge call fails (e.g. transient
    /// disconnect). Status polling treats `None` as "no descendant
    /// info" and falls back to the previous status, which is the same
    /// conservative behavior the in-process path uses when a pid is
    /// not yet available.
    pub fn session_pid(&self, id: Uuid) -> Option<u32> {
        let sessions = self.list_sessions().ok()?;
        sessions
            .into_iter()
            .find(|s| s.id == id)
            .and_then(|s| s.pid)
    }

    pub fn send_input(&self, target: Uuid, bytes: &[u8]) -> BridgeResult<()> {
        let data_b64 = base64_encode(bytes);
        match Self::unpack_error(self.call(ControlPayload::SendInput {
            target_session_id: target,
            data_b64,
        })?)? {
            ControlResult::Ack => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    pub fn resize(&self, target: Uuid, cols: u16, rows: u16) -> BridgeResult<()> {
        match Self::unpack_error(self.call(ControlPayload::Resize {
            target_session_id: target,
            cols,
            rows,
        })?)? {
            ControlResult::Ack => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    pub fn kill(&self, target: Uuid) -> BridgeResult<()> {
        match Self::unpack_error(self.call(ControlPayload::KillSession {
            target_session_id: target,
        })?)? {
            ControlResult::Ack => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    pub fn forget(&self, target: Uuid) -> BridgeResult<()> {
        match Self::unpack_error(self.call(ControlPayload::ForgetSession {
            target_session_id: target,
        })?)? {
            ControlResult::Ack => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    pub fn shutdown(&self) -> BridgeResult<()> {
        match Self::unpack_error(self.call(ControlPayload::Shutdown)?)? {
            ControlResult::Ack => {
                // Daemon will close its end shortly; drop the cached
                // connection now so subsequent traffic respawns cleanly.
                *self.conn.lock() = None;
                Ok(())
            }
            other => Err(unexpected(other)),
        }
    }
}

fn unexpected(result: ControlResult) -> BridgeError {
    BridgeError::Daemon {
        code: crate::daemon::protocol::ErrorCode::Internal,
        message: format!("unexpected response: {result:?}"),
    }
}

/// RFC 4648 base64 encoder. Mirrors the daemon's own implementation so
/// the app does not pull in an extra dep — `crate::pty::base64_encode`
/// is module-private, hence duplicated here.
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut chunks = input.chunks_exact(3);
    for chunk in &mut chunks {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHABET[(n & 0x3f) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        0 => {}
        1 => {
            let n = u32::from(rem[0]) << 16;
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = (u32::from(rem[0]) << 16) | (u32::from(rem[1]) << 8);
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => unreachable!(),
    }
    out
}

/// Convenience: peek at the data dir without going through the daemon
/// API. Used by the app to display the daemon log path in Settings.
pub fn data_dir_path() -> io::Result<PathBuf> {
    paths::data_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_bridge_short_circuits() {
        let bridge = DaemonBridge::new();
        bridge.set_enabled(false);
        assert!(!bridge.is_enabled());
        match bridge.ensure_connection() {
            Err(BridgeError::Disabled) => {}
            other => panic!("expected Disabled, got {other:?}"),
        }
    }

    #[test]
    fn base64_known_vectors() {
        // RFC 4648 test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    }
}
