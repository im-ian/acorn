use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::daemon_bridge::DaemonBridge;
use crate::ipc::server::IpcServerHandle;
use crate::pty::PtyManager;
use crate::session::{ProjectStore, SessionStore};

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
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
