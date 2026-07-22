use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use acorn_session::SessionAgentProvider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli_resolver;

const APP_SERVER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);
const APP_SERVER_PAGE_LIMIT: u32 = 100;
const APP_SERVER_MAX_PAGES: usize = 10;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalAgentCapabilitySource {
    CodexAppServer,
    ClaudeCliHelp,
    Fallback,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GoalAgentEffortOption {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GoalAgentModelCapability {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    pub supported_efforts: Vec<GoalAgentEffortOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GoalAgentCapabilities {
    pub provider: SessionAgentProvider,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub source: GoalAgentCapabilitySource,
    pub models: Vec<GoalAgentModelCapability>,
    pub effort_options: Vec<GoalAgentEffortOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexModelListResponse {
    #[serde(default)]
    data: Vec<CodexCatalogModel>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexCatalogModel {
    model: String,
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    default_reasoning_effort: Option<String>,
    #[serde(default)]
    supported_reasoning_efforts: Vec<CodexReasoningEffort>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexReasoningEffort {
    reasoning_effort: String,
    #[serde(default)]
    description: String,
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn discover(provider: SessionAgentProvider) -> GoalAgentCapabilities {
    match provider {
        SessionAgentProvider::Codex => discover_codex(),
        SessionAgentProvider::Claude => discover_claude(),
        SessionAgentProvider::Antigravity => GoalAgentCapabilities {
            provider,
            installed: false,
            version: None,
            source: GoalAgentCapabilitySource::Unavailable,
            models: Vec::new(),
            effort_options: Vec::new(),
            warning: Some("Goal sessions support only Claude or Codex".to_string()),
        },
    }
}

fn discover_codex() -> GoalAgentCapabilities {
    let provider = SessionAgentProvider::Codex;
    let installed = cli_resolver::resolve("codex").is_ok();
    if !installed {
        return GoalAgentCapabilities {
            provider,
            installed: false,
            version: None,
            source: GoalAgentCapabilitySource::Unavailable,
            models: Vec::new(),
            effort_options: Vec::new(),
            warning: Some("`codex` CLI was not found in the login shell PATH".to_string()),
        };
    }

    let version = cli_version("codex").ok();
    match codex_model_catalog() {
        Ok(catalog) => {
            let (models, effort_options) = convert_codex_catalog(catalog);
            let warning = models
                .is_empty()
                .then(|| "Codex app-server returned an empty model catalog".to_string());
            GoalAgentCapabilities {
                provider,
                installed: true,
                version,
                source: GoalAgentCapabilitySource::CodexAppServer,
                models,
                effort_options,
                warning,
            }
        }
        Err(error) => GoalAgentCapabilities {
            provider,
            installed: true,
            version,
            source: GoalAgentCapabilitySource::Fallback,
            models: Vec::new(),
            effort_options: Vec::new(),
            warning: Some(format!("Codex model discovery failed: {error}")),
        },
    }
}

fn discover_claude() -> GoalAgentCapabilities {
    let provider = SessionAgentProvider::Claude;
    let installed = cli_resolver::resolve("claude").is_ok();
    let fallback_efforts = fallback_claude_efforts();
    let fallback_models = claude_models_from_help("")
        .into_iter()
        .map(|alias| claude_model_capability(alias, fallback_efforts.clone()))
        .collect();
    if !installed {
        return GoalAgentCapabilities {
            provider,
            installed: false,
            version: None,
            source: GoalAgentCapabilitySource::Unavailable,
            models: fallback_models,
            effort_options: fallback_efforts,
            warning: Some("`claude` CLI was not found in the login shell PATH".to_string()),
        };
    }

    let version = cli_version("claude").ok();
    let help = match cli_output("claude", &["--help"]) {
        Ok(help) => help,
        Err(error) => {
            return GoalAgentCapabilities {
                provider,
                installed: true,
                version,
                source: GoalAgentCapabilitySource::Fallback,
                models: fallback_models,
                effort_options: fallback_efforts,
                warning: Some(format!("Claude capability discovery failed: {error}")),
            };
        }
    };
    let efforts = parse_claude_efforts(&help);
    let efforts = if efforts.is_empty() {
        fallback_claude_efforts()
    } else {
        efforts
    };
    let models = claude_models_from_help(&help)
        .into_iter()
        .map(|alias| claude_model_capability(alias, efforts.clone()))
        .collect();

    GoalAgentCapabilities {
        provider,
        installed: true,
        version,
        source: GoalAgentCapabilitySource::ClaudeCliHelp,
        models,
        effort_options: efforts,
        warning: None,
    }
}

fn cli_version(name: &str) -> Result<String, String> {
    cli_output(name, &["--version"])
        .map(|version| {
            version
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string()
        })
        .and_then(|version| {
            if version.is_empty() {
                Err(format!("`{name} --version` returned no version"))
            } else {
                Ok(version)
            }
        })
}

fn cli_output(name: &str, args: &[&str]) -> Result<String, String> {
    let output = cli_resolver::run(name, |command| {
        command.args(args);
    })
    .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!("`{name} {}` exited with {}", args.join(" "), output.status)
        } else {
            detail
        });
    }
    if stdout.is_empty() {
        Ok(stderr)
    } else {
        Ok(stdout)
    }
}

fn spawn_codex_app_server() -> Result<Child, String> {
    for attempt in 0..2 {
        let path = cli_resolver::resolve("codex").map_err(|error| error.to_string())?;
        match Command::new(path)
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && attempt == 0 => {
                cli_resolver::invalidate("codex");
            }
            Err(error) => return Err(format!("failed to start Codex app-server: {error}")),
        }
    }
    Err("failed to start Codex app-server".to_string())
}

fn codex_model_catalog() -> Result<Vec<CodexCatalogModel>, String> {
    let mut child = ChildGuard(spawn_codex_app_server()?);
    let mut stdin = child
        .0
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin was unavailable".to_string())?;
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("codex-model-catalog-reader".to_string())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let parsed = line.map_err(|error| error.to_string()).and_then(|line| {
                    serde_json::from_str::<Value>(&line).map_err(|e| e.to_string())
                });
                if sender.send(parsed).is_err() {
                    return;
                }
            }
            let _ = sender.send(Err("Codex app-server closed before responding".to_string()));
        })
        .map_err(|error| format!("failed to start Codex response reader: {error}"))?;

    send_app_server_message(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "acorn",
                    "title": "Acorn",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;
    wait_for_app_server_response(&receiver, 1)?;
    send_app_server_message(
        &mut stdin,
        &json!({ "method": "initialized", "params": {} }),
    )?;

    let mut catalog = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..APP_SERVER_MAX_PAGES {
        let request_id = 2 + page as u64;
        send_app_server_message(
            &mut stdin,
            &json!({
                "method": "model/list",
                "id": request_id,
                "params": {
                    "cursor": cursor,
                    "limit": APP_SERVER_PAGE_LIMIT,
                    "includeHidden": false
                }
            }),
        )?;
        let result = wait_for_app_server_response(&receiver, request_id)?;
        let page: CodexModelListResponse = serde_json::from_value(result)
            .map_err(|error| format!("invalid Codex model/list response: {error}"))?;
        catalog.extend(page.data);
        cursor = page.next_cursor;
        if cursor.is_none() {
            return Ok(catalog);
        }
    }
    Err("Codex model/list pagination exceeded the safety limit".to_string())
}

fn send_app_server_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, message).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn wait_for_app_server_response(
    receiver: &Receiver<Result<Value, String>>,
    expected_id: u64,
) -> Result<Value, String> {
    let deadline = Instant::now() + APP_SERVER_RESPONSE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Codex app-server timed out waiting for response {expected_id}"
            ));
        }
        let message = receiver
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => {
                    format!("Codex app-server timed out waiting for response {expected_id}")
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    "Codex app-server response channel closed".to_string()
                }
            })??;
        if message.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(format!("Codex app-server error: {error}"));
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex app-server response omitted result".to_string());
    }
}

fn convert_codex_catalog(
    catalog: Vec<CodexCatalogModel>,
) -> (Vec<GoalAgentModelCapability>, Vec<GoalAgentEffortOption>) {
    let mut seen_models = HashSet::new();
    let mut seen_efforts = HashSet::new();
    let mut effort_options = Vec::new();
    let mut models = Vec::new();

    for model in catalog {
        let Ok(Some(model_id)) = crate::ai::normalize_optional_model_arg(Some(&model.model)) else {
            continue;
        };
        if !seen_models.insert(model_id.clone()) {
            continue;
        }
        let supported_efforts: Vec<_> = model
            .supported_reasoning_efforts
            .into_iter()
            .filter_map(|effort| {
                let effort_id = crate::ai::normalize_effort_arg(Some(&effort.reasoning_effort))
                    .ok()
                    .flatten()?;
                let option = GoalAgentEffortOption {
                    id: effort_id.clone(),
                    description: non_empty(effort.description),
                };
                if seen_efforts.insert(effort_id) {
                    effort_options.push(option.clone());
                }
                Some(option)
            })
            .collect();
        let default_effort = model.default_reasoning_effort.and_then(|effort| {
            crate::ai::normalize_effort_arg(Some(&effort))
                .ok()
                .flatten()
        });
        models.push(GoalAgentModelCapability {
            id: model_id.clone(),
            label: non_empty(model.display_name).unwrap_or(model_id),
            description: non_empty(model.description),
            is_default: model.is_default,
            default_effort,
            supported_efforts,
        });
    }

    (models, effort_options)
}

fn parse_claude_efforts(help: &str) -> Vec<GoalAgentEffortOption> {
    let Some(marker_start) = help.find("--effort <level>") else {
        return Vec::new();
    };
    let section = &help[marker_start..help.len().min(marker_start + 512)];
    let Some(open) = section.find('(') else {
        return Vec::new();
    };
    let Some(close) = section[open + 1..].find(')') else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    section[open + 1..open + 1 + close]
        .split(',')
        .filter_map(|effort| {
            let id = crate::ai::normalize_effort_arg(Some(effort))
                .ok()
                .flatten()?;
            seen.insert(id.clone()).then_some(GoalAgentEffortOption {
                id,
                description: None,
            })
        })
        .collect()
}

fn claude_models_from_help(help: &str) -> Vec<String> {
    let mut aliases = vec!["default".to_string()];
    if let Some(marker_start) = help.find("--model <model>") {
        let section = &help[marker_start..help.len().min(marker_start + 768)];
        let mut rest = section;
        while let Some(open) = rest.find('\'') {
            rest = &rest[open + 1..];
            let Some(close) = rest.find('\'') else {
                break;
            };
            let candidate = rest[..close].trim().to_ascii_lowercase();
            if !candidate.starts_with("claude-")
                && crate::ai::normalize_optional_model_arg(Some(&candidate)).is_ok()
            {
                aliases.push(candidate);
            }
            rest = &rest[close + 1..];
        }
    }
    if aliases.len() == 1 {
        aliases.extend(["opus", "sonnet", "haiku"].map(str::to_string));
    }
    let mut seen = HashSet::new();
    aliases
        .into_iter()
        .filter(|alias| seen.insert(alias.clone()))
        .collect()
}

fn claude_model_capability(
    alias: String,
    supported_efforts: Vec<GoalAgentEffortOption>,
) -> GoalAgentModelCapability {
    let label = if alias == "default" {
        "Default".to_string()
    } else {
        let mut chars = alias.chars();
        chars
            .next()
            .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
            .unwrap_or_default()
    };
    GoalAgentModelCapability {
        id: alias.clone(),
        label,
        description: Some("Claude Code model alias".to_string()),
        is_default: alias == "default",
        default_effort: None,
        supported_efforts,
    }
}

fn fallback_claude_efforts() -> Vec<GoalAgentEffortOption> {
    ["low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .map(|id| GoalAgentEffortOption {
            id: id.to_string(),
            description: None,
        })
        .collect()
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_codex_models_with_per_model_efforts() {
        let catalog: Vec<CodexCatalogModel> = serde_json::from_value(json!([
            {
                "model": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "description": "Frontier coding model",
                "isDefault": true,
                "defaultReasoningEffort": "low",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast" },
                    { "reasoningEffort": "ultra", "description": "Delegates" }
                ]
            },
            {
                "model": "gpt-5.6-luna",
                "displayName": "GPT-5.6-Luna",
                "isDefault": false,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "medium", "description": "Balanced" }
                ]
            }
        ]))
        .expect("catalog fixture");

        let (models, efforts) = convert_codex_catalog(catalog);

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.6-sol");
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));
        assert_eq!(models[0].supported_efforts[1].id, "ultra");
        assert_eq!(
            efforts
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "ultra", "medium"]
        );
    }

    #[test]
    fn parses_claude_help_capabilities() {
        let help = "\
  --effort <level>  Effort level (low, medium, high, xhigh, max)\n\
  --model <model>   Alias (e.g. 'fable', 'opus', or 'sonnet') or full name\n\
  --name <name>     Session name";

        assert_eq!(
            parse_claude_efforts(help)
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(
            claude_models_from_help(help),
            vec!["default", "fable", "opus", "sonnet"]
        );
        assert_eq!(
            claude_models_from_help(""),
            vec!["default", "opus", "sonnet", "haiku"]
        );
    }
}
