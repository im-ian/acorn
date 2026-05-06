//! Reads Claude Code session transcripts to extract the current todo/task list.
//!
//! Two CC tool families produce the data:
//!
//! - Legacy `TodoWrite` — every call snapshots the entire todos array; the last
//!   one wins.
//! - Current `TaskCreate` / `TaskUpdate` — incremental. `TaskCreate` allocates a
//!   sequential numeric ID returned in the tool_result text ("Task #N created");
//!   `TaskUpdate` flips status by `taskId`.
//!
//! We replay both: legacy snapshot wins when present (older sessions), otherwise
//! we reconstruct from Task* events.
//!
//! The transcript path is `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
//! CC's cwd encoding has shifted across versions (some chars replaced with `-`,
//! others preserved), so rather than reverse-engineer it we just look up
//! `~/.claude/projects/*/<session-id>.jsonl` — UUIDs are unique enough that
//! the first hit is the right transcript.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, rename = "activeForm")]
    pub active_form: Option<String>,
}

fn projects_root() -> AppResult<PathBuf> {
    let home = directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .ok_or_else(|| AppError::InvalidPath("no home dir".into()))?;
    Ok(home.join(".claude").join("projects"))
}

/// Public re-export so other modules (e.g. session_status) can resolve the
/// same JSONL path without duplicating the lookup logic.
pub fn locate_transcript_for(session_id: &str) -> AppResult<Option<PathBuf>> {
    locate_transcript(session_id)
}

fn locate_transcript(session_id: &str) -> AppResult<Option<PathBuf>> {
    let root = projects_root()?;
    if !root.exists() {
        return Ok(None);
    }
    let target = format!("{session_id}.jsonl");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    for entry in entries.flatten() {
        let candidate = entry.path().join(&target);
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// Parsed pending TaskCreate awaiting its tool_result to learn the task ID.
struct PendingCreate {
    subject: String,
    active_form: Option<String>,
}

pub fn read_latest_todos(session_id: &str, _cwd: &Path) -> AppResult<Vec<TodoItem>> {
    let path = match locate_transcript(session_id)? {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let f = File::open(&path)?;
    let reader = BufReader::new(f);

    let mut todo_write_snapshot: Option<Vec<TodoItem>> = None;
    let mut pending: HashMap<String, PendingCreate> = HashMap::new();
    let mut tasks: BTreeMap<u32, TodoItem> = BTreeMap::new();
    let mut creation_order: Vec<u32> = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        // Cheap pre-filter: every shape we care about mentions one of these tool
        // names verbatim. Skip JSON parsing for unrelated lines.
        if !line.contains("\"TodoWrite\"")
            && !line.contains("\"TaskCreate\"")
            && !line.contains("\"TaskUpdate\"")
            && !line.contains("Task #")
        {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let content = match v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            Some(c) => c,
            None => continue,
        };
        for item in content {
            handle_item(
                item,
                &mut todo_write_snapshot,
                &mut pending,
                &mut tasks,
                &mut creation_order,
            );
        }
    }

    if let Some(todos) = todo_write_snapshot {
        return Ok(todos);
    }
    let ordered: Vec<TodoItem> = creation_order
        .into_iter()
        .filter_map(|id| tasks.get(&id).cloned())
        .collect();
    Ok(ordered)
}

fn handle_item(
    item: &serde_json::Value,
    todo_write_snapshot: &mut Option<Vec<TodoItem>>,
    pending: &mut HashMap<String, PendingCreate>,
    tasks: &mut BTreeMap<u32, TodoItem>,
    creation_order: &mut Vec<u32>,
) {
    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if item_type == "tool_use" {
        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
        match name {
            "TodoWrite" => {
                if let Some(todos_val) = item.get("input").and_then(|i| i.get("todos")) {
                    if let Ok(parsed) = serde_json::from_value::<Vec<TodoItem>>(todos_val.clone())
                    {
                        *todo_write_snapshot = Some(parsed);
                    }
                }
            }
            "TaskCreate" => {
                let tool_use_id = item
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = item.get("input");
                let subject = input
                    .and_then(|i| i.get("subject"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let active_form = input
                    .and_then(|i| i.get("activeForm"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                if !tool_use_id.is_empty() {
                    pending.insert(
                        tool_use_id,
                        PendingCreate {
                            subject,
                            active_form,
                        },
                    );
                }
            }
            "TaskUpdate" => {
                let input = item.get("input");
                let task_id = input
                    .and_then(|i| i.get("taskId"))
                    .and_then(|t| {
                        t.as_str()
                            .and_then(|s| s.parse::<u32>().ok())
                            .or_else(|| t.as_u64().map(|n| n as u32))
                    });
                let status = input
                    .and_then(|i| i.get("status"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if let Some(id) = task_id {
                    if let Some(task) = tasks.get_mut(&id) {
                        task.status = status.to_string();
                    }
                }
            }
            _ => {}
        }
        return;
    }
    if item_type == "tool_result" {
        let tool_use_id = item
            .get("tool_use_id")
            .and_then(|i| i.as_str())
            .unwrap_or("");
        if tool_use_id.is_empty() {
            return;
        }
        let pending_entry = match pending.remove(tool_use_id) {
            Some(p) => p,
            None => return,
        };
        // tool_result.content can be a string or array of {type:"text", text:...}
        let text = extract_tool_result_text(item);
        if let Some(id) = parse_task_id(&text) {
            tasks.insert(
                id,
                TodoItem {
                    content: pending_entry.subject,
                    status: "pending".to_string(),
                    active_form: pending_entry.active_form,
                },
            );
            creation_order.push(id);
        }
    }
}

fn extract_tool_result_text(item: &serde_json::Value) -> String {
    let c = match item.get("content") {
        Some(c) => c,
        None => return String::new(),
    };
    if let Some(s) = c.as_str() {
        return s.to_string();
    }
    if let Some(arr) = c.as_array() {
        let mut out = String::new();
        for sub in arr {
            if let Some(t) = sub.get("text").and_then(|t| t.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        return out;
    }
    String::new()
}

/// Parse `"Task #42 created successfully: ..."` → 42.
fn parse_task_id(text: &str) -> Option<u32> {
    let marker = "Task #";
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse::<u32>().ok()
}
