use std::collections::HashMap;
use std::sync::mpsc;

use acorn_ipc::proto::WorkspaceSummary;
use serde::{Deserialize, Serialize};

pub const LIST_WORKSPACES_REQUEST_EVENT: &str = "acorn:ipc-list-workspaces-request";

#[derive(Debug, Clone, Serialize)]
pub struct ListWorkspacesRequestPayload {
    pub request_id: String,
    pub source_session_id: String,
    pub repo_path: String,
    pub source_workspace_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListWorkspacesResponsePayload {
    pub request_id: String,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceSummary>,
    pub error: Option<String>,
}

pub type WorkspaceResponse = Result<Vec<WorkspaceSummary>, String>;
pub type WorkspaceResponseSender = mpsc::Sender<WorkspaceResponse>;
pub type PendingWorkspaceRequests = HashMap<String, WorkspaceResponseSender>;
