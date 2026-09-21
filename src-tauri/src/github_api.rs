//! GitHub REST/GraphQL over HTTPS, authenticated with a token from `gh`.
//!
//! Account discovery still uses the gh CLI so keychain / device-flow /
//! multi-account logins stay out of the app. API traffic itself is in-process
//! so listing and detail views do not spawn `gh` per call.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

const API_ROOT: &str = "https://api.github.com";
const USER_AGENT_VALUE: &str = "acorn";
const API_VERSION: &str = "2022-11-28";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

pub struct GitHubResponse {
    pub status: u16,
    pub rate_limit_remaining: Option<u32>,
    pub body: Vec<u8>,
}

fn client() -> AppResult<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(existing) = CLIENT.get() {
        return Ok(existing);
    }
    let built = Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::Other(format!("failed to build GitHub HTTP client: {error}")))?;
    let _ = CLIENT.set(built);
    CLIENT
        .get()
        .ok_or_else(|| AppError::Other("GitHub HTTP client missing".into()))
}

pub fn request(
    token: &str,
    method: Method,
    path: &str,
    accept: Option<&str>,
    body: Option<&[u8]>,
) -> AppResult<GitHubResponse> {
    let url = if path.starts_with("https://") {
        path.to_string()
    } else {
        format!("{API_ROOT}/{}", path.trim_start_matches('/'))
    };

    let mut req = client()?.request(method, url);
    req = req.header(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    req = req.header(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| AppError::Other("invalid GitHub token for Authorization header".into()))?,
    );
    req = req.header("X-GitHub-Api-Version", API_VERSION);
    req = req.header(
        ACCEPT,
        HeaderValue::from_str(accept.unwrap_or("application/vnd.github+json"))
            .map_err(|_| AppError::Other("invalid GitHub Accept header".into()))?,
    );
    if let Some(body) = body {
        req = req.header(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        req = req.body(body.to_vec());
    }

    let response = req
        .send()
        .map_err(|error| AppError::Other(format!("GitHub request failed: {error}")))?;
    let status = response.status().as_u16();
    let rate_limit_remaining = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let bytes = response
        .bytes()
        .map_err(|error| AppError::Other(format!("failed to read GitHub response: {error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(AppError::Other(format!(
            "GitHub response exceeded {MAX_BODY_BYTES} bytes"
        )));
    }

    Ok(GitHubResponse {
        status,
        rate_limit_remaining,
        body: bytes.to_vec(),
    })
}

pub fn error_message(status: u16, body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return format!("{trimmed} (HTTP {status})");
            }
        }
        if let Some(errors) = value.get("errors").and_then(Value::as_array) {
            let messages: Vec<&str> = errors
                .iter()
                .filter_map(|error| error.get("message").and_then(Value::as_str))
                .filter(|message| !message.is_empty())
                .collect();
            if !messages.is_empty() {
                return format!("{} (HTTP {status})", messages.join("; "));
            }
        }
    }
    let text = String::from_utf8_lossy(body);
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        return format!("{trimmed} (HTTP {status})");
    }
    format!("GitHub request failed (HTTP {status})")
}

pub fn ensure_success(response: &GitHubResponse) -> AppResult<()> {
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        Err(AppError::Other(error_message(
            response.status,
            &response.body,
        )))
    }
}

pub fn json<T: DeserializeOwned>(
    token: &str,
    method: Method,
    path: &str,
    body: Option<&[u8]>,
) -> AppResult<T> {
    let response = request(token, method, path, None, body)?;
    ensure_success(&response)?;
    if response.body.is_empty() {
        return Err(AppError::Other(
            "GitHub response was empty where JSON was required".into(),
        ));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| AppError::Other(format!("failed to parse GitHub JSON: {error}")))
}

pub fn send(token: &str, method: Method, path: &str, body: Option<&[u8]>) -> AppResult<()> {
    let response = request(token, method, path, None, body)?;
    ensure_success(&response)
}

pub fn send_json<T: Serialize>(token: &str, method: Method, path: &str, body: &T) -> AppResult<()> {
    let payload = serde_json::to_vec(body)
        .map_err(|error| AppError::Other(format!("failed to encode GitHub JSON: {error}")))?;
    send(token, method, path, Some(&payload))
}

pub fn raw(token: &str, path: &str, accept: &str) -> AppResult<Vec<u8>> {
    let response = request(token, Method::GET, path, Some(accept), None)?;
    ensure_success(&response)?;
    Ok(response.body)
}

pub fn graphql(token: &str, query: &str, variables: Value) -> AppResult<Value> {
    let payload = json!({
        "query": query,
        "variables": variables,
    });
    let encoded = serde_json::to_vec(&payload)
        .map_err(|error| AppError::Other(format!("failed to encode GraphQL request: {error}")))?;
    let response = request(token, Method::POST, "graphql", None, Some(&encoded))?;
    ensure_success(&response)?;
    let value: Value = serde_json::from_slice(&response.body)
        .map_err(|error| AppError::Other(format!("failed to parse GraphQL response: {error}")))?;
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
            return Err(AppError::Other(format!("GitHub GraphQL: {detail}")));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_message_prefers_github_json_message() {
        assert_eq!(
            error_message(
                403,
                br#"{"message":"Resource not accessible by integration"}"#
            ),
            "Resource not accessible by integration (HTTP 403)"
        );
    }

    #[test]
    fn error_message_joins_graphql_errors() {
        assert_eq!(
            error_message(
                200,
                br#"{"errors":[{"message":"Could not resolve to a Repository"},{"message":"bad oid"}]}"#
            ),
            "Could not resolve to a Repository; bad oid (HTTP 200)"
        );
    }

    #[test]
    fn error_message_falls_back_to_status() {
        assert_eq!(error_message(502, b""), "GitHub request failed (HTTP 502)");
    }
}
