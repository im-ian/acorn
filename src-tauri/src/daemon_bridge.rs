//! Bridge between the Acorn Tauri app and the out-of-process `acornd`
//! daemon. Encapsulates:
//!
//! * Daemon spawn lifecycle (probe → spawn detached → wait for socket
//!   to come up → cache a persistent `ControlConn`).
//! * Settings-gated routing — disabling the daemon sends new sessions to the
//!   in-process PTY path, while existing daemon-bound sessions retain passive
//!   access to their original owner until explicitly terminated.
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
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
#[cfg(any(all(windows, not(debug_assertions)), test))]
use std::fs::{self, File};
#[cfg(any(all(windows, not(debug_assertions)), test))]
use std::io::Read;
use uuid::Uuid;

use acorn_daemon::client::ControlConn;
use acorn_daemon::protocol::{
    AgentKind, ControlPayload, ControlResult, SessionKind, SessionSummary, SpawnSpec,
    StatusSnapshot,
};
use acorn_daemon::{client, paths};

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
/// Bundled Windows executables cannot be replaced while running. Release
/// builds therefore launch a copy outside the NSIS install directory, under
/// a package-versioned data directory that is immutable for that release.
#[cfg(any(all(windows, not(debug_assertions)), test))]
const DAEMON_BIN_CACHE_DIR: &str = "daemon-bin";

#[derive(Debug)]
pub enum BridgeError {
    /// The user has the daemon toggle off and no existing daemon is available.
    /// Only an unbound session may fall back to the in-process PTY path.
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
        code: acorn_daemon::protocol::ErrorCode,
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
    pub pid: Option<u32>,
}

/// Cached, lazily-spawned daemon connection. Held on `AppState`.
pub struct DaemonBridge {
    enabled: AtomicBool,
    conn: Mutex<Option<ControlConn>>,
    /// True while the cached connection intentionally targets an older
    /// daemon because it still owns live PTYs. Once those sessions end,
    /// `ensure_connection` replaces the idle daemon before the next RPC.
    incompatible_daemon: AtomicBool,
    /// Path to the `acornd` binary discovered at app startup. Cached so
    /// we do not re-resolve it on every reconnect.
    binary_path: Mutex<DaemonBinaryPath>,
}

#[derive(Debug, Clone)]
enum DaemonBinaryPath {
    Unresolved,
    Ready(PathBuf),
    Failed {
        kind: io::ErrorKind,
        message: String,
    },
}

impl DaemonBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            // Default ON so a fresh install gets persistent sessions
            // out of the box. The Settings toggle flips this at
            // runtime via `set_enabled`.
            enabled: AtomicBool::new(true),
            conn: Mutex::new(None),
            incompatible_daemon: AtomicBool::new(false),
            binary_path: Mutex::new(DaemonBinaryPath::Unresolved),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Toggle the default route for new sessions. Existing daemon-backed
    /// sessions keep their cached connection so disabling persistence cannot
    /// strand their input or tempt callers to create a duplicate local PTY.
    /// Killing the daemon and its PTYs remains an explicit user action.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
    }

    /// Drop only the app-side control connection. The daemon and its PTYs are
    /// untouched; the next enabled call probes and reconnects.
    pub fn reset_connection(&self) {
        let mut conn = self.conn.lock();
        *conn = None;
        self.incompatible_daemon.store(false, Ordering::SeqCst);
    }

    /// Resolve and cache the bundled `acornd` binary path. On Windows release
    /// builds, first copy the sidecar into `daemon-bin/<version>/acornd.exe`
    /// below the data directory. Running the cached copy keeps NSIS free to
    /// replace the installed sidecar during an update. Debug builds continue
    /// to run the sibling binary directly so rebuilds are visible immediately.
    pub fn cache_binary_path(&self) -> BridgeResult<PathBuf> {
        self.cache_binary_path_from(acorn_platform::executable::sibling_executable("acornd"))
    }

    fn cache_binary_path_from(&self, source: io::Result<PathBuf>) -> BridgeResult<PathBuf> {
        let resolved: io::Result<PathBuf> = (|| {
            let source = source.map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("failed to locate bundled acornd binary: {error}"),
                )
            })?;

            #[cfg(all(windows, not(debug_assertions)))]
            {
                let data_dir = paths::data_dir().map_err(|error| {
                    io::Error::new(
                        error.kind(),
                        format!(
                            "failed to resolve data directory for cached acornd binary {}: {error}",
                            source.display()
                        ),
                    )
                })?;
                cache_versioned_daemon_binary(&source, &data_dir, env!("CARGO_PKG_VERSION"))
            }

            #[cfg(any(not(windows), debug_assertions))]
            Ok(source)
        })();

        let mut cached = self.binary_path.lock();
        match resolved {
            Ok(path) => {
                *cached = DaemonBinaryPath::Ready(path.clone());
                Ok(path)
            }
            Err(error) => {
                *cached = DaemonBinaryPath::Failed {
                    kind: error.kind(),
                    message: error.to_string(),
                };
                Err(BridgeError::Io(error))
            }
        }
    }

    fn binary_path(&self) -> BridgeResult<PathBuf> {
        match &*self.binary_path.lock() {
            DaemonBinaryPath::Unresolved => {
                Err(BridgeError::BinaryNotFound(PathBuf::from("acornd")))
            }
            DaemonBinaryPath::Ready(path) => Ok(path.clone()),
            DaemonBinaryPath::Failed { kind, message } => {
                Err(BridgeError::Io(io::Error::new(*kind, message.clone())))
            }
        }
    }

    /// Ensure a daemon is running and we have a live `ControlConn` to
    /// it. Spawns the daemon if no instance answers the canonical
    /// socket. Returns `Disabled` for explicit lifecycle callers when the
    /// killswitch is off; session RPCs use the private passive-connect path so
    /// already-bound sessions remain controllable without starting a daemon.
    pub fn ensure_connection(&self) -> BridgeResult<()> {
        self.ensure_connection_inner(false)
    }

    fn ensure_connection_for_existing_session(&self) -> BridgeResult<()> {
        self.ensure_connection_inner(true)
    }

    fn ensure_connection_inner(&self, allow_existing_when_disabled: bool) -> BridgeResult<()> {
        let enabled = self.is_enabled();
        if !enabled && !allow_existing_when_disabled {
            return Err(BridgeError::Disabled);
        }
        // Hold the lock across the whole probe/spawn/connect sequence.
        // Releasing it between the `is_some` check and the write let two
        // concurrent callers both observe `None`, both sit in the spawn
        // retry loop (up to the socket-wait timeout each), and the loser's
        // freshly opened connection get silently dropped.
        let mut conn = self.conn.lock();
        if conn.is_some() {
            if !enabled || !self.incompatible_daemon.load(Ordering::SeqCst) {
                return Ok(());
            }

            // An older daemon was preserved for live PTYs. Recheck only while
            // that compatibility state is active; once it becomes idle, drop
            // the stale channel and replace it before servicing this RPC.
            let observed = client::probe_status()?;
            if observed.as_ref().is_some_and(|snapshot| {
                daemon_version_action(snapshot, env!("CARGO_PKG_VERSION"))
                    == DaemonVersionAction::PreserveActive
            }) {
                return Ok(());
            }
            *conn = None;
        }

        let observed = client::probe_status()?;
        if !enabled {
            let Some(snapshot) = observed else {
                return Err(BridgeError::Disabled);
            };
            self.incompatible_daemon.store(
                snapshot.daemon_version != env!("CARGO_PKG_VERSION"),
                Ordering::SeqCst,
            );
            *conn = Some(ControlConn::persistent("acorn-app")?);
            return Ok(());
        }

        let incompatible = self.prepare_enabled_daemon(observed)?;
        *conn = Some(ControlConn::persistent("acorn-app")?);
        self.incompatible_daemon
            .store(incompatible, Ordering::SeqCst);
        Ok(())
    }

    /// Ensure the canonical endpoint is served by this app version unless an
    /// older daemon still owns live PTYs. Returns whether such an older daemon
    /// was deliberately preserved.
    fn prepare_enabled_daemon(&self, observed: Option<StatusSnapshot>) -> BridgeResult<bool> {
        let expected = env!("CARGO_PKG_VERSION");
        match observed {
            None => {
                self.spawn_daemon_with_retries()?;
                self.require_expected_daemon_version(expected)?;
                Ok(false)
            }
            Some(snapshot) => match daemon_version_action(&snapshot, expected) {
                DaemonVersionAction::UseCurrent => Ok(false),
                DaemonVersionAction::PreserveActive => {
                    // One canonical endpoint means the old process remains
                    // the daemon generation for all RPCs, including new
                    // spawns, until every PTY in that generation drains.
                    tracing::warn!(
                        daemon_version = %snapshot.daemon_version,
                        app_version = expected,
                        live_sessions = snapshot.session_count_alive,
                        "preserving older acornd until its live PTYs finish"
                    );
                    Ok(true)
                }
                DaemonVersionAction::RestartIdle => {
                    self.replace_idle_daemon(&snapshot, expected)?;
                    Ok(false)
                }
            },
        }
    }

    fn replace_idle_daemon(&self, snapshot: &StatusSnapshot, expected: &str) -> BridgeResult<()> {
        tracing::info!(
            daemon_version = %snapshot.daemon_version,
            app_version = expected,
            "replacing idle daemon from another app version"
        );
        let response = client::one_shot(ControlPayload::Shutdown)?;
        match Self::unpack_error(response.payload)? {
            ControlResult::Ack => {}
            other => return Err(unexpected(other)),
        }

        let deadline = Instant::now() + SOCKET_WAIT_TIMEOUT;
        while Instant::now() < deadline {
            match client::probe_status()? {
                None => {
                    self.spawn_daemon_with_retries()?;
                    return self.require_expected_daemon_version(expected);
                }
                Some(current) if current.daemon_version == expected => return Ok(()),
                Some(_) => std::thread::sleep(SOCKET_POLL_INTERVAL),
            }
        }
        Err(BridgeError::Io(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "idle acornd {} did not release its endpoint for app {expected}",
                snapshot.daemon_version
            ),
        )))
    }

    fn require_expected_daemon_version(&self, expected: &str) -> BridgeResult<()> {
        let snapshot = client::probe_status()?.ok_or(BridgeError::SpawnTimeout)?;
        if snapshot.daemon_version == expected {
            return Ok(());
        }
        Err(BridgeError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "acornd version mismatch after spawn: expected {expected}, got {}",
                snapshot.daemon_version
            ),
        )))
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
        let path = self.binary_path()?;
        require_daemon_binary(&path)?;
        // `--detach` so the daemon survives the app's exit. Spawn returns
        // immediately; acornd forks on Unix and re-execs on Windows.
        let data_dir = paths::data_dir()?;
        let app_executable = std::env::current_exe().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to locate Acorn executable for daemon trust: {error}"),
            )
        })?;
        let mut command = Command::new(&path);
        command
            .arg("serve")
            .arg("--detach")
            .arg("--app-executable")
            .arg(app_executable)
            .env(paths::ENV_DATA_DIR_OVERRIDE, data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;

            // The first acornd process is only a short-lived detached-process
            // launcher. Suppress its console window as well as the re-exec's.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command.spawn()?;
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
        self.ensure_connection_for_existing_session()?;
        // First attempt over the persistent conn. A concurrent caller's
        // error path can null the cached conn between `ensure_connection`
        // and the lock here, so treat a missing conn as a stale-connection
        // error instead of panicking on it.
        let result = {
            let mut guard = self.conn.lock();
            match guard.as_mut() {
                Some(conn) => conn.call(payload.clone()),
                None => Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "daemon connection dropped concurrently",
                )),
            }
        };
        match result {
            Ok(resp) => Ok(resp.payload),
            Err(e)
                if e.kind() == io::ErrorKind::UnexpectedEof
                    || e.kind() == io::ErrorKind::BrokenPipe
                    || e.kind() == io::ErrorKind::NotConnected =>
            {
                // Stale connection — drop and reconnect once.
                *self.conn.lock() = None;
                self.ensure_connection_for_existing_session()?;
                let mut guard = self.conn.lock();
                let conn = guard.as_mut().ok_or_else(|| {
                    BridgeError::from(io::Error::new(
                        io::ErrorKind::NotConnected,
                        "daemon connection dropped during retry",
                    ))
                })?;
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
    /// alive). Returns `false` on any bridge error; the caller remains on
    /// the sticky daemon route and uses an idempotent SpawnSession retry, so
    /// this fallback cannot create an in-process duplicate.
    pub fn is_alive(&self, id: Uuid) -> bool {
        match self.list_sessions() {
            Ok(sessions) => sessions.iter().any(|s| s.id == id && s.alive),
            Err(_) => false,
        }
    }

    #[allow(clippy::too_many_arguments)]
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
        pixel_width: u16,
        pixel_height: u16,
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
            pixel_width,
            pixel_height,
            kind,
            repo_path,
            branch,
            agent_kind,
            agent_resume_token,
        };
        match Self::unpack_error(self.call(ControlPayload::SpawnSession { spec })?)? {
            ControlResult::SessionSpawned { pid, .. } => Ok(SpawnOutcome { pid }),
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

    pub fn resize(
        &self,
        target: Uuid,
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> BridgeResult<()> {
        match Self::unpack_error(self.call(ControlPayload::Resize {
            target_session_id: target,
            cols,
            rows,
            pixel_width,
            pixel_height,
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
                let mut conn = self.conn.lock();
                *conn = None;
                self.incompatible_daemon.store(false, Ordering::SeqCst);
                Ok(())
            }
            other => Err(unexpected(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonVersionAction {
    UseCurrent,
    RestartIdle,
    PreserveActive,
}

fn daemon_version_action(snapshot: &StatusSnapshot, expected: &str) -> DaemonVersionAction {
    if snapshot.daemon_version == expected {
        DaemonVersionAction::UseCurrent
    } else if snapshot.session_count_alive == 0 {
        DaemonVersionAction::RestartIdle
    } else {
        DaemonVersionAction::PreserveActive
    }
}

fn require_daemon_binary(path: &Path) -> BridgeResult<()> {
    match path.try_exists() {
        Ok(true) => Ok(()),
        Ok(false) => Err(BridgeError::BinaryNotFound(path.to_path_buf())),
        Err(error) => Err(BridgeError::Io(io::Error::new(
            error.kind(),
            format!(
                "failed to inspect acornd binary at {}: {error}",
                path.display()
            ),
        ))),
    }
}

#[cfg(any(all(windows, not(debug_assertions)), test))]
fn versioned_daemon_path(source: &Path, data_dir: &Path, version: &str) -> io::Result<PathBuf> {
    let file_name = source.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("daemon binary has no file name: {}", source.display()),
        )
    })?;
    Ok(data_dir
        .join(DAEMON_BIN_CACHE_DIR)
        .join(version)
        .join(file_name))
}

#[cfg(any(all(windows, not(debug_assertions)), test))]
fn cache_versioned_daemon_binary(
    source: &Path,
    data_dir: &Path,
    version: &str,
) -> io::Result<PathBuf> {
    let destination = versioned_daemon_path(source, data_dir, version)?;
    stage_versioned_daemon_binary(source, data_dir, version).map_err(|error| {
        // Never fall back to running the installed executable: doing so would
        // bring back the NSIS file-lock failure this cache exists to prevent.
        // An invalid existing destination must not run either.
        io::Error::new(
            error.kind(),
            format!(
                "failed to stage cached acornd binary from {} to {}: {error}",
                source.display(),
                destination.display()
            ),
        )
    })
}

/// Copy the bundled daemon to its immutable, package-versioned launch path.
/// An existing non-empty destination is deliberately reused without replace:
/// it may be the executable held open by the currently running daemon.
#[cfg(any(all(windows, not(debug_assertions)), test))]
fn stage_versioned_daemon_binary(
    source: &Path,
    data_dir: &Path,
    version: &str,
) -> io::Result<PathBuf> {
    let destination = versioned_daemon_path(source, data_dir, version)?;

    match fs::symlink_metadata(&destination) {
        Ok(destination_metadata) => {
            validate_cached_daemon_leaf(&destination, &destination_metadata)?;
            if destination_metadata.len() > 0 {
                verify_cached_daemon(source, &destination)?;
                return Ok(destination);
            }
            fs::remove_file(&destination)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "cached daemon destination has no parent: {}",
                destination.display()
            ),
        )
    })?;
    fs::create_dir_all(parent)?;

    let mut source_file = File::open(source)?;
    let source_len = source_file.metadata()?.len();
    if source_len == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("daemon binary is empty: {}", source.display()),
        ));
    }

    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    let copied = io::copy(&mut source_file, staged.as_file_mut())?;
    if copied != source_len {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!(
                "daemon binary changed while copying: expected {source_len} bytes, copied {copied}"
            ),
        ));
    }
    staged.as_file_mut().sync_all()?;

    publish_staged_daemon(staged, source, &destination)
}

#[cfg(any(all(windows, not(debug_assertions)), test))]
fn validate_cached_daemon_leaf(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    if metadata.is_file() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "cached daemon destination is not a regular file: {}",
            path.display()
        ),
    ))
}

#[cfg(any(all(windows, not(debug_assertions)), test))]
fn publish_staged_daemon(
    staged: tempfile::NamedTempFile,
    source: &Path,
    destination: &Path,
) -> io::Result<PathBuf> {
    match staged.persist_noclobber(destination) {
        Ok(_) => Ok(destination.to_path_buf()),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            // Another app instance won the publish race. Apply the same
            // fail-closed content contract as the initial precheck before
            // allowing its destination to become executable.
            verify_cached_daemon(source, destination)?;
            Ok(destination.to_path_buf())
        }
        Err(error) => Err(error.error),
    }
}

#[cfg(any(all(windows, not(debug_assertions)), test))]
fn verify_cached_daemon(source: &Path, destination: &Path) -> io::Result<()> {
    let destination_metadata = fs::symlink_metadata(destination)?;
    validate_cached_daemon_leaf(destination, &destination_metadata)?;
    if files_equal(source, destination)? {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "versioned daemon cache differs from bundled binary: {} != {}",
            destination.display(),
            source.display()
        ),
    ))
}

#[cfg(any(all(windows, not(debug_assertions)), test))]
fn files_equal(left_path: &Path, right_path: &Path) -> io::Result<bool> {
    let mut left = File::open(left_path)?;
    let mut right = File::open(right_path)?;
    let left_len = left.metadata()?.len();
    if left_len != right.metadata()?.len() {
        return Ok(false);
    }

    // Compare fixed-size chunks with read_exact so different short-read
    // boundaries cannot make identical regular files appear different.
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    let mut remaining = left_len;
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(left_buffer.len() as u64))
            .expect("comparison chunk length always fits usize");
        left.read_exact(&mut left_buffer[..chunk_len])?;
        right.read_exact(&mut right_buffer[..chunk_len])?;
        if left_buffer[..chunk_len] != right_buffer[..chunk_len] {
            return Ok(false);
        }
        remaining -= chunk_len as u64;
    }
    Ok(true)
}

fn unexpected(result: ControlResult) -> BridgeError {
    BridgeError::Daemon {
        code: acorn_daemon::protocol::ErrorCode::Internal,
        message: format!("unexpected response: {result:?}"),
    }
}

/// RFC 4648 base64 encoder. Mirrors the daemon's own implementation so
/// the app does not pull in an extra dep — `crate::pty::base64_encode`
/// is module-private, hence duplicated here.
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

    fn status(version: &str, alive: u32) -> StatusSnapshot {
        StatusSnapshot {
            daemon_version: version.to_string(),
            uptime_seconds: 10,
            session_count_total: alive,
            session_count_alive: alive,
            pid: Some(42),
            rss_bytes: None,
        }
    }

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
    fn binary_resolution_access_error_is_retained_for_later_spawns() {
        let bridge = DaemonBridge::new();
        let first = bridge.cache_binary_path_from(Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "current executable is inaccessible",
        )));

        match first {
            Err(BridgeError::Io(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
                assert!(error
                    .to_string()
                    .contains("failed to locate bundled acornd binary"));
            }
            other => panic!("expected retained access error, got {other:?}"),
        }

        match bridge.binary_path() {
            Err(BridgeError::Io(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
                assert!(error
                    .to_string()
                    .contains("current executable is inaccessible"));
            }
            other => panic!("expected cached access error, got {other:?}"),
        }
    }

    #[test]
    fn missing_daemon_binary_remains_not_found() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("missing-acornd");

        match require_daemon_binary(&path) {
            Err(BridgeError::BinaryNotFound(error_path)) => assert_eq!(error_path, path),
            other => panic!("expected BinaryNotFound, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn daemon_binary_probe_preserves_parent_access_error() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let blocked = temp.path().join("blocked");
        let path = blocked.join("acornd");
        std::fs::create_dir(&blocked).unwrap();
        let original_permissions = std::fs::metadata(&blocked).unwrap().permissions();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = require_daemon_binary(&path);

        std::fs::set_permissions(&blocked, original_permissions).unwrap();
        match result {
            Err(BridgeError::Io(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
                assert!(error.to_string().contains(&path.display().to_string()));
            }
            other => panic!("expected permission error, got {other:?}"),
        }
    }

    #[test]
    fn daemon_version_policy_reuses_current_restarts_idle_and_preserves_live() {
        assert_eq!(
            daemon_version_action(&status("2.0.0", 0), "2.0.0"),
            DaemonVersionAction::UseCurrent
        );
        assert_eq!(
            daemon_version_action(&status("1.0.0", 0), "2.0.0"),
            DaemonVersionAction::RestartIdle
        );
        assert_eq!(
            daemon_version_action(&status("1.0.0", 1), "2.0.0"),
            DaemonVersionAction::PreserveActive
        );
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

    #[test]
    fn stages_daemon_in_package_version_directory() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("bundle").join("acornd.exe");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"first daemon binary").unwrap();

        let destination = stage_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap();

        assert_eq!(
            destination,
            temp.path()
                .join(DAEMON_BIN_CACHE_DIR)
                .join("9.8.7")
                .join("acornd.exe")
        );
        assert_eq!(std::fs::read(destination).unwrap(), b"first daemon binary");
    }

    #[test]
    fn reuses_identical_non_empty_version_cache() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("bundle").join("acornd.exe");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"original").unwrap();
        let destination = stage_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap();

        let reused = stage_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap();

        assert_eq!(reused, destination);
        assert_eq!(std::fs::read(destination).unwrap(), b"original");
    }

    #[test]
    fn rejects_same_length_mismatched_version_cache_without_replacing_it() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("bundle").join("acornd.exe");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"original").unwrap();
        let destination = stage_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap();

        // The equal length ensures verification compares bytes rather than
        // treating metadata alone as sufficient. The cache helper must fail
        // closed so spawn_daemon_once cannot execute the stale destination.
        std::fs::write(&source, b"modified").unwrap();
        let error = cache_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error
            .to_string()
            .contains("failed to stage cached acornd binary"));
        assert_eq!(std::fs::read(destination).unwrap(), b"original");
    }

    #[test]
    fn replaces_incomplete_empty_version_cache() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("bundle").join("acornd.exe");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"complete binary").unwrap();
        let destination = versioned_daemon_path(&source, temp.path(), "9.8.7").unwrap();
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(&destination, b"").unwrap();

        let staged = stage_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap();

        assert_eq!(staged, destination);
        assert_eq!(std::fs::read(destination).unwrap(), b"complete binary");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_version_cache_without_touching_target() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("bundle").join("acornd.exe");
        let sentinel = temp.path().join("sentinel.exe");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"expected daemon").unwrap();
        std::fs::write(&sentinel, b"expected daemon").unwrap();
        let destination = versioned_daemon_path(&source, temp.path(), "9.8.7").unwrap();
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        symlink(&sentinel, &destination).unwrap();

        let error = stage_versioned_daemon_binary(&source, temp.path(), "9.8.7").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(std::fs::symlink_metadata(destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(sentinel).unwrap(), b"expected daemon");
    }

    #[test]
    fn file_verification_compares_bytes_across_chunk_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let left = temp.path().join("left.exe");
        let right = temp.path().join("right.exe");
        let bytes = vec![b'A'; 64 * 1024 + 1];
        std::fs::write(&left, &bytes).unwrap();
        std::fs::write(&right, &bytes).unwrap();
        assert!(files_equal(&left, &right).unwrap());

        let mut changed = bytes;
        *changed.last_mut().unwrap() = b'B';
        std::fs::write(&right, changed).unwrap();
        assert!(!files_equal(&left, &right).unwrap());
    }

    #[test]
    fn atomic_publish_race_accepts_only_identical_winner() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("acornd-source.exe");
        let destination = temp.path().join("acornd.exe");
        std::fs::write(&source, b"expected").unwrap();
        std::fs::write(&destination, b"expected").unwrap();
        let staged = tempfile::NamedTempFile::new_in(temp.path()).unwrap();
        std::fs::write(staged.path(), b"expected").unwrap();

        assert_eq!(
            publish_staged_daemon(staged, &source, &destination).unwrap(),
            destination
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_publish_race_rejects_symlinked_winner() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("acornd-source.exe");
        let sentinel = temp.path().join("sentinel.exe");
        let destination = temp.path().join("acornd.exe");
        std::fs::write(&source, b"expected").unwrap();
        std::fs::write(&sentinel, b"expected").unwrap();
        symlink(&sentinel, &destination).unwrap();
        let staged = tempfile::NamedTempFile::new_in(temp.path()).unwrap();
        std::fs::write(staged.path(), b"expected").unwrap();

        let error = publish_staged_daemon(staged, &source, &destination).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(std::fs::symlink_metadata(destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(sentinel).unwrap(), b"expected");
    }

    #[test]
    fn atomic_publish_race_rejects_mismatched_winner() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("acornd-source.exe");
        let destination = temp.path().join("acornd.exe");
        std::fs::write(&source, b"expected").unwrap();
        std::fs::write(&destination, b"modified").unwrap();
        let staged = tempfile::NamedTempFile::new_in(temp.path()).unwrap();
        std::fs::write(staged.path(), b"expected").unwrap();

        let error = publish_staged_daemon(staged, &source, &destination).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(std::fs::read(destination).unwrap(), b"modified");
    }
}
