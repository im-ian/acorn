use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::worktree;

const MAX_SCAN_FILES_PER_PROVIDER: usize = 5_000;
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
const READ_HEAD_INITIAL_BYTES: u64 = 256 * 1024;
const READ_HEAD_MAX_BYTES: u64 = 2 * 1024 * 1024;
const READ_TAIL_BYTES: u64 = 256 * 1024;
const PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentHistoryProvider {
    Claude,
    Codex,
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
    items.extend(scan_codex(&repo));
    items.extend(scan_claude(&repo));
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
            if !path.starts_with(&root) {
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
            let root = home_dir()
                .map(|home| home.join(".claude"))
                .and_then(|p| p.canonicalize().ok())
                .ok_or_else(|| AppError::InvalidPath("Claude sessions root missing".to_string()))?;
            if !path.starts_with(&root) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Claude sessions: {}",
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
    }

    trash::delete(&path).map_err(|e| AppError::Other(format!("trash failed: {e}")))?;
    Ok(())
}

fn scan_codex(repo: &Path) -> Vec<AgentHistoryItem> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    let files = collect_files(&root, |path| {
        path.extension().and_then(|s| s.to_str()) == Some("jsonl")
            && path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|name| name.starts_with("rollout-"))
                .unwrap_or(false)
    });
    files
        .into_iter()
        .filter_map(|path| parse_codex_file(&path, repo))
        .collect()
}

fn scan_claude(repo: &Path) -> Vec<AgentHistoryItem> {
    let Some(root) = home_dir().map(|home| home.join(".claude")) else {
        return Vec::new();
    };
    let files = collect_files(&root, |path| {
        path.extension().and_then(|s| s.to_str()) == Some("jsonl")
    });
    files
        .into_iter()
        .filter_map(|path| parse_claude_file(&path, repo))
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

fn parse_codex_file(path: &Path, repo: &Path) -> Option<AgentHistoryItem> {
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

    let cwd = state.cwd.clone()?;
    if !path_belongs_to_project(&cwd, repo) {
        return None;
    }
    let worktree = worktree_for_cwd(&cwd, repo);
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

fn parse_claude_file(path: &Path, repo: &Path) -> Option<AgentHistoryItem> {
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
        let ty = string_at(Some(&value), "type");
        let text = first_text(&value_texts(&value));
        if state.title.is_none() && ty.as_deref() == Some("user") {
            state.title = text.clone();
        }
        if ty.as_deref() == Some("assistant") {
            state.preview = text.clone().or(state.preview);
        }
    }

    let cwd = state.cwd.clone()?;
    if !path_belongs_to_project(&cwd, repo) {
        return None;
    }
    let worktree = worktree_for_cwd(&cwd, repo);
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
    stem.rsplit('-').next().map(str::to_string)
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
}
