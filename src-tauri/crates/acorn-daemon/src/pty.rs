//! Daemon-side PTY backend.
//!
//! Conceptually the same as `crate::pty::PtyManager`, with three changes:
//!
//! 1. **No Tauri event emission.** The daemon is process-isolated from the
//!    Acorn app; output bytes land in the per-session `RingBuffer` and a
//!    `tokio::sync::broadcast` channel that attached stream clients
//!    subscribe to. This lets multiple clients (e.g. two Acorn windows
//!    once we lift the single-instance constraint) see the same output
//!    in sync.
//!
//! 2. **Lifetime tied to the PTY child, not to a Tauri AppHandle.** When
//!    the PTY exits, the wait thread detaches the session from both the
//!    live handle map and the `SessionRegistry`.
//!
//! 3. **Argv augmentation hook.** For sessions with a known
//!    `agent_kind`, the spawn helper rewrites argv to inject the
//!    appropriate resume token (e.g. Claude Code's `--session-id
//!    <uuid>`) so a daemon restart recreates the agent's prior
//!    context. Unknown agents pass through unmodified.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use acorn_platform::process::ProcessTree;
use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::protocol::{AgentKind, SpawnSpec};
use super::ring_buffer::{ByteSpan, RingBuffer, RingSnapshot};
use super::session::{DaemonSession, SessionRegistry};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

fn pty_window_size(cols: u16, rows: u16, pixel_width: u16, pixel_height: u16) -> PtySize {
    PtySize {
        cols: if cols == 0 { DEFAULT_COLS } else { cols },
        rows: if rows == 0 { DEFAULT_ROWS } else { rows },
        pixel_width,
        pixel_height,
    }
}

const READ_BUFFER_SIZE: usize = 4096;

/// Tuple returned by `PtyManager::spawn`. The pid is surfaced separately
/// so callers (notably `server::dispatch`) can echo it in the
/// `SessionSpawned` response without re-traversing the registry.
pub struct SpawnedSession {
    pub session_id: Uuid,
    pub pid: Option<u32>,
}
/// Capacity of the per-session broadcast channel (raw byte chunks). Sized
/// to absorb a multi-MB burst before slow consumers force a `RecvError::Lagged`
/// — if a consumer lags, the daemon still has the ring buffer to backfill
/// from on reconnect.
const BROADCAST_CAPACITY: usize = 2048;

/// Per-session backend state held in the PTY manager. The corresponding
/// metadata lives in `SessionRegistry::DaemonSession` — keeping these two
/// stores separate avoids holding `MasterPty` handles inside the read
/// lock the registry uses for list operations.
struct PtyHandle {
    /// Writer cloned from the master end. Wrapped in a `Mutex` because
    /// stdin writes can come from multiple callers (control socket
    /// `SendInput`, stream socket `Input`).
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Master end retained for resize operations.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Kill switch shared with the child. Safe to clone freely.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Owns the complete descendant tree for reliable shutdown on every OS.
    process_tree: ProcessTree,
    /// Reader-loop stop flag. Tripped by `kill()` or by the wait
    /// thread on natural exit so the read loop never spins on a
    /// half-closed PTY.
    stop: Arc<AtomicBool>,
    /// Broadcast channel: every byte chunk read from the PTY goes here
    /// for live consumers. Stored as a `Sender` — drop is the only
    /// teardown signal, no explicit close needed.
    output_tx: broadcast::Sender<OutputChunk>,
    /// Scrollback ring. Same `Arc` as the one in
    /// `DaemonSession::scrollback`; both pointers are clones of the
    /// instance created during `spawn`.
    scrollback: Arc<RingBuffer>,
    /// Exit code captured by the wait thread. Stored on the handle so
    /// active stream subscribers can still emit the exit status after the
    /// daemon registry row has detached.
    exit_code: Arc<Mutex<Option<i32>>>,
}

pub struct PtySubscription {
    pub rx: broadcast::Receiver<OutputChunk>,
    pub exit_code: Arc<Mutex<Option<i32>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputChunk {
    pub bytes: Vec<u8>,
    pub start_seq: u64,
    pub end_seq: u64,
}

impl OutputChunk {
    fn new(bytes: Vec<u8>, span: ByteSpan) -> Self {
        Self {
            bytes,
            start_seq: span.start_seq,
            end_seq: span.end_seq,
        }
    }
}

/// Caller-supplied policy for applying environment variables to the
/// PTY-spawned `CommandBuilder`. The host crate's `pty_env` /
/// `shell_env` modules define the actual layering (login-shell rc env,
/// `TERM`/`COLORTERM`/`LANG` backstops, caller overrides on top) —
/// keeping that logic out of this leaf crate avoids a circular dep on
/// the main `acorn` module graph and lets the daemon binary in the
/// host crate inject the same policy the in-process spawn path uses.
pub type EnvApplier =
    Arc<dyn Fn(&mut CommandBuilder, HashMap<String, String>) + Send + Sync + 'static>;

pub struct PtyManager {
    handles: Arc<DashMap<Uuid, Arc<PtyHandle>>>,
    /// Serializes the check-and-publish portion of spawn so duplicate RPCs
    /// for one UUID cannot both create children before either handle appears.
    spawn_guard: Mutex<()>,
    env_applier: EnvApplier,
}

impl PtyManager {
    /// `env_applier` is invoked once per spawned PTY with the freshly
    /// built `CommandBuilder` and the request's env map; it owns the
    /// layering policy (login-shell env, TERM backstops, etc.).
    pub fn new(env_applier: EnvApplier) -> Arc<Self> {
        Arc::new(Self {
            handles: Arc::new(DashMap::new()),
            spawn_guard: Mutex::new(()),
            env_applier,
        })
    }

    /// Spawn a new PTY child according to `spec`, register it with the
    /// session registry, and start reader / waiter threads. Returns the
    /// session id (taken from `spec.session_id` if `Some`, otherwise a
    /// fresh v4). Repeating a supplied UUID while its PTY is alive returns the
    /// existing identity and pid. This makes a SpawnSession retry idempotent
    /// when the daemon created the child but the client lost the response.
    pub fn spawn(
        &self,
        spec: SpawnSpec,
        registry: Arc<SessionRegistry>,
    ) -> std::io::Result<SpawnedSession> {
        let session_id = spec.session_id.unwrap_or_else(Uuid::new_v4);
        let _spawn_guard = self.spawn_guard.lock();
        if self.handles.contains_key(&session_id) {
            let existing = registry.get(&session_id).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("session {session_id} already has a live pty"),
                )
            })?;
            return Ok(SpawnedSession {
                session_id,
                pid: existing.pid,
            });
        }

        let size = pty_window_size(spec.cols, spec.rows, spec.pixel_width, spec.pixel_height);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| std::io::Error::other(format!("openpty failed: {e}")))?;

        // Augment argv for known agents. The session registry copy keeps
        // the original command + agent metadata so a future respawn can
        // re-apply the strategy.
        let (effective_command, effective_args) = apply_resume_strategy(
            &spec.command,
            &spec.args,
            &spec.agent_kind,
            &spec.agent_resume_token,
        );

        let mut cmd = CommandBuilder::new(&effective_command);
        for arg in &effective_args {
            cmd.arg(arg);
        }
        cmd.cwd(&spec.cwd);
        // Apply the same TERM/COLORTERM/LANG/shell-env layering the
        // in-process `pty::PtyManager` uses, then a backstop that refuses
        // an empty `TERM` / `COLORTERM`. Without this the daemon path
        // shipped raw caller env to the child, which left zsh with an
        // empty TERM whenever the daemon process inherited a sanitized
        // env from launchd-launched Acorn — surfacing as #166's redraw /
        // color regressions whenever the daemon killswitch was on.
        (self.env_applier)(&mut cmd, spec.env.clone());

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(format!("spawn_command failed: {e}")))?;
        let process_tree = ProcessTree::from_portable_child(child.as_ref()).map_err(|err| {
            let _ = child.kill();
            std::io::Error::other(format!("track PTY process tree failed: {err}"))
        })?;
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(format!("take_writer failed: {e}")))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(format!("try_clone_reader failed: {e}")))?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        let scrollback = Arc::new(RingBuffer::new());
        let (output_tx, _output_rx) = broadcast::channel::<OutputChunk>(BROADCAST_CAPACITY);

        let stop = Arc::new(AtomicBool::new(false));
        let exit_code = Arc::new(Mutex::new(None));
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            process_tree,
            stop: stop.clone(),
            output_tx: output_tx.clone(),
            scrollback: scrollback.clone(),
            exit_code,
        });

        self.handles.insert(session_id, Arc::clone(&handle));

        // Register the daemon-side session metadata. The app DB owns
        // the rich form; this is the minimum the daemon needs for
        // reconciliation.
        let mut session =
            DaemonSession::new(session_id, spec.name.clone(), spec.kind, spec.cwd.clone());
        session.repo_path = spec.repo_path.clone();
        session.branch = spec.branch.clone();
        session.agent_kind = spec.agent_kind;
        session.agent_resume_token = spec.agent_resume_token.clone();
        session.scrollback = Arc::clone(&scrollback);
        session.pid = pid;
        // Capture the staged-dotfile fingerprint from caller env so the
        // app can detect, on boot, that this session was spawned by an
        // older build with different rc bodies and force-respawn it.
        session.staged_rev = spec.env.get("ACORN_STAGED_REV").cloned();
        session.ipc_capability = spec
            .env
            .get("ACORN_IPC_CAPABILITY")
            .and_then(|value| Uuid::parse_str(value).ok());
        let created_at = session.created_at;
        registry.insert(session);

        let handle_reader = Arc::clone(&handle);
        std::thread::Builder::new()
            .name(format!("acornd-pty-read-{session_id}"))
            .spawn(move || {
                read_loop(reader, handle_reader);
            })?;

        let handles_for_wait = Arc::clone(&self.handles);
        let handle_for_wait = Arc::clone(&handle);
        let registry_for_wait = registry.clone();
        std::thread::Builder::new()
            .name(format!("acornd-pty-wait-{session_id}"))
            .spawn(move || {
                wait_loop(
                    child,
                    session_id,
                    handle_for_wait,
                    pid,
                    created_at,
                    handles_for_wait,
                    registry_for_wait,
                    stop,
                );
            })?;

        Ok(SpawnedSession { session_id, pid })
    }

    pub fn write(&self, id: &Uuid, data: &[u8]) -> std::io::Result<()> {
        let handle = self
            .handles
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("no pty for {id}"))
            })?;
        let mut writer = handle.writer.lock();
        writer.write_all(data)?;
        writer.flush()
    }

    pub fn resize(
        &self,
        id: &Uuid,
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> std::io::Result<()> {
        let handle = self
            .handles
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("no pty for {id}"))
            })?;
        let size = pty_window_size(cols, rows, pixel_width, pixel_height);
        // Bind MutexGuard to a local so it drops before `handle` does —
        // returning the chain directly leaves the guard alive past
        // `handle`'s end-of-scope, which the borrow checker rejects.
        let master = handle.master.lock();
        master
            .resize(size)
            .map_err(|e| std::io::Error::other(format!("resize failed: {e}")))?;
        drop(master);
        Ok(())
    }

    pub fn kill(&self, id: &Uuid) -> std::io::Result<()> {
        let handle = self
            .handles
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("no pty for {id}"))
            })?;
        handle.stop.store(true, Ordering::SeqCst);
        if let Err(tree_err) = handle.process_tree.terminate() {
            let mut killer = handle.killer.lock();
            killer.kill().map_err(|kill_err| {
                std::io::Error::other(format!(
                    "process-tree kill failed ({tree_err}); child kill failed ({kill_err})"
                ))
            })?;
        }
        Ok(())
    }

    /// Terminate every live PTY tree. Shutdown is best-effort across
    /// sessions, but reports the first failure after attempting them all.
    pub fn kill_all(&self) -> std::io::Result<()> {
        let ids = self
            .handles
            .iter()
            .map(|entry| *entry.key())
            .collect::<Vec<_>>();
        let mut first_error = None;
        for id in ids {
            if let Err(err) = self.kill(&id) {
                first_error.get_or_insert(err);
            }
        }
        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Subscribe to a session's live output stream. The returned receiver
    /// gets every byte chunk read from the PTY from this point on; for
    /// the pre-existing scrollback, the caller should also call
    /// `scrollback_snapshot`. Returns `None` if no live PTY is registered
    /// for the session.
    pub fn subscribe(&self, id: &Uuid) -> Option<PtySubscription> {
        self.handles.get(id).map(|r| {
            let handle = r.value();
            PtySubscription {
                rx: handle.output_tx.subscribe(),
                exit_code: Arc::clone(&handle.exit_code),
            }
        })
    }

    /// Snapshot the current scrollback ring without subscribing to live
    /// updates. Used in concert with `subscribe` on attach.
    pub fn scrollback_snapshot(&self, id: &Uuid) -> Option<RingSnapshot> {
        self.handles
            .get(id)
            .map(|r| r.value().scrollback.snapshot_with_seq())
    }

    pub fn contains(&self, id: &Uuid) -> bool {
        self.handles.contains_key(id)
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        let _ = self.kill_all();
    }
}

/// Resume-strategy dispatcher. Folds the `agent_kind` + `agent_resume_token`
/// pair onto the argv that will actually be exec'd. Single seam for
/// registry growth — Claude Code is implemented today; aider / llm /
/// open-interpreter / codex are passthrough until their resume
/// protocols are verified end-to-end.
fn apply_resume_strategy(
    command: &str,
    args: &[String],
    agent_kind: &Option<AgentKind>,
    resume_token: &Option<String>,
) -> (String, Vec<String>) {
    let Some(kind) = agent_kind else {
        return (command.to_string(), args.to_vec());
    };
    let Some(token) = resume_token else {
        return (command.to_string(), args.to_vec());
    };
    match kind {
        AgentKind::ClaudeCode => {
            // Claude Code accepts `--session-id <uuid>` to bind the
            // session JSONL to a caller-chosen UUID. Daemon injects
            // its own UUID on first spawn, then re-injects on every
            // respawn so a crash-recovery cycle preserves chat history.
            // We inject ONLY if the user hasn't already passed it
            // explicitly (e.g. via `claude --session-id ...` in the
            // session's startup command).
            let already_set = args.iter().any(|a| a == "--session-id");
            if already_set {
                return (command.to_string(), args.to_vec());
            }
            let mut new_args = Vec::with_capacity(args.len() + 2);
            new_args.push("--session-id".to_string());
            new_args.push(token.clone());
            new_args.extend(args.iter().cloned());
            (command.to_string(), new_args)
        }
        // Other agents passthrough. Each new agent's resume protocol
        // gets verified end-to-end before earning its own match arm —
        // shipping a half-implemented strategy that silently breaks
        // resume is worse than no strategy at all.
        AgentKind::Aider
        | AgentKind::Llm
        | AgentKind::OpenInterpreter
        | AgentKind::Codex
        | AgentKind::Antigravity
        | AgentKind::Grok
        | AgentKind::Unknown => (command.to_string(), args.to_vec()),
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, handle: Arc<PtyHandle>) {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    let mut xtversion = acorn_platform::xtversion::XtversionProbe::default();
    loop {
        if handle.stop.load(Ordering::SeqCst) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                let chunk = &buf[..n];
                let hits = xtversion.push(chunk);
                if hits > 0 {
                    let mut writer = handle.writer.lock();
                    acorn_platform::xtversion::write_replies(hits, writer.as_mut());
                }
                let span = handle.scrollback.push_tracked(chunk);
                // Broadcast is a best-effort delivery; if no clients are
                // attached, the send fails and we drop the chunk for
                // them. The scrollback ring is the safety net on
                // reattach.
                if let Some(span) = span {
                    let _ = handle
                        .output_tx
                        .send(OutputChunk::new(chunk.to_vec(), span));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn wait_loop(
    mut child: Box<dyn Child + Send + Sync>,
    session_id: Uuid,
    expected_handle: Arc<PtyHandle>,
    expected_pid: Option<u32>,
    expected_created_at: chrono::DateTime<chrono::Utc>,
    handles: Arc<DashMap<Uuid, Arc<PtyHandle>>>,
    registry: Arc<SessionRegistry>,
    stop: Arc<AtomicBool>,
) {
    let code = match child.wait() {
        Ok(status) => Some(status.exit_code() as i32),
        Err(_) => None,
    };
    *expected_handle.exit_code.lock() = code;
    stop.store(true, Ordering::SeqCst);
    handles.remove_if(&session_id, |_, current| {
        Arc::ptr_eq(current, &expected_handle)
    });
    registry.detach_if_current(&session_id, expected_pid, expected_created_at);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[cfg(any(unix, windows))]
    fn long_running_test_spec(id: Uuid) -> SpawnSpec {
        #[cfg(unix)]
        let (command, args) = ("/bin/cat".to_string(), Vec::new());
        #[cfg(windows)]
        let (command, args) = ("cmd.exe".to_string(), vec!["/Q".to_string()]);

        SpawnSpec {
            session_id: Some(id),
            name: "idempotent-spawn".to_string(),
            cwd: std::env::current_dir().unwrap(),
            command,
            args,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
            kind: crate::protocol::SessionKind::Regular,
            repo_path: None,
            branch: None,
            agent_resume_token: None,
            agent_kind: None,
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn repeated_live_session_uuid_returns_existing_pty() {
        let manager = PtyManager::new(Arc::new(|_, _| {}));
        let registry = SessionRegistry::new();
        let id = Uuid::new_v4();
        let spec = long_running_test_spec(id);

        let first = manager.spawn(spec.clone(), registry.clone()).unwrap();
        let repeated = manager.spawn(spec, registry.clone()).unwrap();

        assert_eq!(repeated.session_id, first.session_id);
        assert_eq!(repeated.pid, first.pid);
        assert_eq!(registry.count_alive(), 1);
        manager.kill(&id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn repeated_targeted_kills_release_daemon_state_and_preserve_sibling() {
        let manager = PtyManager::new(Arc::new(|_, _| {}));
        let registry = SessionRegistry::new();
        let scratch = std::env::temp_dir().join(format!(
            "acorn-daemon-pty-kill-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&scratch).expect("create daemon PTY scratch directory");
        let sibling_id = Uuid::new_v4();
        let sibling = manager
            .spawn(long_running_test_spec(sibling_id), registry.clone())
            .expect("spawn unrelated daemon PTY");
        let sibling_pid = sibling.pid.expect("unrelated daemon PTY pid");
        let mut killed_pids = Vec::new();

        for cycle in 0..12 {
            let id = Uuid::new_v4();
            let descendant_pid_path = scratch.join(format!("descendant-{cycle}.pid"));
            let mut spec = long_running_test_spec(id);
            spec.command = "/bin/sh".to_string();
            spec.args = vec![
                "-c".to_string(),
                format!(
                    "sleep 30 & echo $! > '{}' && wait",
                    descendant_pid_path.display()
                ),
            ];
            let spawned = manager
                .spawn(spec, registry.clone())
                .expect("spawn daemon PTY tree");
            let root_pid = spawned.pid.expect("daemon PTY root pid");
            wait_until(Duration::from_secs(5), || descendant_pid_path.exists());
            let descendant_pid = std::fs::read_to_string(&descendant_pid_path)
                .expect("read daemon descendant pid")
                .trim()
                .parse::<u32>()
                .expect("parse daemon descendant pid");
            assert!(pid_is_alive(root_pid));
            assert!(pid_is_alive(descendant_pid));

            manager.kill(&id).expect("kill daemon PTY tree");
            wait_until(Duration::from_secs(5), || {
                !manager.handles.contains_key(&id)
                    && registry.get(&id).is_none()
                    && !pid_is_alive(root_pid)
                    && !pid_is_alive(descendant_pid)
            });
            assert!(manager.handles.contains_key(&sibling_id));
            assert!(registry.get(&sibling_id).is_some());
            assert!(pid_is_alive(sibling_pid));
            killed_pids.extend([root_pid, descendant_pid]);
        }

        assert_eq!(manager.handles.len(), 1);
        assert_eq!(registry.count_total(), 1);
        assert!(killed_pids.iter().all(|pid| !pid_is_alive(*pid)));
        assert!(pid_is_alive(sibling_pid));

        manager
            .kill(&sibling_id)
            .expect("kill unrelated daemon test PTY");
        wait_until(Duration::from_secs(5), || {
            manager.handles.is_empty() && registry.count_total() == 0 && !pid_is_alive(sibling_pid)
        });
        std::fs::remove_dir_all(&scratch).expect("remove daemon PTY scratch directory");
    }

    #[cfg(unix)]
    fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "condition did not become true before {timeout:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    #[cfg(windows)]
    #[test]
    fn powershell_conpty_accepts_input_resize_and_captures_output() {
        let manager = PtyManager::new(Arc::new(|_, _| {}));
        let registry = SessionRegistry::new();
        let id = Uuid::new_v4();
        let mut spec = long_running_test_spec(id);
        spec.command = "powershell.exe".to_string();
        spec.args = vec!["-NoLogo".to_string(), "-NoProfile".to_string()];

        manager.spawn(spec, registry).unwrap();
        manager.resize(&id, 101, 37, 0, 0).unwrap();

        // Interactive PowerShell asks the terminal for its cursor position
        // before presenting the first prompt. xterm.js answers this DSR in the
        // app; this headless test must provide the same terminal response or
        // PSReadLine waits indefinitely before consuming typed input.
        let startup_deadline = Instant::now() + Duration::from_secs(10);
        let mut answered_cursor_queries = 0;
        let mut startup_output = String::new();
        let mut prompt_ready = false;
        while Instant::now() < startup_deadline {
            startup_output = manager
                .scrollback_snapshot(&id)
                .map(|snapshot| String::from_utf8_lossy(&snapshot.bytes).into_owned())
                .unwrap_or_default();
            let cursor_queries = startup_output.matches("\u{1b}[6n").count();
            while answered_cursor_queries < cursor_queries {
                manager.write(&id, b"\x1b[1;1R").unwrap();
                answered_cursor_queries += 1;
            }
            // Seeing the cursor query only means PowerShell has started its
            // terminal setup. Wait for the first prompt so input cannot race
            // PSReadLine initialization on slower Windows runners.
            if startup_output.contains("PS ") && startup_output.contains("> ") {
                prompt_ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if !prompt_ready {
            manager.kill(&id).unwrap();
            panic!("PowerShell prompt missing from ConPTY output: {startup_output:?}");
        }
        std::thread::sleep(Duration::from_millis(100));

        manager
            .write(
                &id,
                b"$Host.UI.RawUI.WindowSize; Write-Output 'ACORN_WINDOWS_PTY_OK'\r",
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = String::new();
        while Instant::now() < deadline {
            output = manager
                .scrollback_snapshot(&id)
                .map(|snapshot| String::from_utf8_lossy(&snapshot.bytes).into_owned())
                .unwrap_or_default();
            let cursor_queries = output.matches("\u{1b}[6n").count();
            while answered_cursor_queries < cursor_queries {
                manager.write(&id, b"\x1b[1;1R").unwrap();
                answered_cursor_queries += 1;
            }
            if output.contains("ACORN_WINDOWS_PTY_OK") && output.contains("101") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        manager.kill(&id).unwrap();
        assert!(
            output.contains("ACORN_WINDOWS_PTY_OK"),
            "PowerShell marker missing from ConPTY output: {output:?}"
        );
        assert!(
            output.contains("101"),
            "resized PowerShell width missing from ConPTY output: {output:?}"
        );
    }

    #[test]
    fn resume_strategy_injects_claude_session_id() {
        let token = "11111111-1111-1111-1111-111111111111".to_string();
        let (cmd, args) = apply_resume_strategy(
            "claude",
            &[],
            &Some(AgentKind::ClaudeCode),
            &Some(token.clone()),
        );
        assert_eq!(cmd, "claude");
        assert_eq!(args, vec!["--session-id", &token]);
    }

    #[test]
    fn resume_strategy_respects_user_provided_session_id() {
        let token = "11111111-1111-1111-1111-111111111111".to_string();
        let user_args = vec!["--session-id".to_string(), "user-set".to_string()];
        let (_, args) = apply_resume_strategy(
            "claude",
            &user_args,
            &Some(AgentKind::ClaudeCode),
            &Some(token),
        );
        // User's explicit value wins — daemon does not double-inject.
        assert_eq!(args, user_args);
    }

    #[test]
    fn resume_strategy_passes_through_unknown_agents() {
        let (cmd, args) = apply_resume_strategy(
            "vim",
            &["foo.txt".into()],
            &Some(AgentKind::Unknown),
            &Some("ignored".into()),
        );
        assert_eq!(cmd, "vim");
        assert_eq!(args, vec!["foo.txt"]);
    }

    #[test]
    fn resume_strategy_noops_without_kind_or_token() {
        let (cmd, args) = apply_resume_strategy("ls", &[], &None, &Some("t".into()));
        assert_eq!(cmd, "ls");
        assert!(args.is_empty());

        let (cmd, args) = apply_resume_strategy("ls", &[], &Some(AgentKind::ClaudeCode), &None);
        assert_eq!(cmd, "ls");
        assert!(args.is_empty());
    }
}
