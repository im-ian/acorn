//! Shared Linear / Jira issue types for the right-panel tracker tabs.

use serde::{Deserialize, Serialize};

use crate::pull_requests::PullRequestLabel;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinearAccount {
    pub connected: bool,
    pub viewer: Option<String>,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JiraAccount {
    pub connected: bool,
    pub email: Option<String>,
    pub site: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrackerAccounts {
    pub linear: LinearAccount,
    pub jira: JiraAccount,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinearTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JiraProjectInfo {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackerIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub state: String,
    pub state_type: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub comments: u32,
    pub labels: Vec<PullRequestLabel>,
    pub assignee: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackerComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrackerWorkflowState {
    pub id: String,
    pub name: String,
    pub state_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackerIssueDetail {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub body: String,
    pub state: String,
    pub state_type: String,
    #[serde(default)]
    pub state_id: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<PullRequestLabel>,
    pub comments: Vec<TrackerComment>,
    pub assignees: Vec<String>,
    #[serde(default)]
    pub available_states: Vec<TrackerWorkflowState>,
    #[serde(default)]
    pub can_change_state: bool,
}

pub fn permission_denied(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("permission")
        || lower.contains("forbidden")
        || lower.contains("not allowed")
        || lower.contains("unauthorized")
        || lower.contains("http 403")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_denied_matches_api_key_scope_errors() {
        assert!(permission_denied(
            "You do not have permission to perform this action"
        ));
        assert!(permission_denied("Linear GraphQL: Forbidden (HTTP 403)"));
        assert!(!permission_denied("Linear issue was not found."));
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TrackerListing {
    Ok {
        items: Vec<TrackerIssue>,
        account: String,
    },
    NeedsAuth,
    NeedsMapping,
    NoAccess {
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TrackerDetailListing {
    Ok {
        account: String,
        detail: TrackerIssueDetail,
    },
    NeedsAuth,
    NeedsMapping,
    NoAccess {
        message: String,
    },
}

pub fn normalize_label_color(color: &str) -> String {
    color.trim().trim_start_matches('#').to_string()
}
