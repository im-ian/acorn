//! Daemon-side session registry.
//!
//! Per Q8 of the design: the Acorn app's `sessions.json` remains the
//! source-of-truth for rich session metadata (name, branch, ordering,
//! status, claude_session_id, etc.). The daemon keeps the *minimum*
//! identity it needs to:
//!
//! 1. Spawn a new PTY when asked.
//! 2. Tell the app what PTYs it currently holds (so the app can reconcile
//!    its DB on boot — orphans become "adopt?" prompts; ghosts become
//!    "resume from disk?" prompts).
//! 3. Scope `acornd` CLI ops by project (a control session in project A
//!    cannot see sessions from project B).
//!
//! Anything else (timestamps for ordering, last-message previews, etc.)
//! stays in the app DB. The daemon-side struct here is intentionally
//! smaller than `crate::session::Session`.

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

use super::protocol::{AgentKind, SessionKind};
use super::ring_buffer::RingBuffer;

/// Minimum identity + metadata the daemon needs per session.
///
/// `Arc<RingBuffer>` so the read loop (writer) and any attached streams
/// (readers) can share the buffer without cloning bytes. The PTY child
/// state itself lives in `daemon::pty` — this struct does not own the
/// `portable-pty` handle to keep the registry lock-free of long-held
/// `MasterPty` references.
#[derive(Clone)]
pub struct DaemonSession {
    pub id: Uuid,
    pub name: String,
    pub kind: SessionKind,
    /// Working directory the child was spawned in. Mirrored back to the
    /// app on adopt so the app can rebuild its `Session.worktree_path`.
    pub cwd: PathBuf,
    /// Project root (git repo) the session belongs to. Used to scope
    /// `acornd` CLI ops to siblings within the same project. `None` for
    /// sessions spawned without a repo (rare; legacy migration path).
    pub repo_path: Option<PathBuf>,
    /// Branch label for telemetry. Not used in any decision logic.
    pub branch: Option<String>,
    /// Agent runtime classification. Drives the resume strategy registry
    /// (Q7 — Claude Code uses `--session-id <uuid>`; aider uses cwd-local
    /// `.aider.chat.history.md`; etc.).
    pub agent_kind: Option<AgentKind>,
    /// Resume token paired with `agent_kind`. For Claude Code this is
    /// the deterministic session UUID the daemon injects into argv on
    /// every (re)spawn so the JSONL file stays addressable.
    pub agent_resume_token: Option<String>,
    /// Scrollback ring. Shared between the PTY reader and attached
    /// streams; both sides use `Arc::clone` to avoid double-buffering.
    pub scrollback: Arc<RingBuffer>,
    /// `true` while the PTY child is still alive. Flipped to `false` by
    /// the wait thread on child exit; the metadata row stays in the
    /// registry until `ForgetSession` is called (so ghost UI can render).
    pub alive: bool,
    /// Exit code captured when `alive` flipped to `false`. `None` while
    /// alive or when the child exit could not be observed (wait error).
    pub exit_code: Option<i32>,
    /// Daemon-local creation time. Useful for "Background sessions"
    /// status panel ordering and for telemetry on long-lived sessions.
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl DaemonSession {
    pub fn new(spec_id: Uuid, name: String, kind: SessionKind, cwd: PathBuf) -> Self {
        Self {
            id: spec_id,
            name,
            kind,
            cwd,
            repo_path: None,
            branch: None,
            agent_kind: None,
            agent_resume_token: None,
            scrollback: Arc::new(RingBuffer::new()),
            alive: true,
            exit_code: None,
            created_at: chrono::Utc::now(),
        }
    }
}

/// Concurrent registry of daemon-managed sessions. `RwLock<HashMap>`
/// because the access pattern is many concurrent reads (list / probe)
/// and rare writes (spawn / kill / exit). Wrapped in `Arc` so accept
/// loop threads, the spawn thread, and the wait thread can share it.
#[derive(Default)]
pub struct SessionRegistry {
    inner: RwLock<HashMap<Uuid, DaemonSession>>,
}

impl SessionRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Insert a freshly spawned session. Returns the prior value (if any)
    /// so the caller can detect the rare "UUID collision" case. App-side
    /// spawn always supplies a v4 UUID; the daemon never overwrites
    /// silently.
    pub fn insert(&self, session: DaemonSession) -> Option<DaemonSession> {
        let mut map = self.inner.write();
        map.insert(session.id, session)
    }

    pub fn get(&self, id: &Uuid) -> Option<DaemonSession> {
        self.inner.read().get(id).cloned()
    }

    /// Snapshot every session the daemon knows about, including dead
    /// ones. Cloned so the caller does not hold the read lock for the
    /// duration of any I/O it performs with the result.
    pub fn list(&self) -> Vec<DaemonSession> {
        self.inner.read().values().cloned().collect()
    }

    /// Mark a session as dead with the given exit code. Idempotent: a
    /// double-mark from racing read/wait paths is benign — the second
    /// call leaves the existing exit_code in place if it is `Some`.
    pub fn mark_dead(&self, id: &Uuid, exit_code: Option<i32>) {
        let mut map = self.inner.write();
        if let Some(entry) = map.get_mut(id) {
            entry.alive = false;
            if entry.exit_code.is_none() {
                entry.exit_code = exit_code;
            }
        }
    }

    /// Permanently remove a session. The caller must have killed the PTY
    /// first if it was alive (the daemon returns `Invalid` on Forget of
    /// an alive session — see `server::handle_forget_session`).
    pub fn forget(&self, id: &Uuid) -> Option<DaemonSession> {
        self.inner.write().remove(id)
    }

    pub fn count_total(&self) -> usize {
        self.inner.read().len()
    }

    pub fn count_alive(&self) -> usize {
        self.inner.read().values().filter(|s| s.alive).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn mk(id: Uuid) -> DaemonSession {
        DaemonSession::new(
            id,
            format!("test-{id}"),
            SessionKind::Regular,
            PathBuf::from("/tmp"),
        )
    }

    #[test]
    fn insert_and_get_roundtrips() {
        let reg = SessionRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(mk(id));
        assert!(reg.get(&id).is_some());
        assert_eq!(reg.count_total(), 1);
        assert_eq!(reg.count_alive(), 1);
    }

    #[test]
    fn mark_dead_leaves_session_in_registry() {
        let reg = SessionRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(mk(id));
        reg.mark_dead(&id, Some(0));
        let s = reg.get(&id).unwrap();
        assert!(!s.alive);
        assert_eq!(s.exit_code, Some(0));
        assert_eq!(reg.count_total(), 1);
        assert_eq!(reg.count_alive(), 0);
    }

    #[test]
    fn forget_removes_session() {
        let reg = SessionRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(mk(id));
        let removed = reg.forget(&id);
        assert!(removed.is_some());
        assert_eq!(reg.count_total(), 0);
    }

    #[test]
    fn mark_dead_is_idempotent_on_exit_code() {
        let reg = SessionRegistry::new();
        let id = Uuid::new_v4();
        reg.insert(mk(id));
        reg.mark_dead(&id, Some(7));
        reg.mark_dead(&id, Some(99)); // racing second mark
        assert_eq!(reg.get(&id).unwrap().exit_code, Some(7));
    }
}
