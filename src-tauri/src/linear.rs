//! Linear GraphQL over HTTPS.
//!
//! The personal API key is read from the OS secret store. Requests use
//! in-process HTTPS (same shape as GitHub's `github_api` helper) so listing
//! does not spawn a CLI.

use std::path::Path;

use reqwest::Method;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::https_client;
use crate::project_settings;
use crate::pull_requests::{IssueStateFilter, PullRequestLabel};
use crate::tracker::{
    normalize_label_color, permission_denied, LinearAccount, LinearTeam, TrackerComment,
    TrackerDetailListing, TrackerIssue, TrackerIssueDetail, TrackerListing, TrackerWorkflowState,
};
use crate::tracker_secrets;

const GRAPHQL_URL: &str = "https://api.linear.app/graphql";
const LIST_LIMIT_MAX: u32 = 100;

const VIEWER_QUERY: &str = r#"
query AcornViewer {
  viewer { name displayName }
  organization { name }
}
"#;

const TEAMS_QUERY: &str = r#"
query AcornTeams {
  teams(first: 100) { nodes { id key name } }
}
"#;

const ISSUES_QUERY: &str = r#"
query AcornIssues($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      url
      createdAt
      updatedAt
      creator { name displayName }
      assignee { name displayName }
      state { name type }
      labels { nodes { name color } }
    }
  }
}
"#;

const ISSUE_QUERY: &str = r#"
query AcornIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    createdAt
    updatedAt
    creator { name displayName }
    assignee { name displayName }
    state { id name type }
    team {
      states(first: 50) {
        nodes { id name type position }
      }
    }
    labels { nodes { name color } }
    comments(first: 100) {
      nodes {
        id
        body
        createdAt
        url
        user { name displayName }
      }
    }
  }
}
"#;

const COMMENT_MUTATION: &str = r#"
mutation AcornComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
  }
}
"#;

const STATE_MUTATION: &str = r#"
mutation AcornIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
"#;

// Linear personal keys have no scope introspection, so a no-op issueUpdate
// is the write check used to disable the status control.
const WRITE_PROBE: &str = r#"
mutation AcornWriteProbe($id: String!) {
  issueUpdate(id: $id, input: {}) {
    success
  }
}
"#;

pub fn validate_api_key(key: &str) -> AppResult<&str> {
    let trimmed = key.trim();
    if !trimmed.starts_with("lin_api_") {
        return Err(AppError::Other(
            "Linear API key must start with lin_api_".into(),
        ));
    }
    if trimmed.len() < 16 || trimmed.len() > 256 {
        return Err(AppError::Other(
            "Linear API key has an invalid length".into(),
        ));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AppError::Other(
            "Linear API key contains invalid characters".into(),
        ));
    }
    Ok(trimmed)
}

fn graphql(token: &str, query: &str, variables: Value) -> AppResult<Value> {
    let payload = json!({
        "query": query,
        "variables": variables,
    });
    let encoded = serde_json::to_vec(&payload)
        .map_err(|error| AppError::Other(format!("failed to encode Linear request: {error}")))?;
    let response = https_client::request(
        Method::POST,
        GRAPHQL_URL,
        &[
            ("Authorization", token),
            ("Content-Type", "application/json"),
        ],
        Some(&encoded),
    )?;
    if response.status == 401 || response.status == 403 {
        return Err(AppError::Other(https_client::error_message(
            "Linear",
            response.status,
            &response.body,
        )));
    }
    https_client::ensure_success(&response, "Linear")?;
    let value: Value = serde_json::from_slice(&response.body)
        .map_err(|error| AppError::Other(format!("failed to parse Linear JSON: {error}")))?;
    if let Some(errors) = value.get("errors").and_then(Value::as_array) {
        if !errors.is_empty() {
            let messages: Vec<&str> = errors
                .iter()
                .filter_map(|error| error.get("message").and_then(Value::as_str))
                .filter(|message| !message.is_empty())
                .collect();
            let detail = if messages.is_empty() {
                "GraphQL request failed".to_string()
            } else {
                messages.join("; ")
            };
            return Err(AppError::Other(format!("Linear GraphQL: {detail}")));
        }
    }
    Ok(value)
}

fn display_name(node: Option<&Value>) -> String {
    node.and_then(|value| {
        value
            .get("displayName")
            .and_then(Value::as_str)
            .or_else(|| value.get("name").and_then(Value::as_str))
    })
    .unwrap_or("unknown")
    .to_string()
}

fn labels_from(node: &Value) -> Vec<PullRequestLabel> {
    node.get("labels")
        .and_then(|labels| labels.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|label| {
                    let name = label.get("name").and_then(Value::as_str)?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(PullRequestLabel {
                        name: name.to_string(),
                        color: normalize_label_color(
                            label
                                .get("color")
                                .and_then(Value::as_str)
                                .unwrap_or("808080"),
                        ),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn issue_from_node(node: &Value) -> Option<TrackerIssue> {
    let id = node.get("id").and_then(Value::as_str)?.to_string();
    let identifier = node.get("identifier").and_then(Value::as_str)?.to_string();
    let title = node
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let url = node
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state = node
        .get("state")
        .and_then(|state| state.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Unknown")
        .to_string();
    let state_type = node
        .get("state")
        .and_then(|state| state.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(TrackerIssue {
        id,
        identifier,
        title,
        state,
        state_type,
        author: display_name(node.get("creator")),
        url,
        created_at: node
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: node
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        comments: 0,
        labels: labels_from(node),
        assignee: {
            let name = display_name(node.get("assignee"));
            if name == "unknown" {
                None
            } else {
                Some(name)
            }
        },
    })
}

fn detail_from_node(node: &Value) -> Option<TrackerIssueDetail> {
    let issue = issue_from_node(node)?;
    let comments = node
        .get("comments")
        .and_then(|comments| comments.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|comment| {
                    Some(TrackerComment {
                        id: comment.get("id").and_then(Value::as_str)?.to_string(),
                        author: display_name(comment.get("user")),
                        body: comment
                            .get("body")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        created_at: comment
                            .get("createdAt")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        url: comment
                            .get("url")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(TrackerIssueDetail {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        body: node
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state: issue.state,
        state_type: issue.state_type,
        state_id: node
            .pointer("/state/id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author: issue.author,
        url: issue.url,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        labels: issue.labels,
        comments,
        assignees: issue.assignee.into_iter().collect(),
        available_states: team_states(node),
        can_change_state: false,
    })
}

fn workflow_state(node: &Value) -> Option<TrackerWorkflowState> {
    Some(TrackerWorkflowState {
        id: node.get("id").and_then(Value::as_str)?.to_string(),
        name: node.get("name").and_then(Value::as_str)?.to_string(),
        state_type: node
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

fn team_states(node: &Value) -> Vec<TrackerWorkflowState> {
    let mut ranked: Vec<(i64, TrackerWorkflowState)> = node
        .pointer("/team/states/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|state| {
            let parsed = workflow_state(state)?;
            let position = state.get("position").and_then(Value::as_i64).unwrap_or(0);
            Some((position, parsed))
        })
        .collect();
    ranked.sort_by_key(|(position, _)| *position);
    ranked.into_iter().map(|(_, state)| state).collect()
}

fn validate_state_id(id: &str) -> AppResult<&str> {
    let trimmed = id.trim();
    if trimmed.len() < 8 || trimmed.len() > 128 {
        return Err(AppError::Other("invalid Linear state id".into()));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(AppError::Other("invalid Linear state id".into()));
    }
    Ok(trimmed)
}

fn listing_from_error(error: AppError) -> TrackerListing {
    let message = error.to_string();
    if message.contains("HTTP 401") || message.contains("Authentication") {
        TrackerListing::NeedsAuth
    } else {
        TrackerListing::NoAccess { message }
    }
}

fn detail_from_error(error: AppError) -> TrackerDetailListing {
    let message = error.to_string();
    if message.contains("HTTP 401") || message.contains("Authentication") {
        TrackerDetailListing::NeedsAuth
    } else {
        TrackerDetailListing::NoAccess { message }
    }
}

pub fn connect(key: &str) -> AppResult<LinearAccount> {
    let key = validate_api_key(key)?;
    let value = graphql(key, VIEWER_QUERY, json!({}))?;
    let viewer = display_name(value.pointer("/data/viewer"));
    let workspace = value
        .pointer("/data/organization/name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let viewer = if viewer == "unknown" {
        None
    } else {
        Some(viewer)
    };
    tracker_secrets::set_linear_api_key(key, viewer.clone(), workspace.clone())?;
    Ok(LinearAccount {
        connected: true,
        viewer,
        workspace,
    })
}

pub fn disconnect() -> AppResult<()> {
    tracker_secrets::clear_linear()
}

pub fn list_teams() -> AppResult<Vec<LinearTeam>> {
    let Some(token) = tracker_secrets::linear_api_key()? else {
        return Err(AppError::Other(
            "Linear is not connected. Add an API key in Settings.".into(),
        ));
    };
    let value = graphql(&token, TEAMS_QUERY, json!({}))?;
    let nodes = value
        .pointer("/data/teams/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(nodes
        .iter()
        .filter_map(|node| {
            Some(LinearTeam {
                id: node.get("id").and_then(Value::as_str)?.to_string(),
                key: node.get("key").and_then(Value::as_str)?.to_string(),
                name: node.get("name").and_then(Value::as_str)?.to_string(),
            })
        })
        .collect())
}

fn issue_filter(
    team_id: &str,
    state: IssueStateFilter,
    query: Option<&str>,
    team_key: Option<&str>,
) -> Value {
    let mut filter = serde_json::Map::new();
    filter.insert("team".into(), json!({ "id": { "eq": team_id } }));
    match state {
        IssueStateFilter::Open => {
            filter.insert(
                "state".into(),
                json!({ "type": { "nin": ["completed", "canceled"] } }),
            );
        }
        IssueStateFilter::Closed => {
            filter.insert(
                "state".into(),
                json!({ "type": { "in": ["completed", "canceled"] } }),
            );
        }
        IssueStateFilter::All => {}
    }
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some((prefix, number)) = query.rsplit_once('-') {
            if let (Some(team_key), Ok(number)) = (team_key, number.parse::<u64>()) {
                if prefix.eq_ignore_ascii_case(team_key) {
                    filter.insert("number".into(), json!({ "eq": number }));
                    return Value::Object(filter);
                }
            }
        }
        filter.insert("title".into(), json!({ "containsIgnoreCase": query }));
    }
    Value::Object(filter)
}

pub fn list_issues(
    repo_path: &Path,
    state: IssueStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<TrackerListing> {
    let Some(token) = tracker_secrets::linear_api_key()? else {
        return Ok(TrackerListing::NeedsAuth);
    };
    let settings = project_settings::get(repo_path)?.settings.linear;
    let Some(team_id) = settings
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(TrackerListing::NeedsMapping);
    };
    let limit = limit.clamp(1, LIST_LIMIT_MAX);
    let filter = issue_filter(team_id, state, query, settings.team_key.as_deref());
    let value = match graphql(
        &token,
        ISSUES_QUERY,
        json!({ "filter": filter, "first": limit }),
    ) {
        Ok(value) => value,
        Err(error) => return Ok(listing_from_error(error)),
    };
    let items = value
        .pointer("/data/issues/nodes")
        .and_then(Value::as_array)
        .map(|nodes| nodes.iter().filter_map(issue_from_node).collect())
        .unwrap_or_default();
    let account = tracker_secrets::accounts()?
        .linear
        .viewer
        .unwrap_or_else(|| "Linear".into());
    Ok(TrackerListing::Ok { items, account })
}

pub fn get_issue(repo_path: &Path, id: &str) -> AppResult<TrackerDetailListing> {
    let Some(token) = tracker_secrets::linear_api_key()? else {
        return Ok(TrackerDetailListing::NeedsAuth);
    };
    if project_settings::get(repo_path)?
        .settings
        .linear
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Ok(TrackerDetailListing::NeedsMapping);
    }
    let id = id.trim();
    if id.is_empty() || id.len() > 128 {
        return Err(AppError::Other("invalid Linear issue id".into()));
    }
    let value = match graphql(&token, ISSUE_QUERY, json!({ "id": id })) {
        Ok(value) => value,
        Err(error) => return Ok(detail_from_error(error)),
    };
    let Some(mut detail) = value.pointer("/data/issue").and_then(detail_from_node) else {
        return Ok(TrackerDetailListing::NoAccess {
            message: "Linear issue was not found.".into(),
        });
    };
    detail.can_change_state = linear_can_update(&token, id);
    let account = tracker_secrets::accounts()?
        .linear
        .viewer
        .unwrap_or_else(|| "Linear".into());
    Ok(TrackerDetailListing::Ok { account, detail })
}

fn linear_can_update(token: &str, id: &str) -> bool {
    match graphql(token, WRITE_PROBE, json!({ "id": id })) {
        Ok(_) => true,
        Err(error) => !permission_denied(&error.to_string()),
    }
}

pub fn add_comment(repo_path: &Path, id: &str, body: &str) -> AppResult<()> {
    let Some(token) = tracker_secrets::linear_api_key()? else {
        return Err(AppError::Other(
            "Linear is not connected. Add an API key in Settings.".into(),
        ));
    };
    if project_settings::get(repo_path)?
        .settings
        .linear
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::Other(
            "This project has no Linear team mapped.".into(),
        ));
    }
    let id = id.trim();
    let body = body.trim();
    if id.is_empty() || id.len() > 128 {
        return Err(AppError::Other("invalid Linear issue id".into()));
    }
    if body.is_empty() {
        return Err(AppError::Other("Comment body cannot be empty.".into()));
    }
    if body.chars().count() > 8_000 {
        return Err(AppError::Other("Comment body is too long.".into()));
    }
    graphql(
        &token,
        COMMENT_MUTATION,
        json!({ "input": { "issueId": id, "body": body } }),
    )?;
    Ok(())
}

pub fn set_state(repo_path: &Path, id: &str, state_id: &str) -> AppResult<()> {
    let Some(token) = tracker_secrets::linear_api_key()? else {
        return Err(AppError::Other(
            "Linear is not connected. Add an API key in Settings.".into(),
        ));
    };
    if project_settings::get(repo_path)?
        .settings
        .linear
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::Other(
            "This project has no Linear team mapped.".into(),
        ));
    }
    let id = id.trim();
    if id.is_empty() || id.len() > 128 {
        return Err(AppError::Other("invalid Linear issue id".into()));
    }
    let state_id = validate_state_id(state_id)?;
    graphql(
        &token,
        STATE_MUTATION,
        json!({ "id": id, "stateId": state_id }),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_api_key_accepts_linear_prefix() {
        assert!(validate_api_key("lin_api_abcdefghij").is_ok());
        assert!(validate_api_key("not-a-key").is_err());
        assert!(validate_api_key("lin_api_bad key").is_err());
    }

    #[test]
    fn issue_filter_uses_number_when_query_matches_team_key() {
        let filter = issue_filter(
            "team-1",
            IssueStateFilter::Open,
            Some("JTF-184"),
            Some("JTF"),
        );
        assert_eq!(filter["number"]["eq"], 184);
        assert!(filter.get("title").is_none());
    }

    #[test]
    fn validate_state_id_rejects_short_and_spaces() {
        assert!(validate_state_id("abcdefgh").is_ok());
        assert!(validate_state_id("short").is_err());
        assert!(validate_state_id("bad state id").is_err());
    }

    #[test]
    fn team_states_sort_by_position() {
        let node = json!({
            "team": {
                "states": {
                    "nodes": [
                        { "id": "s-done", "name": "Done", "type": "completed", "position": 3 },
                        { "id": "s-todo", "name": "Todo", "type": "unstarted", "position": 1 },
                        { "id": "s-wip", "name": "In Progress", "type": "started", "position": 2 }
                    ]
                }
            }
        });
        let states = team_states(&node);
        let names: Vec<&str> = states.iter().map(|state| state.name.as_str()).collect();
        assert_eq!(names, ["Todo", "In Progress", "Done"]);
    }
}
