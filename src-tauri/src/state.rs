use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::daemon_bridge::DaemonBridge;
use crate::daemon_stream::StreamRegistry;
use crate::ipc::server::IpcServerHandle;
use crate::pty::PtyManager;
use crate::session::{ProjectStore, SessionStore};
use crate::staged_rev_reconcile::StagedRevMismatch;

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<SessionStore>,
    pub projects: Arc<ProjectStore>,
    pub pty: Arc<PtyManager>,
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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: SessionStore::new(),
            projects: ProjectStore::new(),
            pty: PtyManager::new(),
            sessions_loaded_cleanly: Arc::new(AtomicBool::new(true)),
            projects_loaded_cleanly: Arc::new(AtomicBool::new(true)),
            ipc_handle: Arc::new(Mutex::new(None)),
            daemon_bridge: DaemonBridge::new(),
            stream_registry: StreamRegistry::new(),
            staged_rev_mismatch: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
