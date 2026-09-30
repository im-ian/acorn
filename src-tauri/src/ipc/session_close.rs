use std::collections::HashMap;
use std::sync::mpsc;

use serde::{Deserialize, Serialize};

/// Frontend decides whether an IPC close also deletes the target's worktree.
/// The setting lives in renderer state, so the socket server asks and waits.
pub const SESSION_CLOSE_REQUEST_EVENT: &str = "acorn:ipc-session-close-request";

#[derive(Debug, Clone, Serialize)]
pub struct SessionCloseRequestPayload {
    pub request_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionCloseResponsePayload {
    pub request_id: String,
    pub remove_worktree: bool,
}

pub type SessionCloseResponseSender = mpsc::Sender<bool>;
pub type PendingSessionCloseRequests = HashMap<String, SessionCloseResponseSender>;

pub fn deliver_session_close_response(
    requests: &mut PendingSessionCloseRequests,
    response: SessionCloseResponsePayload,
) -> Result<(), String> {
    let sender = requests.remove(&response.request_id).ok_or_else(|| {
        format!(
            "no pending IPC session close request {}",
            response.request_id
        )
    })?;
    sender
        .send(response.remove_worktree)
        .map_err(|_| "IPC session close request receiver dropped".to_string())
}
