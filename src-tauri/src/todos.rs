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
use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const MAX_PROJECT_DIR_ENTRIES: usize = 10_000;
const MAX_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
const MAX_TRANSCRIPT_LINES: usize = 250_000;
const MAX_REPLAY_ITEMS: usize = 50_000;
const MAX_TASKS: usize = 2_000;
const MAX_PENDING_CREATES: usize = 2_000;
const MAX_TODO_TEXT_BYTES: usize = 16 * 1024;
const MAX_STATUS_BYTES: usize = 128;
const MAX_TOOL_USE_ID_BYTES: usize = 256;
const MAX_RETAINED_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ReplayLimits {
    max_project_dir_entries: usize,
    max_transcript_bytes: u64,
    max_jsonl_line_bytes: usize,
    max_transcript_lines: usize,
    max_replay_items: usize,
    max_tasks: usize,
    max_pending_creates: usize,
    max_todo_text_bytes: usize,
    max_status_bytes: usize,
    max_tool_use_id_bytes: usize,
    max_retained_text_bytes: usize,
}

const DEFAULT_LIMITS: ReplayLimits = ReplayLimits {
    max_project_dir_entries: MAX_PROJECT_DIR_ENTRIES,
    max_transcript_bytes: MAX_TRANSCRIPT_BYTES,
    max_jsonl_line_bytes: MAX_JSONL_LINE_BYTES,
    max_transcript_lines: MAX_TRANSCRIPT_LINES,
    max_replay_items: MAX_REPLAY_ITEMS,
    max_tasks: MAX_TASKS,
    max_pending_creates: MAX_PENDING_CREATES,
    max_todo_text_bytes: MAX_TODO_TEXT_BYTES,
    max_status_bytes: MAX_STATUS_BYTES,
    max_tool_use_id_bytes: MAX_TOOL_USE_ID_BYTES,
    max_retained_text_bytes: MAX_RETAINED_TEXT_BYTES,
};

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
    locate_transcript_in(&root, session_id, DEFAULT_LIMITS)
}

fn locate_transcript_in(
    root: &Path,
    session_id: &str,
    limits: ReplayLimits,
) -> AppResult<Option<PathBuf>> {
    if !root.exists() {
        return Ok(None);
    }
    let target = transcript_file_name(session_id)?;
    // The configured root itself may intentionally be a symlink (for example,
    // to another volume). Resolve it once, then reject links below that root.
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(_) => return Ok(None),
    };
    let entries = match std::fs::read_dir(&canonical_root) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    for (index, entry) in entries.enumerate() {
        if index >= limits.max_project_dir_entries {
            return Err(limit_error(
                "Claude project directory entries",
                limits.max_project_dir_entries,
            ));
        }
        let Ok(entry) = entry else { continue };
        let Ok(entry_type) = entry.file_type() else {
            continue;
        };
        if !entry_type.is_dir() {
            continue;
        }
        let candidate = entry.path().join(&target);
        let Ok(candidate_meta) = std::fs::symlink_metadata(&candidate) else {
            continue;
        };
        if candidate_meta.file_type().is_symlink() || !candidate_meta.is_file() {
            continue;
        }
        let Ok(resolved) = candidate.canonicalize() else {
            continue;
        };
        if resolved.starts_with(&canonical_root) {
            return Ok(Some(resolved));
        }
    }
    Ok(None)
}

fn transcript_file_name(session_id: &str) -> AppResult<String> {
    let session_id = Uuid::parse_str(session_id)
        .map_err(|_| AppError::InvalidPath("transcript session id must be a UUID".into()))?;
    Ok(format!("{session_id}.jsonl"))
}

/// Parsed pending TaskCreate awaiting its tool_result to learn the task ID.
struct PendingCreate {
    subject: String,
    active_form: Option<String>,
}

pub fn read_latest_todos(session_id: &str, _cwd: &Path) -> AppResult<Vec<TodoItem>> {
    let root = projects_root()?;
    read_latest_todos_in(&root, session_id, DEFAULT_LIMITS)
}

fn read_latest_todos_in(
    root: &Path,
    session_id: &str,
    limits: ReplayLimits,
) -> AppResult<Vec<TodoItem>> {
    let path = match locate_transcript_in(root, session_id, limits)? {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    read_todos_from_path(&path, limits)
}

fn read_todos_from_path(path: &Path, limits: ReplayLimits) -> AppResult<Vec<TodoItem>> {
    read_todos_from_path_with(path, limits, |path| File::open(path))
}

fn read_todos_from_path_with<F>(
    path: &Path,
    limits: ReplayLimits,
    open: F,
) -> AppResult<Vec<TodoItem>>
where
    F: FnOnce(&Path) -> std::io::Result<File>,
{
    let path_meta = std::fs::symlink_metadata(path)?;
    validate_transcript_metadata(path, &path_meta)?;
    let file = open(path)?;
    let metadata = file.metadata()?;
    validate_transcript_metadata(path, &metadata)?;
    validate_same_transcript_file(path, &path_meta, &metadata)?;
    let snapshot_len = metadata.len();
    if snapshot_len > limits.max_transcript_bytes {
        return Err(limit_error(
            "bytes",
            usize::try_from(limits.max_transcript_bytes).unwrap_or(usize::MAX),
        ));
    }

    // Replay the size observed on the opened descriptor. Appends after this
    // point are intentionally deferred to the next refresh instead of growing
    // the current request without bound.
    let reader = BufReader::new(file.take(snapshot_len));
    replay_todos(reader, limits)
}

fn validate_transcript_metadata(path: &Path, metadata: &Metadata) -> AppResult<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "todo transcript must be a regular file: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(AppError::InvalidPath(format!(
                "todo transcript must not be hard-linked: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn validate_same_transcript_file(
    path: &Path,
    before: &Metadata,
    opened: &Metadata,
) -> AppResult<()> {
    use std::os::unix::fs::MetadataExt;

    if before.dev() != opened.dev() || before.ino() != opened.ino() {
        return Err(AppError::InvalidPath(format!(
            "todo transcript changed while opening: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_same_transcript_file(
    _path: &Path,
    _before: &Metadata,
    _opened: &Metadata,
) -> AppResult<()> {
    Ok(())
}

#[derive(Default)]
struct ReplayState {
    todo_write_snapshot: Option<Vec<TodoItem>>,
    pending: HashMap<String, PendingCreate>,
    tasks: BTreeMap<u32, TodoItem>,
    creation_order: Vec<u32>,
    retained_text_bytes: usize,
}

impl ReplayState {
    fn finish(self, limits: ReplayLimits) -> AppResult<Vec<TodoItem>> {
        if let Some(todos) = self.todo_write_snapshot {
            return Ok(todos);
        }

        let mut ordered = Vec::with_capacity(self.creation_order.len());
        let mut output_text_bytes = 0usize;
        for id in self.creation_order {
            let Some(task) = self.tasks.get(&id) else {
                continue;
            };
            output_text_bytes = add_with_limit(
                output_text_bytes,
                todo_item_bytes(task),
                "retained todo text bytes",
                limits.max_retained_text_bytes,
            )?;
            ordered.push(task.clone());
        }
        Ok(ordered)
    }

    fn set_snapshot(&mut self, todos: Vec<TodoItem>, limits: ReplayLimits) -> AppResult<()> {
        if todos.len() > limits.max_tasks {
            return Err(limit_error("tasks", limits.max_tasks));
        }
        let mut retained = 0usize;
        for todo in &todos {
            validate_todo_item(todo, limits)?;
            retained = add_with_limit(
                retained,
                todo_item_bytes(todo),
                "retained todo text bytes",
                limits.max_retained_text_bytes,
            )?;
        }

        self.pending.clear();
        self.tasks.clear();
        self.creation_order.clear();
        self.todo_write_snapshot = Some(todos);
        self.retained_text_bytes = retained;
        Ok(())
    }

    fn insert_pending(
        &mut self,
        tool_use_id: &str,
        subject: &str,
        active_form: Option<&str>,
        limits: ReplayLimits,
    ) -> AppResult<()> {
        validate_bytes(
            tool_use_id,
            "tool use id bytes",
            limits.max_tool_use_id_bytes,
        )?;
        validate_bytes(subject, "todo content bytes", limits.max_todo_text_bytes)?;
        if let Some(active_form) = active_form {
            validate_bytes(
                active_form,
                "todo active form bytes",
                limits.max_todo_text_bytes,
            )?;
        }
        if !self.pending.contains_key(tool_use_id)
            && self.pending.len() >= limits.max_pending_creates
        {
            return Err(limit_error(
                "pending task creates",
                limits.max_pending_creates,
            ));
        }

        let old_bytes = self
            .pending
            .get(tool_use_id)
            .map(|old| pending_bytes(tool_use_id, old))
            .unwrap_or(0);
        let new_entry = PendingCreate {
            subject: subject.to_string(),
            active_form: active_form.map(str::to_string),
        };
        let new_bytes = pending_bytes(tool_use_id, &new_entry);
        self.retained_text_bytes = replace_with_limit(
            self.retained_text_bytes,
            old_bytes,
            new_bytes,
            "retained todo text bytes",
            limits.max_retained_text_bytes,
        )?;
        self.pending.insert(tool_use_id.to_string(), new_entry);
        Ok(())
    }

    fn update_task_status(&mut self, id: u32, status: &str, limits: ReplayLimits) -> AppResult<()> {
        let Some(task) = self.tasks.get(&id) else {
            return Ok(());
        };
        validate_bytes(status, "todo status bytes", limits.max_status_bytes)?;
        self.retained_text_bytes = replace_with_limit(
            self.retained_text_bytes,
            task.status.len(),
            status.len(),
            "retained todo text bytes",
            limits.max_retained_text_bytes,
        )?;
        self.tasks.get_mut(&id).expect("task checked above").status = status.to_string();
        Ok(())
    }

    fn resolve_pending(
        &mut self,
        tool_use_id: &str,
        task_id: Option<u32>,
        limits: ReplayLimits,
    ) -> AppResult<()> {
        validate_bytes(
            tool_use_id,
            "tool use id bytes",
            limits.max_tool_use_id_bytes,
        )?;
        let Some(pending_entry) = self.pending.remove(tool_use_id) else {
            return Ok(());
        };
        self.retained_text_bytes = self
            .retained_text_bytes
            .checked_sub(pending_bytes(tool_use_id, &pending_entry))
            .ok_or_else(|| AppError::Other("todo replay byte accounting underflow".into()))?;
        let Some(task_id) = task_id else {
            return Ok(());
        };
        if self.creation_order.len() >= limits.max_tasks {
            return Err(limit_error("tasks", limits.max_tasks));
        }
        if !self.tasks.contains_key(&task_id) && self.tasks.len() >= limits.max_tasks {
            return Err(limit_error("tasks", limits.max_tasks));
        }

        let task = TodoItem {
            content: pending_entry.subject,
            status: "pending".to_string(),
            active_form: pending_entry.active_form,
        };
        validate_todo_item(&task, limits)?;
        let old_bytes = self.tasks.get(&task_id).map(todo_item_bytes).unwrap_or(0);
        self.retained_text_bytes = replace_with_limit(
            self.retained_text_bytes,
            old_bytes,
            todo_item_bytes(&task),
            "retained todo text bytes",
            limits.max_retained_text_bytes,
        )?;
        self.tasks.insert(task_id, task);
        self.creation_order.push(task_id);
        Ok(())
    }
}

fn replay_todos<R: BufRead>(mut reader: R, limits: ReplayLimits) -> AppResult<Vec<TodoItem>> {
    let mut state = ReplayState::default();
    let mut line = Vec::new();
    let mut line_count = 0usize;
    let mut replay_items = 0usize;

    loop {
        let read = read_bounded_line(&mut reader, &mut line, limits.max_jsonl_line_bytes)?;
        if read == 0 {
            break;
        }
        line_count = add_with_limit(line_count, 1, "lines", limits.max_transcript_lines)?;
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
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
            replay_items = add_with_limit(
                replay_items,
                1,
                "replay content items",
                limits.max_replay_items,
            )?;
            handle_item(item, &mut state, limits)?;
        }
    }

    state.finish(limits)
}

fn handle_item(
    item: &serde_json::Value,
    state: &mut ReplayState,
    limits: ReplayLimits,
) -> AppResult<()> {
    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if item_type == "tool_use" {
        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
        match name {
            "TodoWrite" => {
                if let Some(todos_val) = item.get("input").and_then(|i| i.get("todos")) {
                    if let Ok(parsed) = serde_json::from_value::<Vec<TodoItem>>(todos_val.clone()) {
                        state.set_snapshot(parsed, limits)?;
                    }
                }
            }
            "TaskCreate" => {
                if state.todo_write_snapshot.is_some() {
                    return Ok(());
                }
                let tool_use_id = item.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let input = item.get("input");
                let subject = input
                    .and_then(|i| i.get("subject"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                let active_form = input
                    .and_then(|i| i.get("activeForm"))
                    .and_then(|s| s.as_str());
                if !tool_use_id.is_empty() {
                    state.insert_pending(tool_use_id, subject, active_form, limits)?;
                }
            }
            "TaskUpdate" => {
                if state.todo_write_snapshot.is_some() {
                    return Ok(());
                }
                let input = item.get("input");
                let task_id = input.and_then(|i| i.get("taskId")).and_then(|t| {
                    t.as_str()
                        .and_then(|s| s.parse::<u32>().ok())
                        .or_else(|| t.as_u64().and_then(|n| u32::try_from(n).ok()))
                });
                let status = input
                    .and_then(|i| i.get("status"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if let Some(id) = task_id {
                    state.update_task_status(id, status, limits)?;
                }
            }
            _ => {}
        }
        return Ok(());
    }
    if item_type == "tool_result" {
        if state.todo_write_snapshot.is_some() {
            return Ok(());
        }
        let tool_use_id = item
            .get("tool_use_id")
            .and_then(|i| i.as_str())
            .unwrap_or("");
        if tool_use_id.is_empty() {
            return Ok(());
        }
        state.resolve_pending(tool_use_id, task_id_from_tool_result(item), limits)?;
    }
    Ok(())
}

fn task_id_from_tool_result(item: &serde_json::Value) -> Option<u32> {
    let c = item.get("content")?;
    if let Some(s) = c.as_str() {
        return parse_task_id(s);
    }
    if let Some(arr) = c.as_array() {
        return arr
            .iter()
            .filter_map(|sub| sub.get("text").and_then(|text| text.as_str()))
            .find_map(parse_task_id);
    }
    None
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_bytes: usize,
) -> AppResult<usize> {
    line.clear();
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| AppError::Other("todo JSONL line limit overflow".into()))?;
    let mut limited = reader.take(read_limit as u64);
    let read = limited.read_until(b'\n', line)?;
    if line.len() > max_bytes {
        return Err(limit_error("JSONL line bytes", max_bytes));
    }
    Ok(read)
}

fn validate_todo_item(item: &TodoItem, limits: ReplayLimits) -> AppResult<()> {
    validate_bytes(
        &item.content,
        "todo content bytes",
        limits.max_todo_text_bytes,
    )?;
    validate_bytes(&item.status, "todo status bytes", limits.max_status_bytes)?;
    if let Some(active_form) = &item.active_form {
        validate_bytes(
            active_form,
            "todo active form bytes",
            limits.max_todo_text_bytes,
        )?;
    }
    Ok(())
}

fn validate_bytes(value: &str, label: &str, max: usize) -> AppResult<()> {
    if value.len() > max {
        return Err(limit_error(label, max));
    }
    Ok(())
}

fn todo_item_bytes(item: &TodoItem) -> usize {
    item.content.len() + item.status.len() + item.active_form.as_ref().map(String::len).unwrap_or(0)
}

fn pending_bytes(tool_use_id: &str, pending: &PendingCreate) -> usize {
    tool_use_id.len()
        + pending.subject.len()
        + pending.active_form.as_ref().map(String::len).unwrap_or(0)
}

fn add_with_limit(current: usize, additional: usize, label: &str, max: usize) -> AppResult<usize> {
    let next = current
        .checked_add(additional)
        .ok_or_else(|| limit_error(label, max))?;
    if next > max {
        return Err(limit_error(label, max));
    }
    Ok(next)
}

fn replace_with_limit(
    current: usize,
    removed: usize,
    added: usize,
    label: &str,
    max: usize,
) -> AppResult<usize> {
    let remaining = current
        .checked_sub(removed)
        .ok_or_else(|| AppError::Other("todo replay byte accounting underflow".into()))?;
    add_with_limit(remaining, added, label, max)
}

fn limit_error(label: &str, max: usize) -> AppError {
    AppError::Other(format!(
        "todo transcript {label} limit exceeded (maximum {max})"
    ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::{Cursor, Write};

    const SESSION_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

    fn small_limits() -> ReplayLimits {
        ReplayLimits {
            max_project_dir_entries: 8,
            max_transcript_bytes: 16 * 1024,
            max_jsonl_line_bytes: 8 * 1024,
            max_transcript_lines: 32,
            max_replay_items: 32,
            max_tasks: 8,
            max_pending_creates: 8,
            max_todo_text_bytes: 256,
            max_status_bytes: 32,
            max_tool_use_id_bytes: 64,
            max_retained_text_bytes: 1024,
        }
    }

    fn transcript_line(items: Vec<Value>) -> Vec<u8> {
        let mut line = serde_json::to_vec(&json!({
            "message": { "content": items }
        }))
        .unwrap();
        line.push(b'\n');
        line
    }

    fn task_create(tool_use_id: &str, subject: &str) -> Value {
        json!({
            "type": "tool_use",
            "name": "TaskCreate",
            "id": tool_use_id,
            "input": { "subject": subject, "activeForm": format!("Doing {subject}") }
        })
    }

    fn task_result(tool_use_id: &str, task_id: u32) -> Value {
        json!({
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": format!("Task #{task_id} created successfully")
        })
    }

    fn task_update(task_id: Value, status: &str) -> Value {
        json!({
            "type": "tool_use",
            "name": "TaskUpdate",
            "input": { "taskId": task_id, "status": status }
        })
    }

    fn todo_write(content: &str, status: &str) -> Value {
        json!({
            "type": "tool_use",
            "name": "TodoWrite",
            "input": {
                "todos": [{
                    "content": content,
                    "status": status,
                    "activeForm": format!("Doing {content}")
                }]
            }
        })
    }

    fn replay(bytes: &[u8], limits: ReplayLimits) -> AppResult<Vec<TodoItem>> {
        replay_todos(BufReader::new(Cursor::new(bytes)), limits)
    }

    fn write_transcript(root: &Path, bytes: &[u8]) -> PathBuf {
        let project = root.join("-tmp-acorn");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("{SESSION_ID}.jsonl"));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn transcript_file_name_normalizes_uuid() {
        let file = transcript_file_name("550E8400-E29B-41D4-A716-446655440000").unwrap();
        assert_eq!(file, "550e8400-e29b-41d4-a716-446655440000.jsonl");
    }

    #[test]
    fn transcript_file_name_rejects_path_components() {
        assert!(transcript_file_name("../outside").is_err());
        assert!(transcript_file_name("/tmp/outside").is_err());
    }

    #[test]
    fn replays_task_create_result_and_update_in_creation_order() {
        let bytes = transcript_line(vec![
            task_create("tool-1", "First"),
            task_result("tool-1", 1),
            task_create("tool-2", "Second"),
            task_result("tool-2", 2),
            task_update(json!(1), "completed"),
        ]);

        let todos = replay(&bytes, small_limits()).unwrap();

        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "First");
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[1].content, "Second");
        assert_eq!(todos[1].status, "pending");
    }

    #[test]
    fn last_valid_todo_write_snapshot_still_wins() {
        let bytes = transcript_line(vec![
            task_create("tool-1", "Task API item"),
            task_result("tool-1", 1),
            todo_write("Old snapshot", "pending"),
            task_update(json!(1), "completed"),
            todo_write("Latest snapshot", "in_progress"),
        ]);

        let todos = replay(&bytes, small_limits()).unwrap();

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "Latest snapshot");
        assert_eq!(todos[0].status, "in_progress");
    }

    #[test]
    fn locates_only_regular_transcripts_below_the_project_root() {
        let root = tempfile::tempdir().unwrap();
        let path = write_transcript(root.path(), b"\n");

        let located = locate_transcript_in(root.path(), SESSION_ID, small_limits())
            .unwrap()
            .unwrap();

        assert_eq!(located, path.canonicalize().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn allows_configured_root_symlink_but_rejects_nested_symlinks() {
        use std::os::unix::fs::symlink;

        let actual = tempfile::tempdir().unwrap();
        let regular = actual.path().join("regular-projects");
        std::fs::create_dir(&regular).unwrap();
        let expected = write_transcript(&regular, b"\n");
        let configured_parent = tempfile::tempdir().unwrap();
        let configured = configured_parent.path().join("projects");
        symlink(&regular, &configured).unwrap();
        assert_eq!(
            locate_transcript_in(&configured, SESSION_ID, small_limits())
                .unwrap()
                .unwrap(),
            expected.canonicalize().unwrap()
        );

        let nested_root = tempfile::tempdir().unwrap();
        let outside_project = tempfile::tempdir().unwrap();
        std::fs::write(
            outside_project.path().join(format!("{SESSION_ID}.jsonl")),
            b"\n",
        )
        .unwrap();
        symlink(
            outside_project.path(),
            nested_root.path().join("linked-project"),
        )
        .unwrap();
        assert!(
            locate_transcript_in(nested_root.path(), SESSION_ID, small_limits())
                .unwrap()
                .is_none()
        );

        let leaf_root = tempfile::tempdir().unwrap();
        let leaf_project = leaf_root.path().join("project");
        std::fs::create_dir(&leaf_project).unwrap();
        let outside_file = tempfile::NamedTempFile::new().unwrap();
        symlink(
            outside_file.path(),
            leaf_project.join(format!("{SESSION_ID}.jsonl")),
        )
        .unwrap();
        assert!(
            locate_transcript_in(leaf_root.path(), SESSION_ID, small_limits())
                .unwrap()
                .is_none()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_leaf_replaced_with_symlink_between_validation_and_open() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("transcript.jsonl");
        let moved = directory.path().join("validated-transcript.jsonl");
        std::fs::write(
            &path,
            transcript_line(vec![todo_write("validated", "pending")]),
        )
        .unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            outside.path(),
            transcript_line(vec![todo_write("outside", "completed")]),
        )
        .unwrap();

        let error = read_todos_from_path_with(&path, small_limits(), |requested| {
            std::fs::rename(requested, &moved)?;
            symlink(outside.path(), requested)?;
            File::open(requested)
        })
        .unwrap_err();

        assert!(error.to_string().contains("changed while opening"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hard_linked_transcript() {
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("outside.jsonl");
        let linked = directory.path().join("transcript.jsonl");
        std::fs::write(
            &outside,
            transcript_line(vec![todo_write("outside", "completed")]),
        )
        .unwrap();
        std::fs::hard_link(&outside, &linked).unwrap();

        let error = read_todos_from_path(&linked, small_limits()).unwrap_err();

        assert!(error.to_string().contains("must not be hard-linked"));
    }

    #[test]
    fn rejects_project_directory_scans_over_budget() {
        let root = tempfile::tempdir().unwrap();
        write_transcript(root.path(), b"\n");
        let limits = ReplayLimits {
            max_project_dir_entries: 0,
            ..small_limits()
        };

        let error = locate_transcript_in(root.path(), SESSION_ID, limits).unwrap_err();

        assert!(error
            .to_string()
            .contains("directory entries limit exceeded"));
    }

    #[test]
    fn enforces_snapshot_file_and_jsonl_line_byte_budgets() {
        let root = tempfile::tempdir().unwrap();
        let bytes = transcript_line(vec![todo_write("bounded", "pending")]);
        let path = write_transcript(root.path(), &bytes);

        let exact_file = ReplayLimits {
            max_transcript_bytes: bytes.len() as u64,
            max_jsonl_line_bytes: bytes.len(),
            ..small_limits()
        };
        assert_eq!(read_todos_from_path(&path, exact_file).unwrap().len(), 1);

        let short_file = ReplayLimits {
            max_transcript_bytes: bytes.len() as u64 - 1,
            ..exact_file
        };
        assert!(read_todos_from_path(&path, short_file).is_err());

        let short_line = ReplayLimits {
            max_jsonl_line_bytes: bytes.len() - 1,
            ..exact_file
        };
        assert!(replay(&bytes, short_line).is_err());
    }

    #[test]
    fn enforces_line_replay_item_pending_and_task_budgets() {
        let two_lines = b"{}\n{}\n";
        let line_limited = ReplayLimits {
            max_transcript_lines: 1,
            ..small_limits()
        };
        assert!(replay(two_lines, line_limited).is_err());

        let two_items = transcript_line(vec![
            task_update(json!(1), "pending"),
            task_update(json!(2), "pending"),
        ]);
        let item_limited = ReplayLimits {
            max_replay_items: 1,
            ..small_limits()
        };
        assert!(replay(&two_items, item_limited).is_err());

        let pending = transcript_line(vec![
            task_create("tool-1", "First"),
            task_create("tool-2", "Second"),
        ]);
        let pending_limited = ReplayLimits {
            max_pending_creates: 1,
            ..small_limits()
        };
        assert!(replay(&pending, pending_limited).is_err());

        let tasks = transcript_line(vec![
            task_create("tool-1", "First"),
            task_result("tool-1", 1),
            task_create("tool-2", "Second"),
            task_result("tool-2", 2),
        ]);
        let task_limited = ReplayLimits {
            max_tasks: 1,
            ..small_limits()
        };
        assert!(replay(&tasks, task_limited).is_err());
    }

    #[test]
    fn enforces_field_and_aggregate_retained_text_budgets() {
        let create = transcript_line(vec![task_create("tool-id", "subject")]);
        let id_limited = ReplayLimits {
            max_tool_use_id_bytes: 3,
            ..small_limits()
        };
        assert!(replay(&create, id_limited).is_err());

        let content_limited = ReplayLimits {
            max_todo_text_bytes: 3,
            ..small_limits()
        };
        assert!(replay(&create, content_limited).is_err());

        let status = transcript_line(vec![
            task_create("a", "x"),
            task_result("a", 1),
            task_update(json!(1), "completed"),
        ]);
        let status_limited = ReplayLimits {
            max_status_bytes: 3,
            ..small_limits()
        };
        assert!(replay(&status, status_limited).is_err());

        let aggregate = transcript_line(vec![task_create("a", "1234"), task_create("b", "5678")]);
        let aggregate_limited = ReplayLimits {
            max_retained_text_bytes: 20,
            ..small_limits()
        };
        assert!(replay(&aggregate, aggregate_limited).is_err());
    }

    #[test]
    fn oversized_numeric_task_id_does_not_wrap_to_an_existing_task() {
        let bytes = transcript_line(vec![
            task_create("tool-0", "Zero"),
            task_result("tool-0", 0),
            task_update(json!(u64::from(u32::MAX) + 1), "completed"),
        ]);

        let todos = replay(&bytes, small_limits()).unwrap();

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].status, "pending");
    }

    #[test]
    fn malformed_and_invalid_utf8_records_remain_skippable() {
        let mut bytes = b"{\"TaskCreate\":\xff}\n".to_vec();
        bytes.extend(transcript_line(vec![todo_write("valid", "pending")]));

        let todos = replay(&bytes, small_limits()).unwrap();

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "valid");
    }

    #[test]
    fn opened_file_snapshot_excludes_later_appends() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("transcript.jsonl");
        let initial = transcript_line(vec![todo_write("initial", "pending")]);
        std::fs::write(&path, &initial).unwrap();
        let file = File::open(&path).unwrap();
        let snapshot_len = file.metadata().unwrap().len();

        let appended = transcript_line(vec![todo_write("appended", "completed")]);
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writer.write_all(&appended).unwrap();
        writer.flush().unwrap();

        let todos = replay_todos(BufReader::new(file.take(snapshot_len)), small_limits()).unwrap();

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "initial");
    }
}
