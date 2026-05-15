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
//! 2. **Lifetime tied to the registry, not to a Tauri AppHandle.** When
//!    the PTY exits, the wait thread marks the session dead in the
//!    `SessionRegistry` but does NOT remove it. Whether to render a
//!    ghost or hide the session is the app's choice; the daemon just
//!    preserves the truth.
//!
//! 3. **Argv augmentation hook.** For sessions with a known
//!    `agent_kind`, the spawn helper rewrites argv to inject the
//!    appropriate resume token (e.g. Claude Code's `--session-id
//!    <uuid>`) so a daemon restart recreates the agent's prior
//!    context. Unknown agents pass through unmodified.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{
    Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system,
};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::protocol::{AgentKind, SpawnSpec};
use super::ring_buffer::RingBuffer;
use super::session::{DaemonSession, SessionRegistry};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
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
    /// Reader-loop stop flag. Tripped by `kill()` or by the wait
    /// thread on natural exit so the read loop never spins on a
    /// half-closed PTY.
    stop: Arc<AtomicBool>,
    /// Broadcast channel: every byte chunk read from the PTY goes here
    /// for live consumers. Stored as a `Sender` — drop is the only
    /// teardown signal, no explicit close needed.
    output_tx: broadcast::Sender<Vec<u8>>,
    /// Scrollback ring. Same `Arc` as the one in
    /// `DaemonSession::scrollback`; both pointers are clones of the
    /// instance created during `spawn`.
    scrollback: Arc<RingBuffer>,
}

#[derive(Default)]
pub struct PtyManager {
    handles: Arc<DashMap<Uuid, Arc<PtyHandle>>>,
}

impl PtyManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Spawn a new PTY child according to `spec`, register it with the
    /// session registry, and start reader / waiter threads. Returns the
    /// session id (taken from `spec.session_id` if `Some`, otherwise a
    /// fresh v4). Idempotent in the absence of a UUID collision — duplicate
    /// IDs are rejected with an `AlreadyExists` IO error.
    pub fn spawn(
        &self,
        spec: SpawnSpec,
        registry: Arc<SessionRegistry>,
    ) -> std::io::Result<SpawnedSession> {
        let session_id = spec.session_id.unwrap_or_else(Uuid::new_v4);
        if self.handles.contains_key(&session_id) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("session {session_id} already has a live pty"),
            ));
        }

        let size = PtySize {
            cols: if spec.cols == 0 { DEFAULT_COLS } else { spec.cols },
            rows: if spec.rows == 0 { DEFAULT_ROWS } else { spec.rows },
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| std::io::Error::other(format!("openpty failed: {e}")))?;

        // Augment argv for known agents. The session registry copy keeps
        // the original command + agent metadata so a future respawn can
        // re-apply the strategy.
        let (effective_command, effective_args) =
            apply_resume_strategy(&spec.command, &spec.args, &spec.agent_kind, &spec.agent_resume_token);

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
        crate::pty_env::apply_layered_env(&mut cmd, spec.env.clone());

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(format!("spawn_command failed: {e}")))?;
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
        let (output_tx, _output_rx) = broadcast::channel::<Vec<u8>>(BROADCAST_CAPACITY);

        let stop = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            stop: stop.clone(),
            output_tx: output_tx.clone(),
            scrollback: scrollback.clone(),
        });

        self.handles.insert(session_id, Arc::clone(&handle));

        // Register the daemon-side session metadata. The app DB owns
        // the rich form; this is the minimum the daemon needs for
        // reconciliation.
        let mut session = DaemonSession::new(session_id, spec.name.clone(), spec.kind, spec.cwd.clone());
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
        registry.insert(session);

        let stop_reader = stop.clone();
        let scrollback_reader = scrollback.clone();
        let output_tx_reader = output_tx.clone();
        std::thread::Builder::new()
            .name(format!("acornd-pty-read-{session_id}"))
            .spawn(move || {
                read_loop(reader, stop_reader, scrollback_reader, output_tx_reader);
            })?;

        let handles_for_wait = Arc::clone(&self.handles);
        let registry_for_wait = registry.clone();
        std::thread::Builder::new()
            .name(format!("acornd-pty-wait-{session_id}"))
            .spawn(move || {
                wait_loop(child, session_id, handles_for_wait, registry_for_wait, stop);
            })?;

        Ok(SpawnedSession {
            session_id,
            pid,
        })
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

    pub fn resize(&self, id: &Uuid, cols: u16, rows: u16) -> std::io::Result<()> {
        let handle = self
            .handles
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("no pty for {id}"))
            })?;
        let size = PtySize {
            cols: if cols == 0 { DEFAULT_COLS } else { cols },
            rows: if rows == 0 { DEFAULT_ROWS } else { rows },
            pixel_width: 0,
            pixel_height: 0,
        };
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
        let mut killer = handle.killer.lock();
        killer
            .kill()
            .map_err(|e| std::io::Error::other(format!("kill failed: {e}")))?;
        drop(killer);
        Ok(())
    }

    /// Subscribe to a session's live output stream. The returned receiver
    /// gets every byte chunk read from the PTY from this point on; for
    /// the pre-existing scrollback, the caller should also call
    /// `scrollback_snapshot`. Returns `None` if no live PTY is registered
    /// for the session (the session may be dead — caller should fall
    /// back to the registry's ring buffer if it still exists).
    pub fn subscribe(&self, id: &Uuid) -> Option<broadcast::Receiver<Vec<u8>>> {
        self.handles
            .get(id)
            .map(|r| r.value().output_tx.subscribe())
    }

    /// Snapshot the current scrollback ring without subscribing to live
    /// updates. Used in concert with `subscribe` on attach.
    pub fn scrollback_snapshot(&self, id: &Uuid) -> Option<Vec<u8>> {
        self.handles
            .get(id)
            .map(|r| r.value().scrollback.snapshot())
    }

    pub fn contains(&self, id: &Uuid) -> bool {
        self.handles.contains_key(id)
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
        | AgentKind::Unknown => (command.to_string(), args.to_vec()),
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    stop: Arc<AtomicBool>,
    scrollback: Arc<RingBuffer>,
    output_tx: broadcast::Sender<Vec<u8>>,
) {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                let chunk = &buf[..n];
                scrollback.push(chunk);
                // Broadcast is a best-effort delivery; if no clients are
                // attached, the send fails and we drop the chunk for
                // them. The scrollback ring is the safety net on
                // reattach.
                let _ = output_tx.send(chunk.to_vec());
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn wait_loop(
    mut child: Box<dyn Child + Send + Sync>,
    session_id: Uuid,
    handles: Arc<DashMap<Uuid, Arc<PtyHandle>>>,
    registry: Arc<SessionRegistry>,
    stop: Arc<AtomicBool>,
) {
    let code = match child.wait() {
        Ok(status) => Some(status.exit_code() as i32),
        Err(_) => None,
    };
    stop.store(true, Ordering::SeqCst);
    handles.remove(&session_id);
    registry.mark_dead(&session_id, code);
}

#[cfg(test)]
mod tests {
    use super::*;

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
