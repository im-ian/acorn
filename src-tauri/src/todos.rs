//! Reads Claude Code session transcripts to extract the latest TodoWrite
//! tool_use payload. Each Acorn session passes its UUID via `--session-id` to
//! claude, which writes a JSONL transcript at:
//!
//!   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//!
//! The encoding scheme is: replace every `/` (and `\` on Windows) in the
//! absolute cwd path with `-`. Leading separators produce a leading `-`.

use serde::{Deserialize, Serialize};
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

fn encode_cwd(cwd: &Path) -> String {
    let s = cwd.to_string_lossy();
    s.replace(['/', '\\'], "-")
}

fn transcript_path(session_id: &str, cwd: &Path) -> AppResult<PathBuf> {
    let home = directories::UserDirs::new()
        .and_then(|d| Some(d.home_dir().to_path_buf()))
        .ok_or_else(|| AppError::InvalidPath("no home dir".into()))?;
    Ok(home
        .join(".claude")
        .join("projects")
        .join(encode_cwd(cwd))
        .join(format!("{session_id}.jsonl")))
}

/// Scan a JSONL transcript and return the latest TodoWrite tool_use payload.
/// Returns an empty vec if the transcript does not exist or contains no
/// TodoWrite invocations yet.
pub fn read_latest_todos(session_id: &str, cwd: &Path) -> AppResult<Vec<TodoItem>> {
    let path = transcript_path(session_id, cwd)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let f = File::open(&path)?;
    let reader = BufReader::new(f);

    let mut latest: Vec<TodoItem> = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        // Cheap pre-filter to avoid parsing every JSON line.
        if !line.contains("\"TodoWrite\"") {
            continue;
        }
        if let Some(todos) = extract_todos(&line) {
            latest = todos;
        }
    }
    Ok(latest)
}

/// Parse one JSONL line and return the `todos` payload of the TodoWrite
/// tool_use, if any. The relevant shape is:
///
/// ```json
/// { "message": { "content": [
///     { "type": "tool_use", "name": "TodoWrite",
///       "input": { "todos": [ { "content": "...", "status": "...", "activeForm": "..." } ] } }
/// ] } }
/// ```
fn extract_todos(line: &str) -> Option<Vec<TodoItem>> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let content = v.get("message")?.get("content")?.as_array()?;
    for item in content {
        let is_tool_use = item.get("type").and_then(|t| t.as_str()) == Some("tool_use");
        let is_todo = item.get("name").and_then(|n| n.as_str()) == Some("TodoWrite");
        if !is_tool_use || !is_todo {
            continue;
        }
        let todos = item.get("input")?.get("todos")?.clone();
        if let Ok(parsed) = serde_json::from_value::<Vec<TodoItem>>(todos) {
            return Some(parsed);
        }
    }
    None
}
