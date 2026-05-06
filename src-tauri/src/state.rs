use std::sync::Arc;

use crate::pty::PtyManager;
use crate::session::{ProjectStore, SessionStore};

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<SessionStore>,
    pub projects: Arc<ProjectStore>,
    pub pty: Arc<PtyManager>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: SessionStore::new(),
            projects: ProjectStore::new(),
            pty: PtyManager::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
