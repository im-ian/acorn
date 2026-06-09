use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::daemon_bridge::DaemonBridge;
use crate::daemon_stream::StreamRegistry;
use crate::fs_explorer::WatcherState;
use crate::ipc::server::IpcServerHandle;
use crate::pty_output::PtyOutputRouter;
use crate::staged_rev_reconcile::StagedRevMismatch;
use acorn_pty::PtyManager;
use acorn_session::{ProjectStore, SessionStore};

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<SessionStore>,
    pub projects: Arc<ProjectStore>,
    pub pty: Arc<PtyManager>,
    /// Raw-byte output channels registered by renderer terminals. PTY output
    /// falls back to the legacy base64 event path when no channel is active.
    pub pty_output: Arc<PtyOutputRouter>,
    /// Set to false at boot if `persistence::load_sessions_with_status`
    /// reported a recoverable load failure (file existed but could not be
    /// read or parsed). Frontend reads this via `load_status` and skips the
    /// pane-wipe code path so a transient disk glitch does not erase the
    /// persisted layout. Defaults to true (clean) for fresh installs.
    pub sessions_loaded_cleanly: Arc<AtomicBool>,
    pub projects_loaded_cleanly: Arc<AtomicBool>,
    /// Shutdown handle for the currently running IPC listener thread.
    /// `None` when bind failed at boot. `ipc_restart` swaps in a new handle
    /// after signaling the previous listener to exit.
    pub ipc_handle: Arc<Mutex<Option<IpcServerHandle>>>,
    /// Bridge to the out-of-process `acornd` daemon. Owns the cached
    /// persistent control connection + the killswitch toggle. Always
    /// constructed; calls short-circuit cleanly when the user has the
    /// daemon disabled in Settings.
    pub daemon_bridge: Arc<DaemonBridge>,
    /// Per-session stream attachments to the daemon. Populated by the
    /// daemon path of `pty_spawn` and drained by `pty_kill`. Lookup is
    /// the "is this session daemon-managed and currently attached?"
    /// check the dispatch helpers use to decide between daemon and
    /// in-process routing on subsequent calls.
    pub stream_registry: Arc<StreamRegistry>,
    /// Result of the boot-time staged-dotfile reconcile. `Some` when
    /// the daemon owns PTYs spawned against older rc bodies; `None`
    /// when in sync or reconcile has not run. Frontend pulls this at
    /// mount so a listener registered after the matching emit still
    /// sees the prompt.
    pub staged_rev_mismatch: Arc<Mutex<Option<StagedRevMismatch>>>,
    /// Filesystem watcher for the right-panel file explorer. Holds a single
    /// recursive watcher rooted at the active session's cwd; rebound by
    /// `fs_watch_set_root` whenever the active tab (or its cwd) changes.
    pub fs_watcher: Arc<WatcherState>,
    /// Local HTTP endpoint used by provider hook scripts to report agent
    /// lifecycle events back into Acorn. `None` means bind failed; PTY
    /// spawning still works and falls back to existing polling.
    pub agent_hooks: Arc<Mutex<Option<Arc<crate::agent_hooks::AgentHookServer>>>>,
    /// Folder paths selected through a native backend dialog during this app
    /// run. Commands that create new trust roots consult this before accepting
    /// a renderer-supplied path.
    pub folder_grants: Arc<Mutex<Vec<PathBuf>>>,
    /// Individual files explicitly handed to Acorn through native OS drag/drop
    /// during this app run. The readonly viewer may read these exact files even
    /// when they live outside registered project roots.
    pub external_file_grants: Arc<Mutex<Vec<PathBuf>>>,
    /// Running native chat provider processes, keyed by Acorn session id.
    /// The cancel command uses this to kill the one-shot provider child and
    /// let the running turn settle as cancelled.
    pub chat_runs: Arc<crate::chat_runs::ChatRunRegistry>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: SessionStore::new(),
            projects: ProjectStore::new(),
            pty: PtyManager::new(),
            pty_output: Arc::new(PtyOutputRouter::default()),
            sessions_loaded_cleanly: Arc::new(AtomicBool::new(true)),
            projects_loaded_cleanly: Arc::new(AtomicBool::new(true)),
            ipc_handle: Arc::new(Mutex::new(None)),
            daemon_bridge: DaemonBridge::new(),
            stream_registry: StreamRegistry::new(),
            staged_rev_mismatch: Arc::new(Mutex::new(None)),
            fs_watcher: WatcherState::new(),
            agent_hooks: Arc::new(Mutex::new(None)),
            folder_grants: Arc::new(Mutex::new(Vec::new())),
            external_file_grants: Arc::new(Mutex::new(Vec::new())),
            chat_runs: crate::chat_runs::ChatRunRegistry::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
