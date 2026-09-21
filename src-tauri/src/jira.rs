//! Jira Cloud REST over HTTPS.
//!
//! The API token stays in the OS secret store. Email and site are stored
//! separately. Requests follow the same in-process HTTPS path as Linear /
//! GitHub so listing does not spawn a CLI.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

use crate::error::{AppError, AppResult};
use crate::https_client;
use crate::project_settings;
use crate::pull_requests::{IssueStateFilter, PullRequestLabel};
use crate::tracker::{
    normalize_label_color, JiraAccount, JiraProjectInfo, TrackerComment, TrackerDetailListing,
    TrackerIssue, TrackerIssueDetail, TrackerListing, TrackerWorkflowState,
};
use crate::tracker_secrets;

const LIST_LIMIT_MAX: u32 = 100;

pub fn normalize_site(input: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return Err(AppError::Other("Jira site is missing or too long".into()));
    }
    let url = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed =
        Url::parse(&url).map_err(|error| AppError::Other(format!("invalid Jira site: {error}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Other("Jira site must be https".into()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Other(
            "Jira site must not include credentials".into(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::Other("Jira site host is missing".into()))?;
    if host.is_empty() || host.contains('/') {
        return Err(AppError::Other("Jira site host is invalid".into()));
    }
    Ok(host.to_ascii_lowercase())
}

pub fn validate_email(email: &str) -> AppResult<&str> {
    let trimmed = email.trim();
    if trimmed.len() < 3 || trimmed.len() > 254 || !trimmed.contains('@') || trimmed.contains(' ') {
        return Err(AppError::Other("Jira email looks invalid".into()));
    }
    Ok(trimmed)
}

fn validate_token(token: &str) -> AppResult<&str> {
    let trimmed = token.trim();
    if trimmed.len() < 8 || trimmed.len() > 256 || trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::Other(
            "Jira API token has an invalid length".into(),
        ));
    }
    Ok(trimmed)
}

fn validate_project_key(key: &str) -> AppResult<&str> {
    let trimmed = key.trim();
    if trimmed.len() < 2 || trimmed.len() > 16 {
        return Err(AppError::Other("Jira project key is invalid".into()));
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return Err(AppError::Other("Jira project key is invalid".into()));
    };
    if !first.is_ascii_uppercase()
        || !chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
    {
        return Err(AppError::Other("Jira project key is invalid".into()));
    }
    Ok(trimmed)
}

fn validate_issue_key(key: &str) -> AppResult<&str> {
    let trimmed = key.trim();
    let Some((prefix, number)) = trimmed.rsplit_once('-') else {
        return Err(AppError::Other("invalid Jira issue key".into()));
    };
    validate_project_key(&prefix.to_ascii_uppercase())?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) || number.len() > 8 {
        return Err(AppError::Other("invalid Jira issue key".into()));
    }
    Ok(trimmed)
}

fn basic_auth(email: &str, token: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{email}:{token}")))
}

fn auth_headers<'a>(email: &'a str, token: &'a str) -> [(&'a str, String); 2] {
    [
        ("Authorization", basic_auth(email, token)),
        ("Accept", "application/json".into()),
    ]
}

fn adf_to_text(value: &Value) -> String {
    fn walk(node: &Value, out: &mut String) {
        match node.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = node.get("text").and_then(Value::as_str) {
                    out.push_str(text);
                }
            }
            Some("hardBreak") => out.push('\n'),
            Some("paragraph" | "heading" | "blockquote" | "listItem" | "codeBlock") => {
                if let Some(content) = node.get("content").and_then(Value::as_array) {
                    for child in content {
                        walk(child, out);
                    }
                }
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ => {
                if let Some(content) = node.get("content").and_then(Value::as_array) {
                    for child in content {
                        walk(child, out);
                    }
                }
            }
        }
    }
    let mut out = String::new();
    walk(value, &mut out);
    out.trim().to_string()
}

fn description_text(fields: &Value) -> String {
    match fields.get("description") {
        Some(Value::String(text)) => text.clone(),
        Some(value) if value.is_object() => adf_to_text(value),
        _ => String::new(),
    }
}

fn comment_text(body: &Value) -> String {
    match body {
        Value::String(text) => text.clone(),
        value if value.is_object() => adf_to_text(value),
        _ => String::new(),
    }
}

fn plain_comment_adf(body: &str) -> Value {
    json!({
        "type": "doc",
        "version": 1,
        "content": [{
            "type": "paragraph",
            "content": [{ "type": "text", "text": body }]
        }]
    })
}

fn jql_escape(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn status_type(fields: &Value) -> (String, String) {
    let name = fields
        .pointer("/status/name")
        .and_then(Value::as_str)
        .unwrap_or("Unknown")
        .to_string();
    let category = fields
        .pointer("/status/statusCategory/key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state_type = match category.as_str() {
        "done" => "completed",
        "indeterminate" => "started",
        _ => "unstarted",
    };
    (name, state_type.to_string())
}

fn labels_from(fields: &Value) -> Vec<PullRequestLabel> {
    fields
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| {
                    let name = label.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(PullRequestLabel {
                        name: name.to_string(),
                        color: normalize_label_color("808080"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn person_name(fields: &Value, key: &str) -> Option<String> {
    fields
        .get(key)
        .and_then(|person| {
            person
                .get("displayName")
                .and_then(Value::as_str)
                .or_else(|| person.get("emailAddress").and_then(Value::as_str))
        })
        .map(str::to_string)
}

fn issue_from_search(node: &Value) -> Option<TrackerIssue> {
    let key = node.get("key").and_then(Value::as_str)?.to_string();
    let fields = node.get("fields")?;
    let (state, state_type) = status_type(fields);
    Some(TrackerIssue {
        id: key.clone(),
        identifier: key.clone(),
        title: fields
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state,
        state_type,
        author: person_name(fields, "reporter").unwrap_or_else(|| "unknown".into()),
        url: node
            .get("self")
            .and_then(Value::as_str)
            .map(|self_url| {
                if let Some(browse) = browse_url_from_self(self_url, &key) {
                    browse
                } else {
                    self_url.to_string()
                }
            })
            .unwrap_or_default(),
        created_at: fields
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: fields
            .get("updated")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        comments: 0,
        labels: labels_from(fields),
        assignee: person_name(fields, "assignee"),
    })
}

fn browse_url_from_self(self_url: &str, key: &str) -> Option<String> {
    let parsed = Url::parse(self_url).ok()?;
    let host = parsed.host_str()?;
    if host.ends_with("atlassian.net") {
        return Some(format!("https://{host}/browse/{key}"));
    }
    if host == "api.atlassian.com" {
        return None;
    }
    Some(format!("https://{host}/browse/{key}"))
}

fn browse_url(site: &str, key: &str) -> String {
    format!("https://{site}/browse/{key}")
}

fn detail_from_issue(node: &Value, site: &str) -> Option<TrackerIssueDetail> {
    let mut issue = issue_from_search(node)?;
    if issue.url.is_empty() || issue.url.contains("/rest/") {
        issue.url = browse_url(site, &issue.identifier);
    }
    let fields = node.get("fields")?;
    let comments = fields
        .pointer("/comment/comments")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|comment| {
                    Some(TrackerComment {
                        id: comment.get("id").and_then(|id| {
                            id.as_str()
                                .map(str::to_string)
                                .or_else(|| id.as_i64().map(|value| value.to_string()))
                        })?,
                        author: comment
                            .pointer("/author/displayName")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        body: comment.get("body").map(comment_text).unwrap_or_default(),
                        created_at: comment
                            .get("created")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        url: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(TrackerIssueDetail {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        body: description_text(fields),
        state: issue.state,
        state_type: issue.state_type,
        state_id: fields
            .pointer("/status/id")
            .and_then(|id| {
                id.as_str()
                    .map(str::to_string)
                    .or_else(|| id.as_i64().map(|value| value.to_string()))
            })
            .unwrap_or_default(),
        author: issue.author,
        url: issue.url,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        labels: issue.labels,
        comments,
        assignees: issue.assignee.into_iter().collect(),
        available_states: Vec::new(),
        can_change_state: false,
    })
}

fn transitions_from(value: &Value) -> Vec<TrackerWorkflowState> {
    value
        .get("transitions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|transition| {
            let id = transition.get("id").and_then(|id| {
                id.as_str()
                    .map(str::to_string)
                    .or_else(|| id.as_i64().map(|value| value.to_string()))
            })?;
            let name = transition
                .pointer("/to/name")
                .and_then(Value::as_str)
                .or_else(|| transition.get("name").and_then(Value::as_str))?
                .to_string();
            let state_type = match transition
                .pointer("/to/statusCategory/key")
                .and_then(Value::as_str)
                .unwrap_or("")
            {
                "done" => "completed",
                "indeterminate" => "started",
                _ => "unstarted",
            };
            Some(TrackerWorkflowState {
                id,
                name,
                state_type: state_type.to_string(),
            })
        })
        .collect()
}

fn jira_can_transition(client: &JiraClient, key: &str, has_transitions: bool) -> bool {
    let path = format!("/rest/api/3/mypermissions?permissions=TRANSITION_ISSUES&issueKey={key}");
    match client.get_json::<Value>(&path) {
        Ok(value) => value
            .pointer("/permissions/TRANSITION_ISSUES/havePermission")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Err(_) => has_transitions,
    }
}

fn validate_transition_id(id: &str) -> AppResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err(AppError::Other("invalid Jira transition id".into()));
    }
    if !trimmed.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(AppError::Other("invalid Jira transition id".into()));
    }
    Ok(trimmed)
}

struct JiraClient {
    email: String,
    token: String,
    site: String,
    base: String,
}

impl JiraClient {
    fn from_store() -> AppResult<Option<Self>> {
        let Some(token) = tracker_secrets::jira_api_token()? else {
            return Ok(None);
        };
        let meta = tracker_secrets::jira_site_meta()?;
        let (Some(email), Some(site)) = (meta.email, meta.site) else {
            return Ok(None);
        };
        let base = match meta.cloud_id.filter(|id| is_safe_cloud_id(id)) {
            Some(cloud_id) => format!("https://api.atlassian.com/ex/jira/{cloud_id}"),
            None => format!("https://{site}"),
        };
        Ok(Some(Self {
            email,
            token,
            site,
            base,
        }))
    }

    fn headers(&self) -> Vec<(String, String)> {
        auth_headers(&self.email, &self.token)
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect()
    }

    fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> AppResult<T> {
        let url = format!("{}{}", self.base, path);
        let headers = self.headers();
        let pairs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        https_client::json(Method::GET, &url, &pairs, None, "Jira")
    }

    fn send_json(&self, method: Method, path: &str, body: &Value) -> AppResult<Value> {
        let url = format!("{}{}", self.base, path);
        let mut headers = self.headers();
        headers.push(("Content-Type".into(), "application/json".into()));
        let pairs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let payload = serde_json::to_vec(body)
            .map_err(|error| AppError::Other(format!("failed to encode Jira JSON: {error}")))?;
        https_client::json(method, &url, &pairs, Some(&payload), "Jira")
    }

    fn send_ok(&self, method: Method, path: &str, body: &Value) -> AppResult<()> {
        let url = format!("{}{}", self.base, path);
        let mut headers = self.headers();
        headers.push(("Content-Type".into(), "application/json".into()));
        let pairs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let payload = serde_json::to_vec(body)
            .map_err(|error| AppError::Other(format!("failed to encode Jira JSON: {error}")))?;
        https_client::send(method, &url, &pairs, Some(&payload), "Jira")?;
        Ok(())
    }
}

fn is_safe_cloud_id(id: &str) -> bool {
    let trimmed = id.trim();
    (8..=64).contains(&trimmed.len())
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn listing_from_error(error: AppError) -> TrackerListing {
    let message = error.to_string();
    if message.contains("HTTP 401") || message.contains("HTTP 403") {
        TrackerListing::NeedsAuth
    } else {
        TrackerListing::NoAccess { message }
    }
}

fn detail_from_error(error: AppError) -> TrackerDetailListing {
    let message = error.to_string();
    if message.contains("HTTP 401") || message.contains("HTTP 403") {
        TrackerDetailListing::NeedsAuth
    } else {
        TrackerDetailListing::NoAccess { message }
    }
}

fn resolve_base(email: &str, token: &str, host: &str) -> AppResult<(String, Option<String>)> {
    let headers = auth_headers(email, token);
    let pairs = [
        (headers[0].0, headers[0].1.as_str()),
        (headers[1].0, headers[1].1.as_str()),
    ];
    let tenant_url = format!("https://{host}/_edge/tenant_info");
    let cloud_id = https_client::request(Method::GET, &tenant_url, &pairs, None)
        .ok()
        .and_then(|response| {
            if !(200..300).contains(&response.status) {
                return None;
            }
            serde_json::from_slice::<Value>(&response.body)
                .ok()?
                .get("cloudId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|id| is_safe_cloud_id(id));

    let site_myself = format!("https://{host}/rest/api/3/myself");
    if https_client::request(Method::GET, &site_myself, &pairs, None)
        .ok()
        .is_some_and(|response| (200..300).contains(&response.status))
    {
        return Ok((format!("https://{host}"), cloud_id));
    }
    if let Some(cloud_id) = cloud_id {
        let gateway = format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/myself");
        let response = https_client::request(Method::GET, &gateway, &pairs, None)?;
        https_client::ensure_success(&response, "Jira")?;
        return Ok((
            format!("https://api.atlassian.com/ex/jira/{cloud_id}"),
            Some(cloud_id),
        ));
    }
    Err(AppError::Other(
        "Could not reach Jira with this site and token.".into(),
    ))
}

pub fn connect(email: &str, site: &str, token: &str) -> AppResult<JiraAccount> {
    let email = validate_email(email)?;
    let host = normalize_site(site)?;
    let token = validate_token(token)?;
    let (base, cloud_id) = resolve_base(email, token, &host)?;
    let headers = auth_headers(email, token);
    let pairs = [
        (headers[0].0, headers[0].1.as_str()),
        (headers[1].0, headers[1].1.as_str()),
    ];
    let myself: Value = https_client::json(
        Method::GET,
        &format!("{base}/rest/api/3/myself"),
        &pairs,
        None,
        "Jira",
    )?;
    let display_name = myself
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::to_string);
    tracker_secrets::set_jira_credentials(email, &host, token, cloud_id, display_name.clone())?;
    Ok(JiraAccount {
        connected: true,
        email: Some(email.to_string()),
        site: Some(host),
        display_name,
    })
}

pub fn disconnect() -> AppResult<()> {
    tracker_secrets::clear_jira()
}

pub fn list_projects() -> AppResult<Vec<JiraProjectInfo>> {
    let Some(client) = JiraClient::from_store()? else {
        return Err(AppError::Other(
            "Jira is not connected. Add a site, email, and API token in Settings.".into(),
        ));
    };
    let value: Value = client.get_json("/rest/api/3/project")?;
    let nodes = value.as_array().cloned().unwrap_or_default();
    Ok(nodes
        .iter()
        .filter_map(|node| {
            Some(JiraProjectInfo {
                id: node.get("id").and_then(|id| {
                    id.as_str()
                        .map(str::to_string)
                        .or_else(|| id.as_i64().map(|value| value.to_string()))
                })?,
                key: node.get("key").and_then(Value::as_str)?.to_string(),
                name: node.get("name").and_then(Value::as_str)?.to_string(),
            })
        })
        .collect())
}

fn jql_for(project_key: &str, state: IssueStateFilter, query: Option<&str>) -> String {
    let mut jql = match state {
        IssueStateFilter::Open => format!("project = {project_key} AND statusCategory != Done"),
        IssueStateFilter::Closed => format!("project = {project_key} AND statusCategory = Done"),
        IssueStateFilter::All => format!("project = {project_key}"),
    };
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        if validate_issue_key(query).is_ok() {
            jql.push_str(&format!(" AND key = {}", query.to_ascii_uppercase()));
        } else {
            jql.push_str(&format!(" AND text ~ {}", jql_escape(query)));
        }
    }
    jql.push_str(" ORDER BY updated DESC");
    jql
}

pub fn list_issues(
    repo_path: &Path,
    state: IssueStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<TrackerListing> {
    let Some(client) = JiraClient::from_store()? else {
        return Ok(TrackerListing::NeedsAuth);
    };
    let settings = project_settings::get(repo_path)?.settings.jira;
    let Some(project_key) = settings
        .project_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(TrackerListing::NeedsMapping);
    };
    let project_key = match validate_project_key(project_key) {
        Ok(key) => key.to_string(),
        Err(_) => return Ok(TrackerListing::NeedsMapping),
    };
    let limit = limit.clamp(1, LIST_LIMIT_MAX);
    let jql = jql_for(&project_key, state, query);
    let payload = json!({
        "jql": jql,
        "maxResults": limit,
        "fields": ["summary", "status", "assignee", "reporter", "created", "updated", "labels"]
    });
    let value = match client.send_json(Method::POST, "/rest/api/3/search/jql", &payload) {
        Ok(value) => value,
        Err(_) => {
            let encoded = url::form_urlencoded::byte_serialize(jql.as_bytes()).collect::<String>();
            match client.get_json::<Value>(&format!(
                "/rest/api/3/search?jql={encoded}&maxResults={limit}&fields=summary,status,assignee,reporter,created,updated,labels"
            )) {
                Ok(value) => value,
                Err(error) => return Ok(listing_from_error(error)),
            }
        }
    };
    let items = value
        .get("issues")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(issue_from_search)
                .map(|mut issue| {
                    if issue.url.is_empty() || issue.url.contains("/rest/") {
                        issue.url = browse_url(&client.site, &issue.identifier);
                    }
                    issue
                })
                .collect()
        })
        .unwrap_or_default();
    let account = tracker_secrets::accounts()?
        .jira
        .display_name
        .or(tracker_secrets::accounts()?.jira.email)
        .unwrap_or_else(|| "Jira".into());
    Ok(TrackerListing::Ok { items, account })
}

pub fn get_issue(repo_path: &Path, id: &str) -> AppResult<TrackerDetailListing> {
    let Some(client) = JiraClient::from_store()? else {
        return Ok(TrackerDetailListing::NeedsAuth);
    };
    if project_settings::get(repo_path)?
        .settings
        .jira
        .project_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Ok(TrackerDetailListing::NeedsMapping);
    }
    let key = match validate_issue_key(id) {
        Ok(key) => key.to_ascii_uppercase(),
        Err(_) => {
            return Ok(TrackerDetailListing::NoAccess {
                message: "invalid Jira issue key".into(),
            });
        }
    };
    let value = match client.get_json::<Value>(&format!(
        "/rest/api/3/issue/{key}?fields=summary,status,assignee,reporter,created,updated,labels,description,comment"
    )) {
        Ok(value) => value,
        Err(error) => return Ok(detail_from_error(error)),
    };
    let Some(mut detail) = detail_from_issue(&value, &client.site) else {
        return Ok(TrackerDetailListing::NoAccess {
            message: "Jira issue was not found.".into(),
        });
    };
    let mut states = Vec::new();
    if !detail.state_id.is_empty() {
        states.push(TrackerWorkflowState {
            id: detail.state_id.clone(),
            name: detail.state.clone(),
            state_type: detail.state_type.clone(),
        });
    }
    if let Ok(payload) = client.get_json::<Value>(&format!("/rest/api/3/issue/{key}/transitions")) {
        for transition in transitions_from(&payload) {
            if states.iter().any(|state| state.id == transition.id) {
                continue;
            }
            states.push(transition);
        }
    }
    detail.available_states = states;
    detail.can_change_state = jira_can_transition(&client, &key, detail.available_states.len() > 1);
    let account = tracker_secrets::accounts()?
        .jira
        .display_name
        .or(tracker_secrets::accounts()?.jira.email)
        .unwrap_or_else(|| "Jira".into());
    Ok(TrackerDetailListing::Ok { account, detail })
}

pub fn add_comment(repo_path: &Path, id: &str, body: &str) -> AppResult<()> {
    let Some(client) = JiraClient::from_store()? else {
        return Err(AppError::Other(
            "Jira is not connected. Add a site, email, and API token in Settings.".into(),
        ));
    };
    if project_settings::get(repo_path)?
        .settings
        .jira
        .project_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::Other(
            "This project has no Jira project mapped.".into(),
        ));
    }
    let key = validate_issue_key(id)?.to_ascii_uppercase();
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::Other("Comment body cannot be empty.".into()));
    }
    if body.chars().count() > 8_000 {
        return Err(AppError::Other("Comment body is too long.".into()));
    }
    client.send_json(
        Method::POST,
        &format!("/rest/api/3/issue/{key}/comment"),
        &json!({ "body": plain_comment_adf(body) }),
    )?;
    Ok(())
}

pub fn set_state(repo_path: &Path, id: &str, transition_id: &str) -> AppResult<()> {
    let Some(client) = JiraClient::from_store()? else {
        return Err(AppError::Other(
            "Jira is not connected. Add a site, email, and API token in Settings.".into(),
        ));
    };
    if project_settings::get(repo_path)?
        .settings
        .jira
        .project_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(AppError::Other(
            "This project has no Jira project mapped.".into(),
        ));
    }
    let key = validate_issue_key(id)?.to_ascii_uppercase();
    let transition_id = validate_transition_id(transition_id)?;
    client.send_ok(
        Method::POST,
        &format!("/rest/api/3/issue/{key}/transitions"),
        &json!({ "transition": { "id": transition_id } }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_site_strips_scheme_and_rejects_userinfo() {
        assert_eq!(
            normalize_site("https://Acme.atlassian.net/jira").unwrap(),
            "acme.atlassian.net"
        );
        assert_eq!(
            normalize_site("acme.atlassian.net").unwrap(),
            "acme.atlassian.net"
        );
        assert!(normalize_site("https://user:pass@acme.atlassian.net").is_err());
        assert!(normalize_site("http://acme.atlassian.net").is_err());
    }

    #[test]
    fn adf_to_text_flattens_paragraphs() {
        let adf = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "Hello " },
                    { "type": "text", "text": "world" }
                ]
            }]
        });
        assert_eq!(adf_to_text(&adf), "Hello world");
    }

    #[test]
    fn jql_escapes_quotes() {
        assert_eq!(jql_escape(r#"foo "bar""#), r#""foo \"bar\"""#);
    }

    #[test]
    fn validate_transition_id_rejects_punctuation() {
        assert!(validate_transition_id("21").is_ok());
        assert!(validate_transition_id("").is_err());
        assert!(validate_transition_id("21;drop").is_err());
    }

    #[test]
    fn transitions_from_prefers_destination_status_name() {
        let payload = json!({
            "transitions": [
                {
                    "id": "21",
                    "name": "Start progress",
                    "to": {
                        "name": "In Progress",
                        "statusCategory": { "key": "indeterminate" }
                    }
                },
                {
                    "id": "31",
                    "name": "Done",
                    "to": {
                        "name": "Done",
                        "statusCategory": { "key": "done" }
                    }
                }
            ]
        });
        let states = transitions_from(&payload);
        assert_eq!(states[0].id, "21");
        assert_eq!(states[0].name, "In Progress");
        assert_eq!(states[0].state_type, "started");
        assert_eq!(states[1].state_type, "completed");
    }
}
