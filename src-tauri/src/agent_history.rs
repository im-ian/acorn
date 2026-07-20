use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use acorn_agent::AgentKind;
use acorn_transcript::{
    collapse_preview, parse_transcript_line, parse_transcript_value, ParsedTranscriptLine,
    TranscriptRole,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::fs_explorer::move_to_trash;
use crate::worktree;

const MAX_DISCOVERED_FILES_PER_PROVIDER: usize = 5_000;
const MIN_PARSED_FILES_PER_PROVIDER: usize = 100;
const MAX_PARSED_FILES_PER_PROVIDER: usize = 500;
const PARSED_FILES_PER_RESULT: usize = 5;
const CODEX_SCAN_MAX_DIR_DEPTH: usize = 3;
const CLAUDE_SCAN_MAX_DIR_DEPTH: usize = 1;
const ANTIGRAVITY_SCAN_MAX_DIR_DEPTH: usize = 3;
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
const READ_HEAD_INITIAL_BYTES: u64 = 256 * 1024;
const READ_HEAD_MAX_BYTES: u64 = 2 * 1024 * 1024;
const READ_TAIL_BYTES: u64 = 256 * 1024;
const PREVIEW_CHARS: usize = 160;
const TITLE_CONTEXT_ENTRY_CHARS: usize = 700;
const RECENT_SUMMARY_MESSAGES: usize = 6;
const SUMMARY_MESSAGE_PREVIEW_CHARS: usize = 600;
const TRANSCRIPT_SUMMARY_CACHE_MAX_ENTRIES: usize = 128;
const MAX_DISCOVERY_ENTRIES_PER_PROVIDER: usize = 10_000;
const MAX_TRANSCRIPT_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_SCAN_LINES: usize = 250_000;
const MAX_TRANSCRIPT_LINE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
struct TranscriptScanLimits {
    max_bytes: u64,
    max_lines: usize,
    max_line_bytes: usize,
}

const TRANSCRIPT_SCAN_LIMITS: TranscriptScanLimits = TranscriptScanLimits {
    max_bytes: MAX_TRANSCRIPT_SCAN_BYTES,
    max_lines: MAX_TRANSCRIPT_SCAN_LINES,
    max_line_bytes: MAX_TRANSCRIPT_LINE_BYTES,
};

struct TranscriptSnapshot {
    file: fs::File,
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AgentHistoryProvider {
    Claude,
    Codex,
    Antigravity,
}

impl From<AgentKind> for AgentHistoryProvider {
    fn from(kind: AgentKind) -> Self {
        match kind {
            AgentKind::Claude => Self::Claude,
            AgentKind::Codex => Self::Codex,
            AgentKind::Antigravity => Self::Antigravity,
        }
    }
}

impl AgentHistoryProvider {
    fn kind(&self) -> AgentKind {
        match self {
            Self::Claude => AgentKind::Claude,
            Self::Codex => AgentKind::Codex,
            Self::Antigravity => AgentKind::Antigravity,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentHistoryItem {
    pub provider: AgentHistoryProvider,
    pub id: String,
    pub title: String,
    pub preview: Option<String>,
    pub queued_message_count: u64,
    pub subagent_transcript_count: u64,
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

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct AgentTranscriptTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub messages_with_usage: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentTranscriptSummary {
    pub provider: AgentHistoryProvider,
    pub id: String,
    pub transcript_path: String,
    pub updated_at: u64,
    pub message_count: u64,
    pub user_messages: u64,
    pub assistant_messages: u64,
    pub turn_count: u64,
    pub complete_turns: u64,
    pub running_turns: u64,
    pub recent_messages: Vec<AgentTranscriptMessagePreview>,
    pub token_usage: AgentTranscriptTokenUsage,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentTranscriptMessagePreview {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TranscriptSummaryCacheKey {
    provider: AgentHistoryProvider,
    id: String,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct TranscriptSummaryCacheEntry {
    len: u64,
    modified: Option<SystemTime>,
    summary: AgentTranscriptSummary,
}

type TranscriptSummaryCache = HashMap<TranscriptSummaryCacheKey, TranscriptSummaryCacheEntry>;

fn transcript_summary_cache() -> &'static Mutex<TranscriptSummaryCache> {
    static CACHE: OnceLock<Mutex<TranscriptSummaryCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
    items.extend(scan_codex(scope, limit));
    items.extend(scan_claude(scope, limit));
    items.extend(scan_antigravity(scope, limit));
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items.truncate(limit);
    Ok(items)
}

pub fn agent_transcript_summary(
    repo_path: PathBuf,
    transcript_id: String,
) -> AppResult<Option<AgentTranscriptSummary>> {
    let repo = normalize_path(&repo_path);
    if repo.as_os_str().is_empty() {
        return Err(AppError::InvalidPath(repo_path.display().to_string()));
    }
    let item = find_agent_history_item_by_id(&repo, &transcript_id);
    Ok(item.and_then(|item| summarize_agent_history_item(&item)))
}

pub fn agent_transcript_summary_at_path(
    repo_path: PathBuf,
    provider: AgentHistoryProvider,
    id: String,
    transcript_path: PathBuf,
) -> AppResult<Option<AgentTranscriptSummary>> {
    let repo = normalize_path(&repo_path);
    if repo.as_os_str().is_empty() {
        return Err(AppError::InvalidPath(repo_path.display().to_string()));
    }
    let path = canonical_agent_transcript_path(transcript_path)?;
    validate_agent_transcript_identity(&provider, &id, &path)?;
    let scope = HistoryScope::Project(&repo);
    let item = match provider {
        AgentHistoryProvider::Codex => parse_codex_file(&path, scope),
        AgentHistoryProvider::Claude => parse_claude_file(&path, scope),
        AgentHistoryProvider::Antigravity => parse_antigravity_file(&path, scope),
    };
    Ok(item
        .filter(|item| item.id == id)
        .and_then(|item| summarize_agent_history_item(&item)))
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
    items.extend(scan_codex(scope, limit));
    items.extend(scan_claude(scope, limit));
    items.extend(scan_antigravity(scope, limit));
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items.truncate(limit);
    Ok(items)
}

pub fn trash_agent_history_transcript(
    provider: AgentHistoryProvider,
    id: String,
    transcript_path: PathBuf,
) -> AppResult<()> {
    let path = canonical_agent_transcript_path(transcript_path)?;
    validate_agent_transcript_identity(&provider, &id, &path)?;
    move_to_trash(&path)?;
    Ok(())
}

fn canonical_agent_transcript_path(transcript_path: PathBuf) -> AppResult<PathBuf> {
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
    Ok(path)
}

fn validate_agent_transcript_identity(
    provider: &AgentHistoryProvider,
    id: &str,
    path: &Path,
) -> AppResult<()> {
    match provider {
        AgentHistoryProvider::Codex => {
            let root = codex_sessions_root()
                .and_then(|p| p.canonicalize().ok())
                .ok_or_else(|| AppError::InvalidPath("Codex sessions root missing".to_string()))?;
            if !is_codex_transcript_path(path, &root) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Codex sessions: {}",
                    path.display()
                )));
            }
            if !codex_transcript_matches_id(path, id) {
                return Err(AppError::InvalidPath(
                    "transcript id does not match selected Codex session".to_string(),
                ));
            }
        }
        AgentHistoryProvider::Claude => {
            let root = claude_projects_root()
                .and_then(|p| p.canonicalize().ok())
                .ok_or_else(|| AppError::InvalidPath("Claude projects root missing".to_string()))?;
            if !is_claude_transcript_path(path, &root) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Claude projects: {}",
                    path.display()
                )));
            }
            let stem = path.file_stem().and_then(|s| s.to_str());
            if stem != Some(id) {
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
            if !antigravity_transcript_matches_id(path, id) {
                return Err(AppError::InvalidPath(
                    "transcript id does not match selected Antigravity session".to_string(),
                ));
            }
            if !is_antigravity_transcript_path(path) {
                return Err(AppError::InvalidPath(format!(
                    "transcript is outside Antigravity sessions: {}",
                    path.display()
                )));
            }
        }
    }
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

fn scan_codex(scope: HistoryScope<'_>, limit: usize) -> Vec<AgentHistoryItem> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    let files = collect_files(&root, CODEX_SCAN_MAX_DIR_DEPTH, |path| {
        is_codex_transcript_path(path, &root)
    });
    parse_recent_files(files, limit, |path| parse_codex_file(path, scope))
}

fn scan_claude(scope: HistoryScope<'_>, limit: usize) -> Vec<AgentHistoryItem> {
    let Some(root) = claude_projects_root() else {
        return Vec::new();
    };
    let files = collect_files(&root, CLAUDE_SCAN_MAX_DIR_DEPTH, |path| {
        is_claude_transcript_path(path, &root)
    });
    parse_recent_files(files, limit, |path| parse_claude_file(path, scope))
}

fn scan_antigravity(scope: HistoryScope<'_>, limit: usize) -> Vec<AgentHistoryItem> {
    let roots = antigravity_brain_root_candidates();
    let files = collect_files_across_roots_with_entry_limit(
        &roots,
        ANTIGRAVITY_SCAN_MAX_DIR_DEPTH,
        is_antigravity_transcript_path,
        MAX_DISCOVERY_ENTRIES_PER_PROVIDER,
    );
    parse_recent_files(files, limit, |path| parse_antigravity_file(path, scope))
}

fn find_agent_history_item_by_id(repo: &Path, transcript_id: &str) -> Option<AgentHistoryItem> {
    let scope = HistoryScope::Project(repo);
    find_codex_history_item_by_filename_id(scope, transcript_id)
        .or_else(|| find_claude_history_item_by_stem_id(scope, transcript_id))
        .or_else(|| find_antigravity_history_item_by_path_id(scope, transcript_id))
        .or_else(|| find_codex_history_item_by_parsed_id(scope, transcript_id))
        .or_else(|| find_claude_history_item_by_parsed_id(scope, transcript_id))
        .or_else(|| find_antigravity_history_item_by_parsed_id(scope, transcript_id))
}

fn find_codex_history_item_by_filename_id(
    scope: HistoryScope<'_>,
    transcript_id: &str,
) -> Option<AgentHistoryItem> {
    let root = codex_sessions_root()?;
    let files = collect_files(&root, CODEX_SCAN_MAX_DIR_DEPTH, |path| {
        is_codex_transcript_path(path, &root)
    });
    find_history_item_in_files(
        files
            .iter()
            .filter(|path| codex_id_from_filename(path).as_deref() == Some(transcript_id))
            .cloned(),
        transcript_id,
        |path| parse_codex_file(path, scope),
    )
}

fn find_claude_history_item_by_stem_id(
    scope: HistoryScope<'_>,
    transcript_id: &str,
) -> Option<AgentHistoryItem> {
    let root = claude_projects_root()?;
    let files = collect_files(&root, CLAUDE_SCAN_MAX_DIR_DEPTH, |path| {
        is_claude_transcript_path(path, &root)
    });
    find_history_item_in_files(
        files
            .into_iter()
            .filter(|path| path.file_stem().and_then(|stem| stem.to_str()) == Some(transcript_id)),
        transcript_id,
        |path| parse_claude_file(path, scope),
    )
}

fn find_antigravity_history_item_by_path_id(
    scope: HistoryScope<'_>,
    transcript_id: &str,
) -> Option<AgentHistoryItem> {
    let storage_root = google_agent_storage_root()?;
    find_antigravity_history_item_by_path_id_at(scope, transcript_id, &storage_root)
}

fn find_antigravity_history_item_by_path_id_at(
    scope: HistoryScope<'_>,
    transcript_id: &str,
    storage_root: &Path,
) -> Option<AgentHistoryItem> {
    let id = crate::agent_resume::normalize_provider_id(transcript_id).ok()?;
    for snapshot in crate::agent_resume::open_antigravity_transcript_snapshots_at(storage_root, &id)
    {
        if let Some(item) = parse_antigravity_snapshot(snapshot, scope).filter(|item| item.id == id)
        {
            return Some(item);
        }
    }
    None
}

fn find_codex_history_item_by_parsed_id(
    scope: HistoryScope<'_>,
    transcript_id: &str,
) -> Option<AgentHistoryItem> {
    let root = codex_sessions_root()?;
    let files = collect_files(&root, CODEX_SCAN_MAX_DIR_DEPTH, |path| {
        is_codex_transcript_path(path, &root)
    });
    find_history_item_in_files(parse_budget_files(files), transcript_id, |path| {
        parse_codex_file(path, scope)
    })
}

fn find_claude_history_item_by_parsed_id(
    scope: HistoryScope<'_>,
    transcript_id: &str,
) -> Option<AgentHistoryItem> {
    let root = claude_projects_root()?;
    let files = collect_files(&root, CLAUDE_SCAN_MAX_DIR_DEPTH, |path| {
        is_claude_transcript_path(path, &root)
    });
    find_history_item_in_files(parse_budget_files(files), transcript_id, |path| {
        parse_claude_file(path, scope)
    })
}

fn find_antigravity_history_item_by_parsed_id(
    scope: HistoryScope<'_>,
    transcript_id: &str,
) -> Option<AgentHistoryItem> {
    let roots = antigravity_brain_root_candidates();
    let files = collect_files_across_roots_with_entry_limit(
        &roots,
        ANTIGRAVITY_SCAN_MAX_DIR_DEPTH,
        is_antigravity_transcript_path,
        MAX_DISCOVERY_ENTRIES_PER_PROVIDER,
    );
    find_history_item_in_files(parse_budget_files(files), transcript_id, |path| {
        parse_antigravity_file(path, scope)
    })
}

fn parse_budget_files(files: Vec<PathBuf>) -> impl Iterator<Item = PathBuf> {
    files.into_iter().take(parse_file_budget(DEFAULT_LIMIT))
}

fn find_history_item_in_files(
    files: impl IntoIterator<Item = PathBuf>,
    transcript_id: &str,
    mut parse: impl FnMut(&Path) -> Option<AgentHistoryItem>,
) -> Option<AgentHistoryItem> {
    files
        .into_iter()
        .filter_map(|path| parse(&path))
        .find(|item| item.id == transcript_id)
}

fn collect_files(
    root: &Path,
    max_dir_depth: usize,
    accept: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    collect_files_with_entry_limit(
        root,
        max_dir_depth,
        accept,
        MAX_DISCOVERY_ENTRIES_PER_PROVIDER,
    )
}

fn collect_files_with_entry_limit(
    root: &Path,
    max_dir_depth: usize,
    accept: impl Fn(&Path) -> bool,
    max_entries: usize,
) -> Vec<PathBuf> {
    collect_files_across_roots_with_entry_limit(
        &[root.to_path_buf()],
        max_dir_depth,
        accept,
        max_entries,
    )
}

fn collect_files_across_roots_with_entry_limit(
    roots: &[PathBuf],
    max_dir_depth: usize,
    accept: impl Fn(&Path) -> bool,
    max_entries: usize,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut remaining_entries = max_entries;
    for root in roots {
        if !collect_files_from_root(
            root,
            max_dir_depth,
            &accept,
            &mut remaining_entries,
            &mut out,
        ) {
            return Vec::new();
        }
    }

    out.sort_by(|a, b| file_updated_at(b).cmp(&file_updated_at(a)));
    out.truncate(MAX_DISCOVERED_FILES_PER_PROVIDER);
    out
}

fn collect_files_from_root(
    root: &Path,
    max_dir_depth: usize,
    accept: &impl Fn(&Path) -> bool,
    remaining_entries: &mut usize,
    out: &mut Vec<PathBuf>,
) -> bool {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return true,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    }
    let mut stack = vec![(root.to_path_buf(), 0_usize)];

    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            return false;
        };
        for entry in entries {
            if *remaining_entries == 0 {
                // An incomplete traversal can select the wrong "newest" files,
                // so discard it instead of returning a plausible partial list.
                return false;
            }
            *remaining_entries -= 1;
            let Ok(entry) = entry else {
                return false;
            };
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                return false;
            };
            if file_type.is_dir() {
                if depth < max_dir_depth {
                    stack.push((path, depth + 1));
                }
            } else if file_type.is_file() && accept(&path) {
                out.push(path);
            }
        }
    }
    true
}

fn parse_recent_files<T>(
    files: Vec<PathBuf>,
    limit: usize,
    mut parse: impl FnMut(&Path) -> Option<T>,
) -> Vec<T> {
    let mut out = Vec::new();
    for path in files.into_iter().take(parse_file_budget(limit)) {
        if let Some(item) = parse(&path) {
            out.push(item);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

fn parse_file_budget(limit: usize) -> usize {
    if limit == 0 {
        return 0;
    }
    limit
        .saturating_mul(PARSED_FILES_PER_RESULT)
        .clamp(MIN_PARSED_FILES_PER_PROVIDER, MAX_PARSED_FILES_PER_PROVIDER)
}

fn parse_codex_file(path: &Path, scope: HistoryScope<'_>) -> Option<AgentHistoryItem> {
    let state = parse_agent_state(AgentKind::Codex, path)?;
    if state.internal_title_generation {
        return None;
    }
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
        queued_message_count: state.queued_message_count,
        subagent_transcript_count: state.subagent_transcript_count,
        cwd: Some(cwd),
        worktree,
        transcript_path: path.display().to_string(),
        updated_at: file_updated_at(path),
    })
}

fn parse_claude_file(path: &Path, scope: HistoryScope<'_>) -> Option<AgentHistoryItem> {
    let state = parse_agent_state(AgentKind::Claude, path)?;
    if state.internal_title_generation {
        return None;
    }
    if state.conversation_message_count == 0
        && state.queued_message_count == 0
        && state.subagent_transcript_count == 0
    {
        return None;
    }
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
        queued_message_count: state.queued_message_count,
        subagent_transcript_count: state.subagent_transcript_count,
        cwd: Some(cwd),
        worktree,
        transcript_path: path.display().to_string(),
        updated_at: file_updated_at(path),
    })
}

fn parse_antigravity_file(path: &Path, scope: HistoryScope<'_>) -> Option<AgentHistoryItem> {
    let state = parse_agent_state(AgentKind::Antigravity, path)?;
    build_antigravity_item(path, state, file_updated_at(path), scope)
}

fn parse_antigravity_snapshot(
    snapshot: crate::agent_resume::AntigravityTranscriptSnapshot,
    scope: HistoryScope<'_>,
) -> Option<AgentHistoryItem> {
    let crate::agent_resume::AntigravityTranscriptSnapshot {
        path,
        file,
        len,
        modified,
    } = snapshot;
    let state = parse_agent_state_from_opened(AgentKind::Antigravity, &path, file, len)?;
    build_antigravity_item(&path, state, updated_at_from_modified(modified), scope)
}

fn build_antigravity_item(
    path: &Path,
    state: ParsedAgentFile,
    updated_at: u64,
    scope: HistoryScope<'_>,
) -> Option<AgentHistoryItem> {
    if state.internal_title_generation {
        return None;
    }
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
        queued_message_count: state.queued_message_count,
        subagent_transcript_count: state.subagent_transcript_count,
        cwd,
        worktree,
        transcript_path: path.display().to_string(),
        updated_at,
    })
}

#[cfg(test)]
pub fn transcript_first_user_message(
    provider: AgentHistoryProvider,
    path: &Path,
    max_chars: usize,
) -> Option<String> {
    let state = parse_agent_state(provider.kind(), path)?;
    state
        .title
        .and_then(|title| truncate_preserving_lines(&title, max_chars))
}

pub fn transcript_title_context(
    provider: AgentHistoryProvider,
    path: &Path,
    max_chars: usize,
) -> Option<String> {
    let snapshot = open_transcript_snapshot(path, TRANSCRIPT_SCAN_LIMITS)?;
    let mut builder = TitleContextBuilder::new(max_chars);
    let kind = provider.kind();
    scan_transcript_json_lines(snapshot, TRANSCRIPT_SCAN_LIMITS, |line| {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let parsed = parse_transcript_value(kind, &value);
        let Some(entry) = title_context_entry(&parsed) else {
            return;
        };
        builder.push(entry);
    })?;
    builder.finish()
}

fn summarize_agent_history_item(item: &AgentHistoryItem) -> Option<AgentTranscriptSummary> {
    summarize_agent_transcript(
        item.provider.clone(),
        item.id.clone(),
        Path::new(&item.transcript_path),
    )
}

fn summarize_agent_transcript(
    provider: AgentHistoryProvider,
    id: String,
    path: &Path,
) -> Option<AgentTranscriptSummary> {
    let snapshot = open_transcript_snapshot(path, TRANSCRIPT_SCAN_LIMITS)?;
    let len = snapshot.len;
    let modified = snapshot.modified;
    let cache_key = TranscriptSummaryCacheKey {
        provider: provider.clone(),
        id: id.clone(),
        path: path.to_path_buf(),
    };
    if let Some(summary) = cached_transcript_summary(&cache_key, len, modified) {
        return Some(summary);
    }

    let mut message_count = 0_u64;
    let mut user_messages = 0_u64;
    let mut assistant_messages = 0_u64;
    let mut summed_usage = AgentTranscriptTokenUsage::default();
    let mut cumulative_usage = AgentTranscriptTokenUsage::default();
    let mut recent_messages = VecDeque::new();
    let kind = provider.kind();

    scan_transcript_json_lines(snapshot, TRANSCRIPT_SCAN_LIMITS, |line| {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let parsed = parse_transcript_value(kind, &value);
        if let Some(entry) = title_context_entry(&parsed) {
            let role = match entry.role {
                "User" => {
                    user_messages += 1;
                    Some("user")
                }
                "Assistant" => {
                    assistant_messages += 1;
                    Some("assistant")
                }
                _ => None,
            };
            if let Some((role, text)) = role.and_then(|role| {
                collapse_preview(&entry.text, SUMMARY_MESSAGE_PREVIEW_CHARS)
                    .map(|text| (role, text))
            }) {
                if recent_messages.len() == RECENT_SUMMARY_MESSAGES {
                    recent_messages.pop_front();
                }
                recent_messages.push_back(AgentTranscriptMessagePreview {
                    role: role.to_string(),
                    text,
                });
            }
            message_count += 1;
        }
        if let Some(usage) = transcript_usage_from_value(&provider, &value) {
            if is_cumulative_usage_event(&provider, &value) {
                cumulative_usage = max_token_usage(std::mem::take(&mut cumulative_usage), usage);
            } else {
                add_token_usage(&mut summed_usage, usage);
            }
        }
    })?;

    let token_usage = if cumulative_usage.total_tokens > summed_usage.total_tokens {
        cumulative_usage
    } else {
        summed_usage
    };
    let complete_turns = user_messages.min(assistant_messages);
    let running_turns = user_messages.saturating_sub(assistant_messages);
    let summary = AgentTranscriptSummary {
        provider,
        id,
        transcript_path: path.display().to_string(),
        updated_at: updated_at_from_modified(modified),
        message_count,
        user_messages,
        assistant_messages,
        turn_count: user_messages,
        complete_turns,
        running_turns,
        recent_messages: recent_messages.into_iter().collect(),
        token_usage,
    };
    store_transcript_summary_cache(cache_key, len, modified, summary.clone());
    Some(summary)
}

fn open_transcript_snapshot(
    path: &Path,
    limits: TranscriptScanLimits,
) -> Option<TranscriptSnapshot> {
    let path_metadata = fs::symlink_metadata(path).ok()?;
    if !path_metadata.file_type().is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > limits.max_bytes {
        return None;
    }
    Some(TranscriptSnapshot {
        file,
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn scan_transcript_json_lines(
    snapshot: TranscriptSnapshot,
    limits: TranscriptScanLimits,
    mut visit: impl FnMut(&str),
) -> Option<()> {
    let mut reader = BufReader::new(snapshot.file.take(snapshot.len));
    let mut line = Vec::new();
    let mut line_count = 0_usize;
    loop {
        line.clear();
        let read_limit = limits.max_line_bytes.checked_add(1)?;
        let read = reader
            .by_ref()
            .take(read_limit as u64)
            .read_until(b'\n', &mut line)
            .ok()?;
        if read == 0 {
            return Some(());
        }
        if line.len() > limits.max_line_bytes || line_count >= limits.max_lines {
            return None;
        }
        line_count += 1;
        let text = std::str::from_utf8(&line).ok()?.trim();
        if text.starts_with('{') {
            visit(text);
        }
    }
}

fn cached_transcript_summary(
    key: &TranscriptSummaryCacheKey,
    len: u64,
    modified: Option<SystemTime>,
) -> Option<AgentTranscriptSummary> {
    let cache = transcript_summary_cache().lock().ok()?;
    let entry = cache.get(key)?;
    if entry.len == len && entry.modified == modified {
        Some(entry.summary.clone())
    } else {
        None
    }
}

fn store_transcript_summary_cache(
    key: TranscriptSummaryCacheKey,
    len: u64,
    modified: Option<SystemTime>,
    summary: AgentTranscriptSummary,
) {
    let Ok(mut cache) = transcript_summary_cache().lock() else {
        return;
    };
    if cache.len() >= TRANSCRIPT_SUMMARY_CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
        if let Some(evict) = cache.keys().next().cloned() {
            cache.remove(&evict);
        }
    }
    cache.insert(
        key,
        TranscriptSummaryCacheEntry {
            len,
            modified,
            summary,
        },
    );
}

fn updated_at_from_modified(modified: Option<SystemTime>) -> u64 {
    modified
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
fn clear_transcript_summary_cache_for_test() {
    if let Ok(mut cache) = transcript_summary_cache().lock() {
        cache.clear();
    }
}

#[cfg(test)]
fn cached_transcript_message_count_for_test(
    provider: AgentHistoryProvider,
    id: &str,
    path: &Path,
) -> Option<u64> {
    let key = TranscriptSummaryCacheKey {
        provider,
        id: id.to_string(),
        path: path.to_path_buf(),
    };
    transcript_summary_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).map(|entry| entry.summary.message_count))
}

fn transcript_usage_from_value(
    provider: &AgentHistoryProvider,
    value: &Value,
) -> Option<AgentTranscriptTokenUsage> {
    match provider {
        AgentHistoryProvider::Claude => value
            .get("usage")
            .or_else(|| {
                value
                    .get("message")
                    .and_then(|message| message.get("usage"))
            })
            .and_then(token_usage_from_object),
        AgentHistoryProvider::Codex => codex_usage_from_value(value),
        AgentHistoryProvider::Antigravity => generic_usage_from_value(value),
    }
}

fn codex_usage_from_value(value: &Value) -> Option<AgentTranscriptTokenUsage> {
    if let Some(event) = codex_token_count_event(value) {
        return event
            .get("info")
            .and_then(|info| info.get("total_token_usage").or(Some(info)))
            .and_then(token_usage_from_object);
    }
    generic_usage_from_value(value)
}

fn generic_usage_from_value(value: &Value) -> Option<AgentTranscriptTokenUsage> {
    for key in [
        "usage",
        "token_usage",
        "tokenUsage",
        "total_token_usage",
        "totalTokenUsage",
        "info",
    ] {
        if let Some(usage) = value.get(key).and_then(token_usage_from_object) {
            return Some(usage);
        }
    }
    for key in ["message", "payload", "response"] {
        if let Some(usage) = value.get(key).and_then(generic_usage_from_value) {
            return Some(usage);
        }
    }
    token_usage_from_object(value)
}

fn token_usage_from_object(value: &Value) -> Option<AgentTranscriptTokenUsage> {
    let input_tokens = first_u64(value, &["input_tokens", "inputTokens", "prompt_tokens"]);
    let output_tokens = first_u64(
        value,
        &["output_tokens", "outputTokens", "completion_tokens"],
    );
    let cache_read_tokens = first_u64(
        value,
        &[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cached_input_tokens",
            "cachedInputTokens",
            "cached_tokens",
        ],
    );
    let cache_creation_tokens = first_u64(
        value,
        &["cache_creation_input_tokens", "cacheCreationInputTokens"],
    );
    let reasoning_tokens = first_u64(
        value,
        &[
            "reasoning_output_tokens",
            "reasoningOutputTokens",
            "reasoning_tokens",
        ],
    );
    let explicit_total = first_u64(value, &["total_tokens", "totalTokens"]);
    let total_tokens = explicit_total.unwrap_or_else(|| {
        input_tokens.unwrap_or(0)
            + output_tokens.unwrap_or(0)
            + cache_read_tokens.unwrap_or(0)
            + cache_creation_tokens.unwrap_or(0)
    });
    if total_tokens == 0 && reasoning_tokens.unwrap_or(0) == 0 {
        return None;
    }
    Some(AgentTranscriptTokenUsage {
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
        cache_read_tokens: cache_read_tokens.unwrap_or(0),
        cache_creation_tokens: cache_creation_tokens.unwrap_or(0),
        reasoning_tokens: reasoning_tokens.unwrap_or(0),
        total_tokens,
        messages_with_usage: 1,
    })
}

fn first_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn is_cumulative_usage_event(provider: &AgentHistoryProvider, value: &Value) -> bool {
    provider == &AgentHistoryProvider::Codex && codex_token_count_event(value).is_some()
}

fn codex_token_count_event(value: &Value) -> Option<&Value> {
    if value.get("type").and_then(Value::as_str) == Some("token_count") {
        return Some(value);
    }
    for key in ["msg", "payload"] {
        if let Some(event) = value.get(key).and_then(codex_token_count_event) {
            return Some(event);
        }
    }
    None
}

fn add_token_usage(total: &mut AgentTranscriptTokenUsage, usage: AgentTranscriptTokenUsage) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_read_tokens += usage.cache_read_tokens;
    total.cache_creation_tokens += usage.cache_creation_tokens;
    total.reasoning_tokens += usage.reasoning_tokens;
    total.total_tokens += usage.total_tokens;
    total.messages_with_usage += usage.messages_with_usage;
}

fn max_token_usage(
    current: AgentTranscriptTokenUsage,
    candidate: AgentTranscriptTokenUsage,
) -> AgentTranscriptTokenUsage {
    if candidate.total_tokens > current.total_tokens {
        candidate
    } else {
        current
    }
}

fn parse_agent_state(kind: AgentKind, path: &Path) -> Option<ParsedAgentFile> {
    let file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    parse_agent_state_from_opened(kind, path, file, len)
}

fn parse_agent_state_from_opened(
    kind: AgentKind,
    path: &Path,
    file: fs::File,
    len: u64,
) -> Option<ParsedAgentFile> {
    let mut state = ParsedAgentFile {
        id: if kind == AgentKind::Antigravity {
            antigravity_id_from_path(path)
        } else {
            None
        },
        ..ParsedAgentFile::default()
    };
    for line in sample_lines_from_opened(file, len).ok()? {
        let value = if kind == AgentKind::Claude {
            serde_json::from_str::<Value>(&line).ok()
        } else {
            None
        };
        if let Some(value) = value.as_ref() {
            update_claude_recoverable_signals(&mut state, value);
        }
        let Some(parsed) = parse_transcript_line(kind, line.trim()) else {
            continue;
        };
        if state.id.is_none() {
            state.id = parsed.session_id.clone();
        }
        if state.cwd.is_none() {
            state.cwd = parsed.cwd.clone();
        }
        match parsed.state_role {
            TranscriptRole::User => {
                state.conversation_message_count += 1;
                if let Some(user_text) = parsed.state_text {
                    if looks_like_acorn_title_generation_prompt(&user_text) {
                        state.internal_title_generation = true;
                    }
                    if state.title.is_none() {
                        state.title = Some(user_text);
                    }
                }
            }
            TranscriptRole::Assistant => {
                state.conversation_message_count += 1;
                if let Some(text) = parsed.state_text {
                    state.preview = Some(text);
                }
            }
            TranscriptRole::Other => {}
        }
        if kind == AgentKind::Codex && state.preview.is_none() {
            state.preview = parsed.response_text;
        }
    }
    if kind == AgentKind::Claude && state.conversation_message_count == 0 {
        state.subagent_transcript_count = count_claude_subagent_transcripts(path)?;
    }

    Some(state)
}

fn update_claude_recoverable_signals(state: &mut ParsedAgentFile, value: &Value) {
    if value.get("type").and_then(Value::as_str) != Some("queue-operation") {
        return;
    }
    if state.id.is_none() {
        state.id = first_nonempty_string(value, &["sessionId", "session_id"]);
    }
    if state.cwd.is_none() {
        state.cwd = first_nonempty_string(value, &["cwd"]);
    }
    match value.get("operation").and_then(Value::as_str) {
        Some("enqueue") => {
            if value.get("content").is_some_and(has_recoverable_json_text) {
                state.queued_message_count += 1;
            }
        }
        Some("remove") | Some("dequeue") => {
            state.queued_message_count = state.queued_message_count.saturating_sub(1);
        }
        _ => {}
    }
}

fn first_nonempty_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(str::to_string)
}

fn has_recoverable_json_text(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items.iter().any(has_recoverable_json_text),
        Value::Object(map) => ["text", "content", "message", "prompt"]
            .iter()
            .filter_map(|key| map.get(*key))
            .any(has_recoverable_json_text),
        _ => false,
    }
}

fn count_claude_subagent_transcripts(path: &Path) -> Option<u64> {
    count_claude_subagent_transcripts_with_limit(path, MAX_DISCOVERY_ENTRIES_PER_PROVIDER)
}

fn count_claude_subagent_transcripts_with_limit(path: &Path, max_entries: usize) -> Option<u64> {
    let Some(dir) = claude_subagent_transcripts_dir(path) else {
        return Some(0);
    };
    let metadata = match fs::symlink_metadata(&dir) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Some(0),
        Err(_) => return None,
    };
    if !metadata.file_type().is_dir() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut scanned_entries = 0_usize;
    let mut transcripts = 0_u64;
    for entry in entries {
        if scanned_entries >= max_entries {
            return None;
        }
        scanned_entries += 1;
        let entry = entry.ok()?;
        if entry.file_type().ok()?.is_file()
            && entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("jsonl")
        {
            transcripts = transcripts.checked_add(1)?;
        }
    }
    Some(transcripts)
}

fn claude_subagent_transcripts_dir(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?.to_str()?;
    Some(path.parent()?.join(stem).join("subagents"))
}

struct TitleContextEntry {
    role: &'static str,
    text: String,
}

fn title_context_entry(parsed: &ParsedTranscriptLine) -> Option<TitleContextEntry> {
    parsed
        .role
        .title_label()
        .zip(parsed.text.clone())
        .map(|(role, text)| TitleContextEntry { role, text })
}

struct TitleContextBuilder {
    max_chars: usize,
    head_limit: usize,
    tail_limit: usize,
    head: String,
    head_chars: usize,
    tail: VecDeque<(String, usize)>,
    tail_chars: usize,
    omitted: bool,
    last_line: Option<String>,
}

impl TitleContextBuilder {
    fn new(max_chars: usize) -> Self {
        let max_chars = max_chars.max(1);
        let head_limit = (max_chars / 2).max(1);
        let tail_limit = (max_chars - head_limit).max(1);
        Self {
            max_chars,
            head_limit,
            tail_limit,
            head: String::new(),
            head_chars: 0,
            tail: VecDeque::new(),
            tail_chars: 0,
            omitted: false,
            last_line: None,
        }
    }

    fn push(&mut self, entry: TitleContextEntry) {
        let Some(text) = collapse_preview(&entry.text, TITLE_CONTEXT_ENTRY_CHARS) else {
            return;
        };
        let line = format!("{}: {}", entry.role, text);
        if self.last_line.as_deref() == Some(line.as_str()) {
            return;
        }
        self.last_line = Some(line.clone());
        let line_chars = line.chars().count() + usize::from(!self.head.is_empty());
        if !self.omitted && self.head_chars + line_chars <= self.head_limit {
            if !self.head.is_empty() {
                self.head.push('\n');
            }
            self.head.push_str(&line);
            self.head_chars += line_chars;
            return;
        }

        self.omitted = true;
        let tail_line_chars = line.chars().count() + 1;
        self.tail.push_back((line, tail_line_chars));
        self.tail_chars += tail_line_chars;
        while self.tail_chars > self.tail_limit {
            let Some((_, chars)) = self.tail.pop_front() else {
                break;
            };
            self.tail_chars = self.tail_chars.saturating_sub(chars);
        }
    }

    fn finish(self) -> Option<String> {
        if self.head.is_empty() && self.tail.is_empty() {
            return None;
        }
        let mut out = self.head;
        if self.omitted && !self.tail.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str("[...]\n");
            for (idx, (line, _)) in self.tail.into_iter().enumerate() {
                if idx > 0 {
                    out.push('\n');
                }
                out.push_str(&line);
            }
        }
        truncate_preserving_lines(&out, self.max_chars)
    }
}

#[derive(Default)]
struct ParsedAgentFile {
    id: Option<String>,
    title: Option<String>,
    preview: Option<String>,
    cwd: Option<String>,
    conversation_message_count: u64,
    queued_message_count: u64,
    subagent_transcript_count: u64,
    internal_title_generation: bool,
}

fn looks_like_acorn_title_generation_prompt(text: &str) -> bool {
    text.contains(crate::session_titles::INTERNAL_TITLE_PROMPT_MARKER)
        || (text.contains("Conversation transcript context:")
            && (text.contains("You are naming an Acorn session tab")
                || text.contains("Return only a concise title for the tab")
                || text.contains("Fewer than 30 characters.")))
}

fn sample_lines(path: &Path) -> std::io::Result<Vec<String>> {
    let file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    sample_lines_from_opened(file, len)
}

fn sample_lines_from_opened(mut file: fs::File, len: u64) -> std::io::Result<Vec<String>> {
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
        file.take(READ_TAIL_BYTES).read_to_end(&mut tail)?;
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

fn codex_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    uuid_suffix(stem)
}

fn codex_id_from_transcript(path: &Path) -> Option<String> {
    for line in sample_lines(path).ok()? {
        let Some(parsed) = parse_transcript_line(AgentKind::Codex, line.trim()) else {
            continue;
        };
        if parsed.session_id.is_some() {
            return parsed.session_id;
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
    let suffix = stem.get(stem.len().checked_sub(36)?..)?;
    Uuid::parse_str(suffix).ok().map(|_| suffix.to_string())
}

fn numeric_component(component: &std::ffi::OsStr, len: usize) -> bool {
    component
        .to_str()
        .map(|s| s.len() == len && s.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false)
}

fn truncate_preserving_lines(s: &str, max_chars: usize) -> Option<String> {
    let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed_lines = normalized
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = trimmed_lines.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = trimmed.chars().take(max_chars).collect::<String>();
    if trimmed.chars().count() > max_chars {
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
    for name in names.iter().filter_map(|name| name.ok().flatten()) {
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
    antigravity_brain_root_candidates()
        .into_iter()
        .filter(|path| path.is_dir())
        .collect()
}

fn antigravity_brain_root_candidates() -> Vec<PathBuf> {
    let Some(root) = google_agent_storage_root() else {
        return Vec::new();
    };
    ["antigravity", "antigravity-ide", "antigravity-cli"]
        .into_iter()
        .map(|profile| root.join(profile).join("brain"))
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

const MAX_AGENT_STATE_ENTRIES: usize = 10_000;

#[derive(Clone, Copy)]
struct AgentStateLookupLimits {
    max_entries: usize,
    max_cwd_bytes: usize,
}

const AGENT_STATE_LOOKUP_LIMITS: AgentStateLookupLimits = AgentStateLookupLimits {
    max_entries: MAX_AGENT_STATE_ENTRIES,
    max_cwd_bytes: crate::agent_resume::AGENT_CWD_MAX_BYTES,
};

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
    antigravity_cwds_from_agent_state_with_limits(data_dir, id, AGENT_STATE_LOOKUP_LIMITS)
}

fn antigravity_cwds_from_agent_state_with_limits(
    data_dir: &Path,
    id: &str,
    limits: AgentStateLookupLimits,
) -> Vec<AgentStateCwd> {
    let Ok(id) = crate::agent_resume::normalize_provider_id(id) else {
        return Vec::new();
    };
    let root = data_dir.join("agent-state");
    let Ok(root_metadata) = fs::symlink_metadata(&root) else {
        return Vec::new();
    };
    if !root_metadata.file_type().is_dir() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut scanned_entries = 0_usize;
    for entry in entries {
        if scanned_entries >= limits.max_entries {
            // Returning a subset would make a partial scan look authoritative.
            return Vec::new();
        }
        scanned_entries += 1;
        let Ok(entry) = entry else {
            return Vec::new();
        };
        let Ok(entry_type) = entry.file_type() else {
            return Vec::new();
        };
        if !entry_type.is_dir() {
            continue;
        }
        let dir = entry.path();
        let Ok(dir_metadata) = fs::symlink_metadata(&dir) else {
            return Vec::new();
        };
        if !dir_metadata.file_type().is_dir() {
            continue;
        }

        // These pathname checks reject stable links and special files. A parent
        // can still be swapped between checks and opens; RES-006 tracks the
        // dirfd/handle-relative redesign for that remaining TOCTOU window.
        let marker = match crate::agent_resume::read_provider_marker(&dir.join("antigravity.id")) {
            Ok(Some(marker)) => marker,
            Ok(None) => continue,
            Err(_) => return Vec::new(),
        };
        if marker.text != id {
            continue;
        }
        let cwd_snapshot = match crate::agent_resume::read_state_text_with_limit(
            &dir.join("antigravity.cwd"),
            limits.max_cwd_bytes,
        ) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => continue,
            Err(_) => return Vec::new(),
        };
        let cwd = cwd_snapshot.text.trim().to_string();
        if cwd.is_empty() {
            continue;
        }
        let updated_at = [marker.modified, cwd_snapshot.modified]
            .into_iter()
            .flatten()
            .filter_map(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .max()
            .unwrap_or(0);
        out.push(AgentStateCwd { cwd, updated_at });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out.dedup_by(|a, b| a.cwd == b.cwd);
    out
}

fn home_dir() -> Option<PathBuf> {
    directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::io::Write;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: This test module serializes environment mutation through
            // ENV_LOCK and restores the previous value on drop.
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            // SAFETY: The guard is only created while ENV_LOCK is held, so the
            // matching restore runs under the same serialized test section.
            unsafe {
                if let Some(previous) = &self.previous {
                    std::env::set_var(self.key, previous);
                } else {
                    std::env::remove_var(self.key);
                }
            }
        }
    }

    fn write_antigravity_history_transcript(storage_root: &Path, id: &str, cwd: &Path) -> PathBuf {
        let transcript = storage_root
            .join("antigravity/brain")
            .join(id)
            .join(".system_generated/logs/transcript.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "USER_INPUT",
                "status": "DONE",
                "workspacePaths": [cwd.display().to_string()],
                "content": "<USER_REQUEST>Secure direct history lookup</USER_REQUEST>",
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "content": "Opened snapshot parsed.",
            })
        )
        .unwrap();
        transcript
    }

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
    fn codex_id_from_filename_rejects_non_ascii_boundary_without_panicking() {
        let path = Path::new("가aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee.jsonl");

        assert_eq!(codex_id_from_filename(path), None);
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
    fn antigravity_direct_history_lookup_parses_secure_opened_snapshot() {
        let storage = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let repo_path = repo.path().canonicalize().unwrap();
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let transcript = write_antigravity_history_transcript(storage.path(), id, &repo_path);

        let mut snapshots =
            crate::agent_resume::open_antigravity_transcript_snapshots_at(storage.path(), id);
        assert_eq!(snapshots.len(), 1, "secure exact locator must open fixture");
        assert!(
            parse_antigravity_snapshot(snapshots.pop().unwrap(), HistoryScope::Project(&repo_path))
                .is_some(),
            "opened fixture must parse inside project scope"
        );

        let item = find_antigravity_history_item_by_path_id_at(
            HistoryScope::Project(&repo_path),
            "17F38E8C-3A7E-408B-8C79-AEF7432C0FD2",
            storage.path(),
        )
        .unwrap();

        assert_eq!(item.id, id);
        assert_eq!(
            item.transcript_path,
            transcript.canonicalize().unwrap().display().to_string()
        );
        assert_eq!(item.title, "Secure direct history lookup");
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_direct_history_lookup_rejects_symlinked_root_component_and_leaf() {
        use std::os::unix::fs::symlink;

        let repo = tempfile::tempdir().unwrap();
        let repo_path = repo.path().canonicalize().unwrap();
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let outside = tempfile::tempdir().unwrap();
        let sentinel = write_antigravity_history_transcript(outside.path(), id, &repo_path);

        let linked_root = tempfile::tempdir().unwrap();
        let profile = linked_root.path().join("antigravity");
        fs::create_dir(&profile).unwrap();
        symlink(
            outside.path().join("antigravity/brain"),
            profile.join("brain"),
        )
        .unwrap();
        assert!(find_antigravity_history_item_by_path_id_at(
            HistoryScope::Project(&repo_path),
            id,
            linked_root.path(),
        )
        .is_none());

        let linked_session = tempfile::tempdir().unwrap();
        let brain = linked_session.path().join("antigravity/brain");
        fs::create_dir_all(&brain).unwrap();
        symlink(
            outside.path().join("antigravity/brain").join(id),
            brain.join(id),
        )
        .unwrap();
        assert!(find_antigravity_history_item_by_path_id_at(
            HistoryScope::Project(&repo_path),
            id,
            linked_session.path(),
        )
        .is_none());

        let linked_leaf = tempfile::tempdir().unwrap();
        let leaf = linked_leaf
            .path()
            .join("antigravity/brain")
            .join(id)
            .join(".system_generated/logs/transcript.jsonl");
        fs::create_dir_all(leaf.parent().unwrap()).unwrap();
        symlink(&sentinel, &leaf).unwrap();
        assert!(find_antigravity_history_item_by_path_id_at(
            HistoryScope::Project(&repo_path),
            id,
            linked_leaf.path(),
        )
        .is_none());
        assert!(sentinel.is_file());
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
    fn codex_history_infers_roles_from_event_types() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let transcript = dir
            .path()
            .join(format!("rollout-2026-06-09T00-00-00-{id}.jsonl"));
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp": "t",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "id": id,
                    "cwd": repo.display().to_string(),
                    "message": "Review transcript parsing",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "timestamp": "t",
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "final_answer",
                    "message": "Parsed provider events.",
                },
            })
        )
        .unwrap();
        drop(file);

        let scope_repo = normalize_path(&repo);
        let item = parse_codex_file(&transcript, HistoryScope::Project(&scope_repo)).unwrap();
        assert_eq!(item.id, id);
        assert_eq!(item.title, "Review transcript parsing");
        assert_eq!(item.preview.as_deref(), Some("Parsed provider events."));

        let summary =
            summarize_agent_transcript(AgentHistoryProvider::Codex, id.to_string(), &transcript)
                .unwrap();
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.user_messages, 1);
        assert_eq!(summary.assistant_messages, 1);
        assert_eq!(summary.complete_turns, 1);
        assert_eq!(
            summary
                .recent_messages
                .iter()
                .map(|message| (message.role.as_str(), message.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "Review transcript parsing"),
                ("assistant", "Parsed provider events."),
            ]
        );
    }

    #[test]
    fn codex_history_uses_real_request_after_hidden_message_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let transcript = dir
            .path()
            .join(format!("rollout-2026-07-15T00-00-00-{id}.jsonl"));
        let mut file = fs::File::create(&transcript).unwrap();

        for value in [
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": repo.display().to_string(),
                },
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": "<codex_internal_context source=\"goal\">\nContinue the active goal.\n</codex_internal_context>",
                    }],
                },
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": "<image name=[Image #1] path=\"/tmp/clipboard.png\">\n</image>\nShip the release",
                    }],
                },
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Ship the release",
                },
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "final_answer",
                    "message": "The release is published.",
                },
            }),
        ] {
            writeln!(file, "{value}").unwrap();
        }
        drop(file);

        let scope_repo = normalize_path(&repo);
        let item = parse_codex_file(&transcript, HistoryScope::Project(&scope_repo)).unwrap();
        assert_eq!(item.title, "Ship the release");
        assert_eq!(item.preview.as_deref(), Some("The release is published."));

        let summary =
            summarize_agent_transcript(AgentHistoryProvider::Codex, id.to_string(), &transcript)
                .unwrap();
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.user_messages, 1);
        assert_eq!(summary.assistant_messages, 1);
        assert_eq!(summary.turn_count, 1);
        assert_eq!(
            summary
                .recent_messages
                .iter()
                .map(|message| (message.role.as_str(), message.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "Ship the release"),
                ("assistant", "The release is published."),
            ]
        );
    }

    #[test]
    fn codex_history_skips_marked_acorn_title_generation_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let transcript = dir
            .path()
            .join("rollout-2026-06-08T00-00-00-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "id": "019e4818-7c15-7e60-9b3b-898a1c7803d6",
                    "cwd": repo.display().to_string(),
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": crate::session_titles::build_prompt(None, "User: Fix release workflow"),
                        },
                    ],
                },
            })
        )
        .unwrap();
        drop(file);

        assert!(
            parse_codex_file(&transcript, HistoryScope::Project(&repo)).is_none(),
            "Acorn-generated title prompts should not appear as History rows"
        );
    }

    #[test]
    fn claude_history_skips_unmarked_acorn_title_generation_prompt() {
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
                "message": {
                    "role": "user",
                    "content": "\
            You are naming an Acorn session tab from the conversation transcript.\n\
            \n\
            Return only a concise title for the tab.\n\
            Conversation transcript context:\n\
            User: Fix release workflow\n",
                },
            })
        )
        .unwrap();
        drop(file);

        assert!(
            parse_claude_file(&transcript, HistoryScope::Project(&repo)).is_none(),
            "unmarked title prompts should be hidden"
        );
    }

    #[test]
    fn antigravity_history_skips_marked_acorn_title_generation_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let transcript = dir
            .path()
            .join("17f38e8c-3a7e-408b-8c79-aef7432c0fd2/.system_generated/logs/transcript.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let prompt = crate::session_titles::build_prompt(
            Some("Name this tab in Korean. Return only the title."),
            "User: Fix release workflow",
        );
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "USER_INPUT",
                "status": "DONE",
                "workspacePaths": [repo.display().to_string()],
                "content": format!("<USER_REQUEST>\n{prompt}\n</USER_REQUEST>"),
            })
        )
        .unwrap();
        drop(file);

        assert!(
            parse_antigravity_file(&transcript, HistoryScope::Project(&repo)).is_none(),
            "Antigravity title prompts should not appear as History rows"
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
    fn antigravity_agent_state_lookup_discards_partial_results_over_raw_entry_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("agent-state");
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        for (session, cwd) in [("session-1", "/tmp/one"), ("session-2", "/tmp/two")] {
            let state_dir = root.join(session);
            fs::create_dir_all(&state_dir).unwrap();
            fs::write(state_dir.join("antigravity.id"), format!("{id}\n")).unwrap();
            fs::write(state_dir.join("antigravity.cwd"), format!("{cwd}\n")).unwrap();
        }
        let limits = AgentStateLookupLimits {
            max_entries: 2,
            max_cwd_bytes: crate::agent_resume::AGENT_CWD_MAX_BYTES,
        };
        assert_eq!(
            antigravity_cwds_from_agent_state_with_limits(dir.path(), id, limits).len(),
            2,
            "the exact raw-entry budget must remain usable"
        );

        fs::write(root.join("unrelated"), "raw entry").unwrap();
        assert!(antigravity_cwds_from_agent_state_with_limits(dir.path(), id, limits).is_empty());
    }

    #[test]
    fn antigravity_agent_state_lookup_discards_partial_results_on_state_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("agent-state");
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let valid = root.join("valid");
        let broken = root.join("broken");
        fs::create_dir_all(&valid).unwrap();
        fs::create_dir_all(&broken).unwrap();
        fs::write(valid.join("antigravity.id"), format!("{id}\n")).unwrap();
        fs::write(valid.join("antigravity.cwd"), "/tmp/valid\n").unwrap();
        fs::write(
            broken.join("antigravity.id"),
            "x".repeat(crate::agent_resume::PROVIDER_MARKER_MAX_BYTES + 1),
        )
        .unwrap();
        fs::write(broken.join("antigravity.cwd"), "/tmp/broken\n").unwrap();
        let limits = AgentStateLookupLimits {
            max_entries: 2,
            max_cwd_bytes: crate::agent_resume::AGENT_CWD_MAX_BYTES,
        };

        assert!(
            antigravity_cwds_from_agent_state_with_limits(dir.path(), id, limits).is_empty(),
            "a marker read error must discard an already collected cwd"
        );

        fs::write(broken.join("antigravity.id"), format!("{id}\n")).unwrap();
        fs::write(
            broken.join("antigravity.cwd"),
            "x".repeat(crate::agent_resume::AGENT_CWD_MAX_BYTES + 1),
        )
        .unwrap();
        assert!(
            antigravity_cwds_from_agent_state_with_limits(dir.path(), id, limits).is_empty(),
            "a cwd read error must discard an already collected cwd"
        );

        fs::remove_file(broken.join("antigravity.cwd")).unwrap();
        let entries = antigravity_cwds_from_agent_state_with_limits(dir.path(), id, limits);
        assert_eq!(entries.len(), 1, "a missing cwd leaf remains skippable");
        assert_eq!(entries[0].cwd, "/tmp/valid");
    }

    #[test]
    fn antigravity_agent_state_lookup_enforces_injected_cwd_limit_and_valid_id() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("agent-state/session-1");
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let cwd = "/x\n";
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(state_dir.join("antigravity.id"), format!("{id}\n")).unwrap();
        fs::write(state_dir.join("antigravity.cwd"), cwd).unwrap();

        let exact = AgentStateLookupLimits {
            max_entries: 1,
            max_cwd_bytes: cwd.len(),
        };
        assert_eq!(
            antigravity_cwds_from_agent_state_with_limits(dir.path(), id, exact)[0].cwd,
            "/x"
        );
        let over = AgentStateLookupLimits {
            max_cwd_bytes: cwd.len() - 1,
            ..exact
        };
        assert!(antigravity_cwds_from_agent_state_with_limits(dir.path(), id, over).is_empty());

        for invalid in [
            "not-a-uuid",
            "../17f38e8c-3a7e-408b-8c79-aef7432c0fd2",
            "/tmp/17f38e8c-3a7e-408b-8c79-aef7432c0fd2",
        ] {
            assert!(
                antigravity_cwds_from_agent_state_with_limits(dir.path(), invalid, exact)
                    .is_empty()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_agent_state_lookup_rejects_symlinked_dirs_and_leaves() {
        use std::os::unix::fs::symlink;

        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let outside = tempfile::tempdir().unwrap();
        let outside_state = outside.path().join("session");
        fs::create_dir(&outside_state).unwrap();
        fs::write(outside_state.join("antigravity.id"), format!("{id}\n")).unwrap();
        fs::write(outside_state.join("antigravity.cwd"), "/tmp/outside\n").unwrap();

        let linked_root = tempfile::tempdir().unwrap();
        symlink(outside.path(), linked_root.path().join("agent-state")).unwrap();
        assert!(antigravity_cwds_from_agent_state_at(linked_root.path(), id).is_empty());

        let linked_session = tempfile::tempdir().unwrap();
        let root = linked_session.path().join("agent-state");
        fs::create_dir(&root).unwrap();
        symlink(&outside_state, root.join("session")).unwrap();
        assert!(antigravity_cwds_from_agent_state_at(linked_session.path(), id).is_empty());

        let linked_leaf = tempfile::tempdir().unwrap();
        let state_dir = linked_leaf.path().join("agent-state/session");
        fs::create_dir_all(&state_dir).unwrap();
        let id_sentinel = linked_leaf.path().join("id-sentinel");
        let cwd_sentinel = linked_leaf.path().join("cwd-sentinel");
        fs::write(&id_sentinel, format!("{id}\n")).unwrap();
        fs::write(&cwd_sentinel, "/tmp/sentinel\n").unwrap();
        symlink(&id_sentinel, state_dir.join("antigravity.id")).unwrap();
        fs::write(state_dir.join("antigravity.cwd"), "/tmp/local\n").unwrap();
        assert!(antigravity_cwds_from_agent_state_at(linked_leaf.path(), id).is_empty());

        fs::remove_file(state_dir.join("antigravity.id")).unwrap();
        fs::write(state_dir.join("antigravity.id"), format!("{id}\n")).unwrap();
        fs::remove_file(state_dir.join("antigravity.cwd")).unwrap();
        symlink(&cwd_sentinel, state_dir.join("antigravity.cwd")).unwrap();
        assert!(antigravity_cwds_from_agent_state_at(linked_leaf.path(), id).is_empty());
        assert_eq!(fs::read_to_string(&id_sentinel).unwrap(), format!("{id}\n"));
        assert_eq!(
            fs::read_to_string(&cwd_sentinel).unwrap(),
            "/tmp/sentinel\n"
        );
    }

    #[test]
    fn parse_file_budget_scales_with_requested_limit() {
        assert_eq!(parse_file_budget(0), 0);
        assert_eq!(parse_file_budget(1), MIN_PARSED_FILES_PER_PROVIDER);
        assert_eq!(parse_file_budget(100), 500);
        assert_eq!(parse_file_budget(MAX_LIMIT), MAX_PARSED_FILES_PER_PROVIDER);
    }

    #[test]
    fn parse_recent_files_stops_after_requested_items() {
        let paths = fake_paths(100);
        let mut attempted = 0;

        let items = parse_recent_files(paths, 3, |_| {
            attempted += 1;
            Some(attempted)
        });

        assert_eq!(items, vec![1, 2, 3]);
        assert_eq!(attempted, 3);
    }

    #[test]
    fn parse_recent_files_stops_at_budget_when_candidates_do_not_match() {
        let paths = fake_paths(100);
        let mut attempted = 0;

        let items: Vec<()> = parse_recent_files(paths, 2, |_| {
            attempted += 1;
            None
        });

        assert!(items.is_empty());
        assert_eq!(attempted, parse_file_budget(2));
    }

    #[test]
    fn collect_files_respects_max_dir_depth() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let slug = root.join("-Users-tester-demo");
        let parent = slug.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        let nested = slug
            .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
            .join("subagents")
            .join("bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&parent, "{}\n").unwrap();
        fs::write(&nested, "{}\n").unwrap();

        let files = collect_files(root, 1, |path| {
            path.extension().and_then(|s| s.to_str()) == Some("jsonl")
        });

        assert_eq!(files, vec![parent]);
    }

    #[test]
    fn collect_files_discards_traversal_that_exceeds_entry_budget() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jsonl"), "{}\n").unwrap();
        fs::write(dir.path().join("b.jsonl"), "{}\n").unwrap();
        let accepts_jsonl = |path: &Path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
        };

        assert_eq!(
            collect_files_with_entry_limit(dir.path(), 0, accepts_jsonl, 2).len(),
            2,
            "the exact raw-entry budget must remain usable"
        );
        assert!(
            collect_files_with_entry_limit(dir.path(), 0, accepts_jsonl, 1).is_empty(),
            "an incomplete traversal must not return a plausible partial history"
        );
    }

    #[test]
    fn collect_files_shares_exact_entry_budget_across_provider_roots() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("a.jsonl"), "{}\n").unwrap();
        fs::write(second.join("b.jsonl"), "{}\n").unwrap();
        let roots = vec![first, second.clone()];
        let accepts_jsonl = |path: &Path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
        };

        assert_eq!(
            collect_files_across_roots_with_entry_limit(&roots, 0, accepts_jsonl, 2).len(),
            2,
            "the exact shared budget must remain usable"
        );
        fs::write(second.join("c.jsonl"), "{}\n").unwrap();
        assert!(
            collect_files_across_roots_with_entry_limit(&roots, 0, accepts_jsonl, 2).is_empty(),
            "overflow in a later root must discard earlier-root results"
        );
    }

    #[cfg(unix)]
    #[test]
    fn collect_files_discards_partial_traversal_after_nested_read_error() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let accepted = dir.path().join("accepted.jsonl");
        let unreadable = dir.path().join("unreadable");
        fs::write(&accepted, "{}\n").unwrap();
        fs::create_dir(&unreadable).unwrap();
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&unreadable).is_ok() {
            fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700)).unwrap();
            return;
        }

        let files = collect_files_with_entry_limit(
            dir.path(),
            1,
            |path| path.extension().and_then(|extension| extension.to_str()) == Some("jsonl"),
            10,
        );
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(
            files.is_empty(),
            "a traversal error must discard already collected history"
        );
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
    fn claude_history_surfaces_recoverable_empty_signals() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = normalize_path(&repo);
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let transcript = dir.path().join(format!("{id}.jsonl"));
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "queue-operation",
                "operation": "enqueue",
                "sessionId": id,
                "cwd": repo.display().to_string(),
                "content": "Ask a subagent to inspect failing tests",
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "queue-operation",
                "operation": "enqueue",
                "sessionId": id,
                "cwd": repo.display().to_string(),
                "content": "   ",
            })
        )
        .unwrap();
        drop(file);

        let subagents = dir.path().join(id).join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(subagents.join("child.jsonl"), "{}\n").unwrap();
        fs::write(subagents.join("child.meta.json"), "{}\n").unwrap();

        let item = parse_claude_file(&transcript, HistoryScope::Project(&repo)).unwrap();

        assert_eq!(item.id, id);
        assert_eq!(item.title, "Claude session");
        assert_eq!(item.preview, None);
        assert_eq!(item.queued_message_count, 1);
        assert_eq!(item.subagent_transcript_count, 1);
        assert_eq!(item.cwd.as_deref(), Some(repo.to_str().unwrap()));
    }

    #[test]
    fn claude_subagent_count_discards_directory_over_entry_budget() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        fs::write(&transcript, "{}\n").unwrap();
        let subagents = dir
            .path()
            .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(subagents.join("a.jsonl"), "{}\n").unwrap();
        fs::write(subagents.join("b.jsonl"), "{}\n").unwrap();

        assert_eq!(
            count_claude_subagent_transcripts_with_limit(&transcript, 2),
            Some(2)
        );
        assert_eq!(
            count_claude_subagent_transcripts_with_limit(&transcript, 1),
            None,
            "a partial child count must not be surfaced as complete"
        );
    }

    #[test]
    fn claude_history_skips_empty_queue_after_dequeue() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = normalize_path(&repo);
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let transcript = dir.path().join(format!("{id}.jsonl"));
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "queue-operation",
                "operation": "enqueue",
                "sessionId": id,
                "cwd": repo.display().to_string(),
                "content": { "text": "Draft a follow-up" },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "queue-operation",
                "operation": "dequeue",
                "sessionId": id,
                "cwd": repo.display().to_string(),
            })
        )
        .unwrap();
        drop(file);

        assert!(parse_claude_file(&transcript, HistoryScope::Project(&repo)).is_none());
    }

    #[test]
    fn claude_history_does_not_count_subagents_for_conversation_transcripts() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = normalize_path(&repo);
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let transcript = dir.path().join(format!("{id}.jsonl"));
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "user",
                "sessionId": id,
                "cwd": repo.display().to_string(),
                "message": {
                    "role": "user",
                    "content": "Summarize this project",
                },
            })
        )
        .unwrap();
        drop(file);

        let subagents = dir.path().join(id).join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(subagents.join("child.jsonl"), "{}\n").unwrap();

        let item = parse_claude_file(&transcript, HistoryScope::Project(&repo)).unwrap();

        assert_eq!(item.title, "Summarize this project");
        assert_eq!(item.queued_message_count, 0);
        assert_eq!(item.subagent_transcript_count, 0);
    }

    #[test]
    fn transcript_first_user_message_preserves_first_request_structure() {
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

        assert_eq!(title, "Please inspect\n\n  the failing re…");
    }

    #[test]
    fn transcript_first_user_message_joins_first_request_text_blocks() {
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
                    "content": [
                        {
                            "type": "text",
                            "text": "Create docs for html-in-canvas",
                        },
                        {
                            "type": "text",
                            "text": "Then build a gallery service around those examples.",
                        },
                    ],
                },
            })
        )
        .unwrap();
        drop(file);

        let title =
            transcript_first_user_message(AgentHistoryProvider::Claude, &transcript, 200).unwrap();

        assert_eq!(
            title,
            "Create docs for html-in-canvas\n\nThen build a gallery service around those examples."
        );
    }

    #[test]
    fn transcript_first_user_message_deduplicates_codex_payload_text() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("rollout-2026-05-21T10-13-44-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "id": "019e4818-7c15-7e60-9b3b-898a1c7803d6",
                    "cwd": "/tmp/demo",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "Document html-in-canvas",
                        },
                    ],
                },
            })
        )
        .unwrap();
        drop(file);

        let title =
            transcript_first_user_message(AgentHistoryProvider::Codex, &transcript, 200).unwrap();

        assert_eq!(title, "Document html-in-canvas");
    }

    #[test]
    fn transcript_first_user_message_reads_antigravity_user_request() {
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
                "content": "<USER_REQUEST>\nCheck whether Antigravity tab rename can miss transcripts\n</USER_REQUEST>",
            })
        )
        .unwrap();
        drop(file);

        let title =
            transcript_first_user_message(AgentHistoryProvider::Antigravity, &transcript, 200)
                .unwrap();

        assert_eq!(
            title,
            "Check whether Antigravity tab rename can miss transcripts"
        );
    }

    #[test]
    fn transcript_title_context_includes_later_claude_turns() {
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
                    "content": "Investigate the failing release workflow",
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
                    "content": "The release job is failing before sidecar staging.",
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
                    "content": "Use the final diagnosis to regenerate the tab name.",
                },
            })
        )
        .unwrap();
        drop(file);

        let context =
            transcript_title_context(AgentHistoryProvider::Claude, &transcript, 1_000).unwrap();

        assert!(context.contains("User: Investigate the failing release workflow"));
        assert!(context.contains("Assistant: The release job is failing"));
        assert!(context.contains("User: Use the final diagnosis"));
    }

    #[test]
    fn transcript_title_context_keeps_tail_when_budget_is_exceeded() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        for idx in 0..20 {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": format!("Turn {idx}: investigate release workflow detail {idx}"),
                    },
                })
            )
            .unwrap();
        }
        drop(file);

        let context =
            transcript_title_context(AgentHistoryProvider::Claude, &transcript, 260).unwrap();

        assert!(context.contains("Turn 0"));
        assert!(context.contains("[...]"));
        assert!(context.contains("Turn 19"));
    }

    #[test]
    fn transcript_jsonl_scan_enforces_file_line_and_line_count_budgets() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("transcript.jsonl");
        let line = b"{\"ok\":true}\n";
        fs::write(&transcript, line).unwrap();

        let exact = TranscriptScanLimits {
            max_bytes: line.len() as u64,
            max_lines: 1,
            max_line_bytes: line.len(),
        };
        let mut visited = 0;
        let snapshot = open_transcript_snapshot(&transcript, exact).unwrap();
        assert_eq!(
            scan_transcript_json_lines(snapshot, exact, |_| visited += 1),
            Some(())
        );
        assert_eq!(visited, 1);

        let file_too_large = TranscriptScanLimits {
            max_bytes: line.len() as u64 - 1,
            ..exact
        };
        assert!(open_transcript_snapshot(&transcript, file_too_large).is_none());

        let line_too_large = TranscriptScanLimits {
            max_line_bytes: line.len() - 1,
            ..exact
        };
        let snapshot = open_transcript_snapshot(&transcript, line_too_large).unwrap();
        assert!(scan_transcript_json_lines(snapshot, line_too_large, |_| {}).is_none());

        fs::write(&transcript, [line.as_slice(), line.as_slice()].concat()).unwrap();
        let too_many_lines = TranscriptScanLimits {
            max_bytes: (line.len() * 2) as u64,
            max_lines: 1,
            max_line_bytes: line.len(),
        };
        let snapshot = open_transcript_snapshot(&transcript, too_many_lines).unwrap();
        assert!(scan_transcript_json_lines(snapshot, too_many_lines, |_| {}).is_none());
    }

    #[test]
    fn transcript_summary_counts_messages_and_uses_codex_cumulative_token_count() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("rollout-2026-05-21T10-13-44-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "id": "019e4818-7c15-7e60-9b3b-898a1c7803d6",
                    "cwd": "/tmp/demo",
                    "role": "user",
                    "content": "Do it",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "role": "assistant",
                    "content": "Done",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "msg": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 20,
                            "cached_input_tokens": 7,
                            "output_tokens": 5,
                            "reasoning_output_tokens": 2,
                            "total_tokens": 32,
                        },
                    },
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "msg": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 40,
                            "cached_input_tokens": 9,
                            "output_tokens": 10,
                            "reasoning_output_tokens": 4,
                            "total_tokens": 59,
                        },
                    },
                },
            })
        )
        .unwrap();
        drop(file);

        let item = AgentHistoryItem {
            provider: AgentHistoryProvider::Codex,
            id: "019e4818-7c15-7e60-9b3b-898a1c7803d6".to_string(),
            title: "Do it".to_string(),
            preview: Some("Done".to_string()),
            queued_message_count: 0,
            subagent_transcript_count: 0,
            cwd: Some("/tmp/demo".to_string()),
            worktree: None,
            transcript_path: transcript.display().to_string(),
            updated_at: 1_766_000_000,
            resume_command: None,
        };

        let summary = summarize_agent_history_item(&item).unwrap();

        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.user_messages, 1);
        assert_eq!(summary.assistant_messages, 1);
        assert_eq!(summary.complete_turns, 1);
        assert_eq!(summary.token_usage.input_tokens, 40);
        assert_eq!(summary.token_usage.cache_read_tokens, 9);
        assert_eq!(summary.token_usage.output_tokens, 10);
        assert_eq!(summary.token_usage.reasoning_tokens, 4);
        assert_eq!(summary.token_usage.total_tokens, 59);
        assert_eq!(summary.token_usage.messages_with_usage, 1);
        assert_eq!(summary.recent_messages.len(), 2);
        assert_eq!(summary.recent_messages[0].role, "user");
        assert_eq!(summary.recent_messages[0].text, "Do it");
        assert_eq!(summary.recent_messages[1].role, "assistant");
        assert_eq!(summary.recent_messages[1].text, "Done");
    }

    #[test]
    fn transcript_summary_cache_reuses_unchanged_file_and_invalidates_on_append() {
        clear_transcript_summary_cache_for_test();
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("rollout-2026-05-21T10-13-44-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl");
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        fs::write(
            &transcript,
            format!(
                "{}\n",
                serde_json::json!({
                    "payload": {
                        "id": id,
                        "role": "user",
                        "content": "Check transcript cache",
                    },
                })
            ),
        )
        .unwrap();

        let first =
            summarize_agent_transcript(AgentHistoryProvider::Codex, id.to_string(), &transcript)
                .unwrap();
        let second =
            summarize_agent_transcript(AgentHistoryProvider::Codex, id.to_string(), &transcript)
                .unwrap();

        assert_eq!(first, second);
        assert_eq!(first.message_count, 1);
        assert_eq!(
            cached_transcript_message_count_for_test(AgentHistoryProvider::Codex, id, &transcript),
            Some(1)
        );

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "role": "assistant",
                    "content": "Cache invalidated.",
                },
            })
        )
        .unwrap();
        drop(file);

        let updated =
            summarize_agent_transcript(AgentHistoryProvider::Codex, id.to_string(), &transcript)
                .unwrap();

        assert_eq!(updated.message_count, 2);
        assert_eq!(updated.assistant_messages, 1);
        assert_eq!(
            updated
                .recent_messages
                .last()
                .map(|message| message.text.as_str()),
            Some("Cache invalidated.")
        );
        assert_eq!(
            cached_transcript_message_count_for_test(AgentHistoryProvider::Codex, id, &transcript),
            Some(2)
        );
    }

    #[test]
    fn transcript_summary_keeps_only_most_recent_messages() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir
            .path()
            .join("rollout-2026-05-21T10-13-44-019e4818-7c15-7e60-9b3b-898a1c7803d6.jsonl");
        let mut file = fs::File::create(&transcript).unwrap();
        for index in 0..8 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "payload": {
                        "role": role,
                        "content": format!("message {index}"),
                    },
                })
            )
            .unwrap();
        }
        drop(file);

        let item = AgentHistoryItem {
            provider: AgentHistoryProvider::Codex,
            id: "019e4818-7c15-7e60-9b3b-898a1c7803d6".to_string(),
            title: "message 0".to_string(),
            preview: Some("message 7".to_string()),
            queued_message_count: 0,
            subagent_transcript_count: 0,
            cwd: Some("/tmp/demo".to_string()),
            worktree: None,
            transcript_path: transcript.display().to_string(),
            updated_at: 1_766_000_000,
            resume_command: None,
        };

        let summary = summarize_agent_history_item(&item).unwrap();

        assert_eq!(summary.message_count, 8);
        assert_eq!(summary.recent_messages.len(), RECENT_SUMMARY_MESSAGES);
        assert_eq!(
            summary
                .recent_messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            vec![
                "message 2",
                "message 3",
                "message 4",
                "message 5",
                "message 6",
                "message 7",
            ]
        );
        assert_eq!(summary.recent_messages[0].role, "user");
        assert_eq!(summary.recent_messages[5].role, "assistant");
    }

    #[test]
    fn transcript_summary_at_path_reads_validated_codex_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let codex_home = dir.path().join("codex-home");
        let id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let transcript = codex_home
            .join("sessions/2026/05/21")
            .join(format!("rollout-2026-05-21T10-13-44-{id}.jsonl"));
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "id": id,
                    "cwd": repo.display().to_string(),
                    "role": "user",
                    "content": "Do it",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "role": "assistant",
                    "content": "Done",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "msg": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 20,
                            "cached_input_tokens": 7,
                            "output_tokens": 5,
                            "total_tokens": 32,
                        },
                    },
                },
            })
        )
        .unwrap();
        drop(file);
        let _env = EnvVarGuard::set("CODEX_HOME", &codex_home);

        let summary = agent_transcript_summary_at_path(
            repo,
            AgentHistoryProvider::Codex,
            id.to_string(),
            transcript.clone(),
        )
        .unwrap()
        .unwrap();

        assert_eq!(summary.provider, AgentHistoryProvider::Codex);
        assert_eq!(summary.id, id);
        assert_eq!(
            summary.transcript_path,
            transcript.canonicalize().unwrap().display().to_string()
        );
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.token_usage.total_tokens, 32);
    }

    #[test]
    fn transcript_summary_finds_codex_transcript_outside_default_history_limit() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let codex_home = dir.path().join("codex-home");
        let sessions_day = codex_home.join("sessions/2026/05/21");
        fs::create_dir_all(&sessions_day).unwrap();
        let _home_env = EnvVarGuard::set("HOME", dir.path());
        let _codex_env = EnvVarGuard::set("CODEX_HOME", &codex_home);

        fn write_codex_transcript(path: &Path, id: &str, repo: &Path, user: &str, assistant: &str) {
            let mut file = fs::File::create(path).unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "payload": {
                        "id": id,
                        "cwd": repo.display().to_string(),
                        "role": "user",
                        "content": user,
                    },
                })
            )
            .unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "payload": {
                        "role": "assistant",
                        "content": assistant,
                    },
                })
            )
            .unwrap();
        }

        let target_id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let target = sessions_day.join(format!("rollout-2026-05-21T10-13-44-{target_id}.jsonl"));
        write_codex_transcript(
            &target,
            target_id,
            &repo,
            "Summarize the older release transcript",
            "Older transcript summary target",
        );
        std::thread::sleep(std::time::Duration::from_secs(1));

        for idx in 0..DEFAULT_LIMIT {
            let id = format!("019e4818-7c15-7e60-9b3b-{idx:012x}");
            let transcript =
                sessions_day.join(format!("rollout-2026-05-21T10-14-{idx:02}-{id}.jsonl"));
            write_codex_transcript(
                &transcript,
                &id,
                &repo,
                &format!("Newer transcript {idx}"),
                "Newer response",
            );
        }

        let listed = list_agent_history(repo.clone(), Some(DEFAULT_LIMIT)).unwrap();
        assert_eq!(listed.len(), DEFAULT_LIMIT);
        assert!(
            listed.iter().all(|item| item.id != target_id),
            "target should be outside the default visible history limit"
        );

        let summary = agent_transcript_summary(repo, target_id.to_string())
            .unwrap()
            .unwrap();

        assert_eq!(summary.provider, AgentHistoryProvider::Codex);
        assert_eq!(summary.id, target_id);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.user_messages, 1);
        assert_eq!(summary.assistant_messages, 1);
        assert_eq!(summary.transcript_path, target.display().to_string());
    }

    #[test]
    fn transcript_summary_finds_codex_payload_id_when_filename_differs() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let codex_home = dir.path().join("codex-home");
        let sessions_day = codex_home.join("sessions/2026/05/21");
        fs::create_dir_all(&sessions_day).unwrap();
        let _home_env = EnvVarGuard::set("HOME", dir.path());
        let _codex_env = EnvVarGuard::set("CODEX_HOME", &codex_home);

        let filename_id = "019e4818-7c15-7e60-9b3b-898a1c7803d6";
        let payload_id = "payload-only-session";
        let transcript =
            sessions_day.join(format!("rollout-2026-05-21T10-13-44-{filename_id}.jsonl"));
        let mut file = fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "id": payload_id,
                    "cwd": repo.display().to_string(),
                    "role": "user",
                    "content": "Find me by payload id",
                },
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "payload": {
                    "role": "assistant",
                    "content": "Found by fallback",
                },
            })
        )
        .unwrap();
        drop(file);

        let summary = agent_transcript_summary(repo, payload_id.to_string())
            .unwrap()
            .unwrap();

        assert_eq!(summary.provider, AgentHistoryProvider::Codex);
        assert_eq!(summary.id, payload_id);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.transcript_path, transcript.display().to_string());
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

    fn fake_paths(count: usize) -> Vec<PathBuf> {
        (0..count)
            .map(|idx| PathBuf::from(format!("/tmp/acorn-history-{idx}.jsonl")))
            .collect()
    }
}
