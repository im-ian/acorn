//! Bounded HTTPS client for in-process API calls.
//!
//! Tokens go in headers, never argv or logs. Callers must pass an `https://`
//! URL they constructed; userinfo is rejected so a site string cannot smuggle
//! credentials into the request.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use url::Url;

use crate::error::{AppError, AppResult};

const USER_AGENT_VALUE: &str = "acorn";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

fn client() -> AppResult<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(existing) = CLIENT.get() {
        return Ok(existing);
    }
    let built = Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|error| AppError::Other(format!("failed to build HTTPS client: {error}")))?;
    let _ = CLIENT.set(built);
    CLIENT
        .get()
        .ok_or_else(|| AppError::Other("HTTPS client missing".into()))
}

fn validate_https_url(raw: &str) -> AppResult<Url> {
    let parsed =
        Url::parse(raw).map_err(|error| AppError::Other(format!("invalid API URL: {error}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Other("API URL must be https".into()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::Other(
            "API URL must not include credentials".into(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(AppError::Other("API URL host is missing".into()));
    }
    Ok(parsed)
}

pub fn request(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> AppResult<HttpResponse> {
    let url = validate_https_url(url)?;
    let mut header_map = HeaderMap::new();
    header_map.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_static(USER_AGENT_VALUE),
    );
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::Other("invalid HTTP header name".into()))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| AppError::Other("invalid HTTP header value".into()))?;
        header_map.insert(header_name, header_value);
    }

    let mut req = client()?.request(method, url).headers(header_map);
    if let Some(body) = body {
        req = req.body(body.to_vec());
    }

    let response = req
        .send()
        .map_err(|error| AppError::Other(format!("HTTPS request failed: {error}")))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .map_err(|error| AppError::Other(format!("failed to read HTTPS response: {error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(AppError::Other(format!(
            "response exceeded {MAX_BODY_BYTES} bytes"
        )));
    }

    Ok(HttpResponse {
        status,
        body: bytes.to_vec(),
    })
}

pub fn error_message(service: &str, status: u16, body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return format!("{trimmed} (HTTP {status})");
            }
        }
        if let Some(error) = value.get("errorMessages").and_then(Value::as_array) {
            let messages: Vec<&str> = error
                .iter()
                .filter_map(Value::as_str)
                .filter(|message| !message.is_empty())
                .collect();
            if !messages.is_empty() {
                return format!("{} (HTTP {status})", messages.join("; "));
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
        let snippet: String = trimmed.chars().take(180).collect();
        return format!("{snippet} (HTTP {status})");
    }
    format!("{service} request failed (HTTP {status})")
}

pub fn ensure_success(response: &HttpResponse, service: &str) -> AppResult<()> {
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        Err(AppError::Other(error_message(
            service,
            response.status,
            &response.body,
        )))
    }
}

pub fn send(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    service: &str,
) -> AppResult<HttpResponse> {
    let response = request(method, url, headers, body)?;
    ensure_success(&response, service)?;
    Ok(response)
}

pub fn json<T: DeserializeOwned>(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    service: &str,
) -> AppResult<T> {
    let response = request(method, url, headers, body)?;
    ensure_success(&response, service)?;
    if response.body.is_empty() {
        return Err(AppError::Other(format!(
            "{service} response was empty where JSON was required"
        )));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| AppError::Other(format!("failed to parse {service} JSON: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_https_url_rejects_credentials_and_http() {
        assert!(validate_https_url("https://api.linear.app/graphql").is_ok());
        assert!(validate_https_url("http://api.linear.app/graphql").is_err());
        assert!(validate_https_url("https://user:secret@api.linear.app/graphql").is_err());
    }

    #[test]
    fn error_message_prefers_json_message() {
        assert_eq!(
            error_message("Linear", 401, br#"{"message":"Authentication required"}"#),
            "Authentication required (HTTP 401)"
        );
    }

    #[test]
    fn error_message_joins_jira_error_messages() {
        assert_eq!(
            error_message(
                "Jira",
                400,
                br#"{"errorMessages":["The requested API has been removed"]}"#
            ),
            "The requested API has been removed (HTTP 400)"
        );
    }
}
