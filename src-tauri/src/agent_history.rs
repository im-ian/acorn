use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::fs_explorer::move_to_trash;
use crate::worktree;

const MAX_SCAN_FILES_PER_PROVIDER: usize = 5_000;
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
const READ_HEAD_INITIAL_BYTES: u64 = 256 * 1024;
const READ_HEAD_MAX_BYTES: u64 = 2 * 1024 * 1024;
const READ_TAIL_BYTES: u64 = 256 * 1024;
const PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentHistoryProvider {
    Claude,
    Codex,
    Antigravity,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentHistoryItem {
    pub provider: AgentHistoryProvider,
    pub id: String,
    pub title: String,
    pub preview: Option<String>,
    pub cwd: Option<String>,
    pub worktree: Option<AgentHistoryWorktree>,
    pub transcript_path: String,
    pub updated_at: u64,
    pub resume_command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentHistoryWorktree {
    pub name: String,
    pub path: String,
    pub exists: bool,
}

pub fn list_agent_history(
    repo_path: PathBuf,
    limit: Option<usize>,
) -> AppResult<Vec<AgentHistoryItem>> {
    let repo = normalize_path(&repo_path);
    if repo.as_os_str().is_empty() {
        return Err(AppError::InvalidPath(repo_path.display().to_string()));
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let mut items = Vec::new();
    let scope = HistoryScope::Project(&repo);
    items.extend(scan_codex(scope));
    items.extend(scan_claude(scope));
    items.extend(scan_antigravity(scope));
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items.truncate(limit);
    Ok(items)
}

pub fn list_unscoped_agent_history(
    project_paths: Vec<PathBuf>,
    limit: Option<usize>,
) -> AppResult<Vec<AgentHistoryItem>> {
    let projects = project_paths
        .into_iter()
        .map(|path| normalize_path(&path))
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let mut items = Vec::new();
    let scope = HistoryScope::Unscoped {
        projects: &projects,
    };
    items.extend(scan_codex(scope));
    items.extend(scan_claude(scope));
    items.extend(scan_antigravity(scope));
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items.truncate(limit);
    Ok(items)
}

pub fn trash_agent_history_transcript(
    provider: AgentHistoryProvider,
    id: String,
    transcript_path: PathBuf,
) -> AppResult<()> {
    let path = transcript_path.canonicalize().map_err(|_| {
        AppError::InvalidPath(format!("transcript missing: {}", transcript_path.display()))
    })?;
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err(AppError::InvalidPath(format!(
            "not a transcript jsonl: {}",
            path.display()
        )));
    }
    if !path.is_file() {
        return Err(AppError::InvalidPath(format!(
            "not a file: {}",
            path.display()
        )));
    }

    match provider {
        AgentHistoryProvider::Codex => {
            let root = codex_sessions_root()
                .and_then(|p| p.canonicalize().ok())
                .ok_or_else(|| AppError::InvalidPath("Codex sessions root missing".to_string()))?;
            if !is_codex_transcript_path(&path, &root) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Codex sessions: {}",
                    path.display()
                )));
            }
            if !codex_transcript_matches_id(&path, &id) {
                return Err(AppError::InvalidPath(
                    "transcript id does not match selected Codex session".to_string(),
                ));
            }
        }
        AgentHistoryProvider::Claude => {
            let root = claude_projects_root()
                .and_then(|p| p.canonicalize().ok())
                .ok_or_else(|| AppError::InvalidPath("Claude projects root missing".to_string()))?;
            if !is_claude_transcript_path(&path, &root) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Claude projects: {}",
                    path.display()
                )));
            }
            let stem = path.file_stem().and_then(|s| s.to_str());
            if stem != Some(id.as_str()) {
                return Err(AppError::InvalidPath(
                    "transcript id does not match selected Claude session".to_string(),
                ));
            }
        }
        AgentHistoryProvider::Antigravity => {
            let roots = antigravity_brain_roots()
                .into_iter()
                .filter_map(|root| root.canonicalize().ok())
                .collect::<Vec<_>>();
            if roots.is_empty() {
                return Err(AppError::InvalidPath(
                    "Antigravity sessions root missing".to_string(),
                ));
            }
            if !roots.iter().any(|root| path.starts_with(root)) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Antigravity sessions: {}",
                    path.display()
                )));
            }
            if !antigravity_transcript_matches_id(&path, &id) {
                return Err(AppError::InvalidPath(
                    "transcript id does not match selected Antigravity session".to_string(),
                ));
            }
            if !is_antigravity_transcript_path(&path) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Antigravity sessions: {}",
                    path.display()
                )));
            }
        }
    }

    move_to_trash(&path)?;
    Ok(())
}

#[derive(Clone, Copy)]
enum HistoryScope<'a> {
    Project(&'a Path),
    Unscoped { projects: &'a [PathBuf] },
}

impl HistoryScope<'_> {
    fn accepts_cwd(self, cwd: &str) -> bool {
        match self {
            HistoryScope::Project(repo) => path_belongs_to_project(cwd, repo),
            HistoryScope::Unscoped { projects } => !projects
                .iter()
                .any(|project| path_belongs_to_project(cwd, project)),
        }
    }

    fn worktree_for_cwd(self, cwd: &str) -> Option<AgentHistoryWorktree> {
        match self {
            HistoryScope::Project(repo) => worktree_for_cwd(cwd, repo),
            HistoryScope::Unscoped { .. } => {
                discovered_worktree_for_cwd(cwd).or_else(|| managed_worktree_from_path(cwd))
            }
        }
    }
}

fn scan_codex(scope: HistoryScope<'_>) -> Vec<AgentHistoryItem> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    let files = collect_files(&root, |path| is_codex_transcript_path(path, &root));
    files
        .into_iter()
        .filter_map(|path| parse_codex_file(&path, scope))
        .collect()
}

fn scan_claude(scope: HistoryScope<'_>) -> Vec<AgentHistoryItem> {
    let Some(root) = claude_projects_root() else {
        return Vec::new();
    };
    let files = collect_files(&root, |path| is_claude_transcript_path(path, &root));
    files
        .into_iter()
        .filter_map(|path| parse_claude_file(&path, scope))
        .collect()
}

fn scan_antigravity(scope: HistoryScope<'_>) -> Vec<AgentHistoryItem> {
    let mut files = Vec::new();
    for root in antigravity_brain_roots() {
        files.extend(collect_files(&root, is_antigravity_transcript_path));
    }
    files.sort_by(|a, b| file_updated_at(b).cmp(&file_updated_at(a)));
    files.truncate(MAX_SCAN_FILES_PER_PROVIDER);
    files
        .into_iter()
        .filter_map(|path| parse_antigravity_file(&path, scope))
        .collect()
}

fn collect_files(root: &Path, accept: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() && accept(&path) {
                out.push(path);
            }
        }
    }

    out.sort_by(|a, b| file_updated_at(b).cmp(&file_updated_at(a)));
    out.truncate(MAX_SCAN_FILES_PER_PROVIDER);
    out
}

fn parse_codex_file(path: &Path, scope: HistoryScope<'_>) -> Option<AgentHistoryItem> {
    let state = parse_codex_state(path)?;
    let cwd = state.cwd.clone()?;
    if !scope.accepts_cwd(&cwd) {
        return None;
    }
    let worktree = scope.worktree_for_cwd(&cwd);
    let id = state.id.or_else(|| codex_id_from_filename(path))?;
    let title = state
        .title
        .or_else(|| state.preview.clone())
        .unwrap_or_else(|| "Codex session".to_string());
    Some(AgentHistoryItem {
        provider: AgentHistoryProvider::Codex,
        resume_command: Some(format!("codex resume {id}")),
        id,
        title: collapse_preview(&title, PREVIEW_CHARS)
            .unwrap_or_else(|| "Codex session".to_string()),
        preview: state
            .preview
            .and_then(|s| collapse_preview(&s, PREVIEW_CHARS)),
        cwd: Some(cwd),
        worktree,
        transcript_path: path.display().to_string(),
        updated_at: file_updated_at(path),
    })
}

fn parse_claude_file(path: &Path, scope: HistoryScope<'_>) -> Option<AgentHistoryItem> {
    let state = parse_claude_state(path)?;
    let cwd = state.cwd.clone()?;
    if !scope.accepts_cwd(&cwd) {
        return None;
    }
    let worktree = scope.worktree_for_cwd(&cwd);
    let id = state.id.or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
    })?;
    let title = state
        .title
        .or_else(|| state.preview.clone())
        .unwrap_or_else(|| "Claude session".to_string());
    Some(AgentHistoryItem {
        provider: AgentHistoryProvider::Claude,
        resume_command: Some(format!("claude --resume {id}")),
        id,
        title: collapse_preview(&title, PREVIEW_CHARS)
            .unwrap_or_else(|| "Claude session".to_string()),
        preview: state
            .preview
            .and_then(|s| collapse_preview(&s, PREVIEW_CHARS)),
        cwd: Some(cwd),
        worktree,
        transcript_path: path.display().to_string(),
        updated_at: file_updated_at(path),
    })
}

fn parse_antigravity_file(path: &Path, scope: HistoryScope<'_>) -> Option<AgentHistoryItem> {
    let state = parse_antigravity_state(path)?;
    let id = state.id.or_else(|| antigravity_id_from_path(path))?;
    let mut cwd_candidates = Vec::new();
    if let Some(cwd) = state.cwd.clone() {
        cwd_candidates.push(cwd);
    } else {
        cwd_candidates.extend(antigravity_cwds_from_agent_state(&id));
    }
    let saw_cwd_candidate = !cwd_candidates.is_empty();
    let cwd = cwd_candidates
        .into_iter()
        .find(|cwd| scope.accepts_cwd(cwd));
    match (scope, cwd.as_deref(), saw_cwd_candidate) {
        (HistoryScope::Project(_), None, _) => return None,
        (HistoryScope::Unscoped { .. }, None, true) => return None,
        _ => {}
    }
    let worktree = cwd.as_deref().and_then(|cwd| scope.worktree_for_cwd(cwd));
    let title = state
        .title
        .or_else(|| state.preview.clone())
        .unwrap_or_else(|| "Antigravity session".to_string());
    Some(AgentHistoryItem {
        provider: AgentHistoryProvider::Antigravity,
        resume_command: Some(format!("agy --conversation {id}")),
        id,
        title: collapse_preview(&title, PREVIEW_CHARS)
            .unwrap_or_else(|| "Antigravity session".to_string()),
        preview: state
            .preview
            .and_then(|s| collapse_preview(&s, PREVIEW_CHARS)),
        cwd,
        worktree,
        transcript_path: path.display().to_string(),
        updated_at: file_updated_at(path),
    })
}

pub fn transcript_first_user_message(
    provider: AgentHistoryProvider,
    path: &Path,
    max_chars: usize,
) -> Option<String> {
    let state = match provider {
        AgentHistoryProvider::Codex => parse_codex_state(path)?,
        AgentHistoryProvider::Claude => parse_claude_state(path)?,
        AgentHistoryProvider::Antigravity => parse_antigravity_state(path)?,
    };
    state
        .title
        .and_then(|title| collapse_preview(&title, max_chars))
}

fn parse_codex_state(path: &Path) -> Option<ParsedAgentFile> {
    let mut state = ParsedAgentFile::default();
    for line in sample_lines(path).ok()? {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let payload = value.get("payload");

        if state.id.is_none() {
            state.id = string_at(payload, "id")
                .or_else(|| string_at(payload, "session_id"))
                .or_else(|| string_at(Some(&value), "session_id"));
        }
        if state.cwd.is_none() {
            state.cwd = string_at(payload, "cwd")
                .or_else(|| string_at(Some(&value), "cwd"))
                .or_else(|| extract_cwd_from_text(&value_texts(&value)));
        }

        let role = string_at(payload, "role");
        let text = first_text(&value_texts(&value));
        if state.title.is_none() && role.as_deref() == Some("user") {
            state.title = text.clone();
        }
        if role.as_deref() == Some("assistant") {
            state.preview = text.clone().or(state.preview);
        }
        if state.preview.is_none() {
            state.preview = response_text(&value).or(state.preview);
        }
    }

    Some(state)
}

fn parse_claude_state(path: &Path) -> Option<ParsedAgentFile> {
    let mut state = ParsedAgentFile::default();
    for line in sample_lines(path).ok()? {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if state.id.is_none() {
            state.id = string_at(Some(&value), "sessionId");
        }
        if state.cwd.is_none() {
            state.cwd =
                string_at(Some(&value), "cwd").or_else(|| string_at(Some(&value), "project"));
        }
        if is_claude_meta_event(&value) {
            continue;
        }
        let ty = string_at(Some(&value), "type");
        let text = first_claude_display_text(&value_texts(&value));
        if state.title.is_none() && ty.as_deref() == Some("user") {
            state.title = text.clone();
        }
        if ty.as_deref() == Some("assistant") {
            state.preview = text.clone().or(state.preview);
        }
    }

    Some(state)
}

fn parse_antigravity_state(path: &Path) -> Option<ParsedAgentFile> {
    let mut state = ParsedAgentFile {
        id: antigravity_id_from_path(path),
        ..ParsedAgentFile::default()
    };
    for line in sample_lines(path).ok()? {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let ty = string_at(Some(&value), "type");
        let text = string_at(Some(&value), "content").or_else(|| first_text(&value_texts(&value)));
        if state.cwd.is_none() {
            state.cwd = string_at(Some(&value), "cwd")
                .or_else(|| string_at(Some(&value), "project"))
                .or_else(|| first_workspace_path(&value));
        }
        match ty.as_deref() {
            Some("USER_INPUT") => {
                if state.title.is_none() {
                    state.title = text.and_then(|s| extract_antigravity_user_request(&s));
                }
            }
            Some("PLANNER_RESPONSE") => {
                state.preview = text.or(state.preview);
            }
            _ => {}
        }
    }

    Some(state)
}

fn extract_antigravity_user_request(content: &str) -> Option<String> {
    let marker = "<USER_REQUEST>";
    let end_marker = "</USER_REQUEST>";
    if let Some(start) = content.find(marker) {
        let after = start + marker.len();
        let end = content[after..]
            .find(end_marker)
            .map(|offset| after + offset)
            .unwrap_or(content.len());
        return collapse_preview(&content[after..end], PREVIEW_CHARS);
    }
    collapse_preview(content, PREVIEW_CHARS)
}

fn first_workspace_path(value: &Value) -> Option<String> {
    value
        .get("workspacePaths")
        .or_else(|| value.get("workspace_paths"))
        .and_then(|paths| paths.as_array())
        .and_then(|paths| paths.iter().find_map(|path| path.as_str()))
        .map(ToString::to_string)
}

#[derive(Default)]
struct ParsedAgentFile {
    id: Option<String>,
    title: Option<String>,
    preview: Option<String>,
    cwd: Option<String>,
}

fn sample_lines(path: &Path) -> std::io::Result<Vec<String>> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut bytes = Vec::new();
    let head_max = READ_HEAD_MAX_BYTES.min(len);
    let mut read = 0_u64;
    let mut saw_newline = false;
    while read < head_max {
        let chunk_len = (64 * 1024).min(head_max - read);
        let mut chunk = vec![0; chunk_len as usize];
        file.read_exact(&mut chunk)?;
        saw_newline = saw_newline || chunk.contains(&b'\n');
        bytes.extend(chunk);
        read += chunk_len;
        if read >= READ_HEAD_INITIAL_BYTES && saw_newline {
            break;
        }
    }

    if len > read {
        let tail_start = len.saturating_sub(READ_TAIL_BYTES);
        file.seek(SeekFrom::Start(tail_start))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail)?;
        bytes.push(b'\n');
        bytes.extend(tail);
    }

    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .map(str::to_string)
        .collect())
}

fn value_texts(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_texts(value.get("message").unwrap_or(value), &mut out);
    if let Some(payload) = value.get("payload") {
        collect_texts(payload, &mut out);
    }
    out
}

fn collect_texts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if !s.trim().is_empty() {
                out.push(s.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_texts(item, out);
            }
        }
        Value::Object(map) => {
            for key in ["text", "output_text", "message", "content"] {
                if let Some(child) = map.get(key) {
                    collect_texts(child, out);
                }
            }
        }
        _ => {}
    }
}

fn first_text(texts: &[String]) -> Option<String> {
    texts
        .iter()
        .map(|s| s.trim())
        .find(|s| !s.is_empty() && !looks_like_context_block(s))
        .map(str::to_string)
}

fn first_claude_display_text(texts: &[String]) -> Option<String> {
    texts
        .iter()
        .map(|s| s.trim())
        .find(|s| {
            !s.is_empty() && !looks_like_context_block(s) && !looks_like_claude_control_text(s)
        })
        .map(str::to_string)
}

fn is_claude_meta_event(value: &Value) -> bool {
    value.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
}

fn looks_like_claude_control_text(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    [
        "<command-message>",
        "<command-name>",
        "<ide-context>",
        "<local-command-",
        "<system-reminder>",
        "<task-notification>",
    ]
    .iter()
    .any(|tag| lower.starts_with(tag))
        || lower.starts_with("caveat: the messages below were generated by a local command")
}

fn response_text(value: &Value) -> Option<String> {
    for pointer in [
        "/payload/response/output",
        "/response_payload/output",
        "/payload/output",
    ] {
        if let Some(v) = value.pointer(pointer) {
            let texts = value_texts(v);
            if let Some(text) = first_text(&texts) {
                return Some(text);
            }
        }
    }
    None
}

fn looks_like_context_block(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<environment_context>")
        || lower.contains("<cwd>")
        || lower.contains("# agents.md")
        || lower.contains("<instructions>")
}

fn extract_cwd_from_text(texts: &[String]) -> Option<String> {
    for text in texts {
        let Some(start) = text.find("<cwd>") else {
            continue;
        };
        let after = start + "<cwd>".len();
        let Some(end) = text[after..].find("</cwd>") else {
            continue;
        };
        let cwd = text[after..after + end].trim();
        if !cwd.is_empty() {
            return Some(cwd.to_string());
        }
    }
    None
}

fn string_at(value: Option<&Value>, key: &str) -> Option<String> {
    value?
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn codex_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    uuid_suffix(stem)
}

fn codex_id_from_transcript(path: &Path) -> Option<String> {
    for line in sample_lines(path).ok()? {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let payload = value.get("payload");
        if let Some(id) = string_at(payload, "id")
            .or_else(|| string_at(payload, "session_id"))
            .or_else(|| string_at(Some(&value), "session_id"))
        {
            return Some(id);
        }
    }
    None
}

fn codex_transcript_matches_id(path: &Path, id: &str) -> bool {
    codex_id_from_filename(path).as_deref() == Some(id)
        || codex_id_from_transcript(path).as_deref() == Some(id)
}

fn is_codex_transcript_path(path: &Path, sessions_root: &Path) -> bool {
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return false;
    }
    let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    if !filename.starts_with("rollout-") {
        return false;
    }
    if codex_id_from_filename(path).is_none() {
        return false;
    }
    let Ok(relative) = path.strip_prefix(sessions_root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(std::path::Component::Normal(year)) = components.next() else {
        return false;
    };
    let Some(std::path::Component::Normal(month)) = components.next() else {
        return false;
    };
    let Some(std::path::Component::Normal(day)) = components.next() else {
        return false;
    };
    let Some(std::path::Component::Normal(_file)) = components.next() else {
        return false;
    };
    components.next().is_none()
        && numeric_component(year, 4)
        && numeric_component(month, 2)
        && numeric_component(day, 2)
}

fn is_claude_transcript_path(path: &Path, projects_root: &Path) -> bool {
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return false;
    }
    if !path_has_uuid_stem(path) {
        return false;
    }
    let Ok(relative) = path.strip_prefix(projects_root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(std::path::Component::Normal(_slug)) = components.next() else {
        return false;
    };
    let Some(std::path::Component::Normal(_file)) = components.next() else {
        return false;
    };
    components.next().is_none()
}

fn path_has_uuid_stem(path: &Path) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|stem| Uuid::parse_str(stem).is_ok())
        .unwrap_or(false)
}

fn uuid_suffix(stem: &str) -> Option<String> {
    if stem.len() < 36 {
        return None;
    }
    let suffix = &stem[stem.len() - 36..];
    Uuid::parse_str(suffix).ok().map(|_| suffix.to_string())
}

fn numeric_component(component: &std::ffi::OsStr, len: usize) -> bool {
    component
        .to_str()
        .map(|s| s.len() == len && s.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false)
}

fn collapse_preview(s: &str, max_chars: usize) -> Option<String> {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let mut out = collapsed.chars().take(max_chars).collect::<String>();
    if collapsed.chars().count() > max_chars {
        out.push('…');
    }
    Some(out)
}

fn path_is_within(cwd: &str, repo: &Path) -> bool {
    let cwd = normalize_path(Path::new(cwd));
    cwd == repo || cwd.starts_with(repo)
}

fn path_belongs_to_project(cwd: &str, repo: &Path) -> bool {
    path_is_within(cwd, repo)
        || registered_worktree_for_cwd(cwd, repo).is_some()
        || same_git_common_dir(Path::new(cwd), repo)
}

fn same_git_common_dir(a: &Path, b: &Path) -> bool {
    let Ok(a_repo) = git2::Repository::discover(a) else {
        return false;
    };
    let Ok(b_repo) = git2::Repository::discover(b) else {
        return false;
    };
    normalize_path(a_repo.commondir()) == normalize_path(b_repo.commondir())
}

fn worktree_for_cwd(cwd: &str, repo: &Path) -> Option<AgentHistoryWorktree> {
    registered_worktree_for_cwd(cwd, repo)
        .or_else(|| discovered_worktree_for_cwd(cwd))
        .or_else(|| managed_worktree_from_path(cwd))
}

fn registered_worktree_for_cwd(cwd: &str, repo: &Path) -> Option<AgentHistoryWorktree> {
    let cwd = normalize_path(Path::new(cwd));
    let repo = git2::Repository::discover(repo).ok()?;
    let names = repo.worktrees().ok()?;
    for name in names.iter().flatten() {
        let Ok(wt) = repo.find_worktree(name) else {
            continue;
        };
        let path = normalize_path(wt.path());
        if cwd == path || cwd.starts_with(&path) {
            return Some(AgentHistoryWorktree {
                name: name.to_string(),
                path: path.display().to_string(),
                exists: path.exists(),
            });
        }
    }
    None
}

fn discovered_worktree_for_cwd(cwd: &str) -> Option<AgentHistoryWorktree> {
    let repo = git2::Repository::discover(cwd).ok()?;
    let workdir = repo.workdir()?;
    if !worktree::is_linked_worktree_root(workdir) {
        return None;
    }
    let path = normalize_path(workdir);
    Some(AgentHistoryWorktree {
        name: linked_worktree_name(&repo).unwrap_or_else(|| {
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("worktree")
                .to_string()
        }),
        path: path.display().to_string(),
        exists: path.exists(),
    })
}

fn linked_worktree_name(repo: &git2::Repository) -> Option<String> {
    repo.path()
        .components()
        .next_back()
        .and_then(|c| c.as_os_str().to_str())
        .filter(|name| !name.is_empty() && *name != ".git")
        .map(str::to_string)
}

fn managed_worktree_from_path(cwd: &str) -> Option<AgentHistoryWorktree> {
    let path = normalize_path(Path::new(cwd));
    let parts = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    for idx in 0..parts.len().saturating_sub(2) {
        let marker = parts[idx].as_str();
        if (marker == ".acorn" || marker == ".claude") && parts[idx + 1] == "worktrees" {
            let name = parts[idx + 2].clone();
            let worktree_path = parts
                .iter()
                .take(idx + 3)
                .fold(PathBuf::new(), |mut acc, part| {
                    acc.push(part);
                    acc
                });
            return Some(AgentHistoryWorktree {
                name,
                path: worktree_path.display().to_string(),
                exists: worktree_path.exists(),
            });
        }
    }
    None
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        let mut out = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    })
}

fn file_updated_at(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn codex_sessions_root() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".codex")))
        .map(|root| root.join("sessions"))
}

fn claude_projects_root() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".claude").join("projects"))
}

fn google_agent_storage_root() -> Option<PathBuf> {
    std::env::var_os("ANTIGRAVITY_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_DIR").map(PathBuf::from))
        .or_else(|| home_dir().map(|home| home.join(".gemini")))
}

fn antigravity_brain_roots() -> Vec<PathBuf> {
    let Some(root) = google_agent_storage_root() else {
        return Vec::new();
    };
    ["antigravity", "antigravity-ide", "antigravity-cli"]
        .into_iter()
        .map(|profile| root.join(profile).join("brain"))
        .filter(|path| path.is_dir())
        .collect()
}

fn is_antigravity_transcript_path(path: &Path) -> bool {
    path.file_name().and_then(|s| s.to_str()) == Some("transcript.jsonl")
        && path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            == Some("logs")
        && path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            == Some(".system_generated")
        && antigravity_id_from_path(path).is_some()
}

fn antigravity_id_from_path(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_str()?;
    if filename != "transcript.jsonl" {
        return None;
    }
    let logs = path.parent()?.file_name()?.to_str()?;
    let generated = path.parent()?.parent()?.file_name()?.to_str()?;
    if logs != "logs" || generated != ".system_generated" {
        return None;
    }
    let id = path.parent()?.parent()?.parent()?.file_name()?.to_str()?;
    Uuid::parse_str(id).ok().map(|_| id.to_string())
}

fn antigravity_transcript_matches_id(path: &Path, id: &str) -> bool {
    antigravity_id_from_path(path).as_deref() == Some(id)
}

#[derive(Debug)]
struct AgentStateCwd {
    cwd: String,
    updated_at: u64,
}

fn antigravity_cwds_from_agent_state(id: &str) -> Vec<String> {
    let Some(data_dir) = acorn_daemon::paths::data_dir().ok() else {
        return Vec::new();
    };
    antigravity_cwds_from_agent_state_at(&data_dir, id)
        .into_iter()
        .map(|entry| entry.cwd)
        .collect()
}

fn antigravity_cwds_from_agent_state_at(data_dir: &Path, id: &str) -> Vec<AgentStateCwd> {
    let root = data_dir.join("agent-state");
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            if !dir.is_dir() {
                return None;
            }
            if read_trimmed_state_file(&dir.join("antigravity.id")).as_deref() != Some(id) {
                return None;
            }
            let cwd = read_trimmed_state_file(&dir.join("antigravity.cwd"))?;
            let updated_at = file_updated_at(&dir.join("antigravity.id"))
                .max(file_updated_at(&dir.join("antigravity.cwd")));
            Some(AgentStateCwd { cwd, updated_at })
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out.dedup_by(|a, b| a.cwd == b.cwd);
    out
}

fn read_trimmed_state_file(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn home_dir() -> Option<PathBuf> {
    directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn codex_transcript_match_accepts_payload_id_when_filename_differs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("rollout-2026-05-18T00-00-00-000Z-filename-id.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"payload":{{"id":"payload-id","cwd":"/tmp/demo"}}}}"#
        )
        .unwrap();

        assert!(codex_transcript_matches_id(&path, "payload-id"));
    }

    #[test]
    fn codex_id_from_filename_extracts_full_uuid_suffix() {
        let path = Path::new(
            "/Users/tester/.codex/sessions/2026/05/21/rollout-2026-05-21T10-13-44-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl",
        );

        assert_eq!(
            codex_id_from_filename(path).as_deref(),
            Some("019e4818-7c15-7e60-9b3b-898a1c7803d6")
        );
    }

    #[test]
    fn codex_transcript_path_accepts_date_rollout_uuid_jsonl() {
        let root = Path::new("/Users/tester/.codex/sessions");
        let path = root.join(
            "2026/05/21/rollout-2026-05-21T10-13-44-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl",
        );

        assert!(is_codex_transcript_path(&path, root));
    }

    #[test]
    fn codex_transcript_path_rejects_global_history_jsonl() {
        let root = Path::new("/Users/tester/.codex/sessions");
        let path = Path::new("/Users/tester/.codex/history.jsonl");

        assert!(!is_codex_transcript_path(path, root));
    }

    #[test]
    fn codex_transcript_path_rejects_archived_sessions_rollout() {
        let root = Path::new("/Users/tester/.codex/sessions");
        let path = Path::new(
            "/Users/tester/.codex/archived_sessions/rollout-2026-05-19T10-46-24-019e3de9-aa25-75f3-b357-48b38137df11.jsonl",
        );

        assert!(!is_codex_transcript_path(path, root));
    }

    #[test]
    fn codex_transcript_path_rejects_non_rollout_session_jsonl() {
        let root = Path::new("/Users/tester/.codex/sessions");
        let path = root.join("2026/05/21/history.jsonl");

        assert!(!is_codex_transcript_path(&path, root));
    }

    #[test]
    fn claude_transcript_path_accepts_project_uuid_jsonl() {
        let root = Path::new("/Users/tester/.claude/projects");
        let path = root.join("-Users-tester-demo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");

        assert!(is_claude_transcript_path(&path, root));
    }

    #[test]
    fn claude_transcript_path_rejects_global_history_jsonl() {
        let root = Path::new("/Users/tester/.claude/projects");
        let path = Path::new("/Users/tester/.claude/history.jsonl");

        assert!(!is_claude_transcript_path(path, root));
    }

    #[test]
    fn claude_transcript_path_rejects_non_uuid_project_jsonl() {
        let root = Path::new("/Users/tester/.claude/projects");
        let path = root.join("-Users-tester-demo/history.jsonl");

        assert!(!is_claude_transcript_path(&path, root));
    }

    #[test]
    fn antigravity_transcript_path_accepts_brain_transcript() {
        let path = Path::new(
            "/Users/tester/.gemini/antigravity/brain/17f38e8c-3a7e-408b-8c79-aef7432c0fd2/.system_generated/logs/transcript.jsonl",
        );

        assert!(is_antigravity_transcript_path(path));
        assert_eq!(
            antigravity_id_from_path(path).as_deref(),
            Some("17f38e8c-3a7e-408b-8c79-aef7432c0fd2")
        );
    }

    #[test]
    fn antigravity_history_uses_user_request_and_planner_preview() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("17f38e8c-3a7e-408b-8c79-aef7432c0fd2/.system_generated/logs/transcript.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "USER_INPUT",
                "status": "DONE",
                "workspacePaths": ["/tmp/acorn-antigravity-project"],
                "content": "<USER_REQUEST>\nWire Antigravity as a session provider\n</USER_REQUEST>",
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "content": "Antigravity provider wiring is complete.",
            })
        )
        .unwrap();
        drop(file);

        let projects: Vec<PathBuf> = Vec::new();
        let item = parse_antigravity_file(
            &transcript,
            HistoryScope::Unscoped {
                projects: &projects,
            },
        )
        .unwrap();

        assert_eq!(item.provider, AgentHistoryProvider::Antigravity);
        assert_eq!(item.id, "17f38e8c-3a7e-408b-8c79-aef7432c0fd2");
        assert_eq!(item.cwd.as_deref(), Some("/tmp/acorn-antigravity-project"));
        assert_eq!(item.title, "Wire Antigravity as a session provider");
        assert_eq!(
            item.preview.as_deref(),
            Some("Antigravity provider wiring is complete.")
        );
        assert_eq!(
            item.resume_command.as_deref(),
            Some("agy --conversation 17f38e8c-3a7e-408b-8c79-aef7432c0fd2")
        );
    }

    #[test]
    fn antigravity_cwd_fallback_reads_agent_state_marker() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("agent-state/session-1");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("antigravity.id"),
            "17f38e8c-3a7e-408b-8c79-aef7432c0fd2\n",
        )
        .unwrap();
        fs::write(state_dir.join("antigravity.cwd"), "/tmp/acorn-project\n").unwrap();

        let entries = antigravity_cwds_from_agent_state_at(
            dir.path(),
            "17f38e8c-3a7e-408b-8c79-aef7432c0fd2",
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].cwd, "/tmp/acorn-project");
    }

    #[test]
    fn claude_history_uses_first_real_user_message_for_title() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let transcript = dir
            .path()
            .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "user",
                "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "cwd": repo.display().to_string(),
                "isMeta": true,
                "message": {
                    "role": "user",
                    "content": "<local-command-caveat>Caveat: The messages below were generated by a local command.</local-command-caveat>",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": "<command-name>/clear</command-name>",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": "Show me recent sessions",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": "Here is the real answer.",
                        },
                    ],
                },
            })
        )
        .unwrap();
        drop(file);

        let projects: Vec<PathBuf> = Vec::new();
        let item = parse_claude_file(
            &transcript,
            HistoryScope::Unscoped {
                projects: &projects,
            },
        )
        .unwrap();

        assert_eq!(item.title, "Show me recent sessions");
        assert_eq!(item.preview.as_deref(), Some("Here is the real answer."));
    }

    #[test]
    fn transcript_first_user_message_returns_collapsed_first_user_message() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "user",
                "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "cwd": "/tmp/demo",
                "message": {
                    "role": "user",
                    "content": "Please inspect\n\n  the failing release workflow and summarize the fix",
                },
            })
        )
        .unwrap();
        drop(file);

        let title =
            transcript_first_user_message(AgentHistoryProvider::Claude, &transcript, 32).unwrap();

        assert_eq!(title, "Please inspect the failing relea…");
    }

    #[test]
    fn unscoped_history_accepts_cwd_inside_unregistered_git_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let nested = repo.join("src");
        fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&repo).unwrap();

        let projects: Vec<PathBuf> = Vec::new();
        let scope = HistoryScope::Unscoped {
            projects: &projects,
        };

        assert!(scope.accepts_cwd(nested.to_str().unwrap()));
    }

    #[test]
    fn unscoped_history_rejects_cwd_inside_registered_project() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        let nested = project.join("src");
        fs::create_dir_all(&nested).unwrap();

        let projects = vec![normalize_path(&project)];
        let scope = HistoryScope::Unscoped {
            projects: &projects,
        };

        assert!(!scope.accepts_cwd(nested.to_str().unwrap()));
    }

    #[test]
    fn unscoped_history_accepts_cwd_outside_git_repos_and_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("scratch");
        fs::create_dir_all(&local).unwrap();

        let projects: Vec<PathBuf> = Vec::new();
        let scope = HistoryScope::Unscoped {
            projects: &projects,
        };

        assert!(scope.accepts_cwd(local.to_str().unwrap()));
    }
}
