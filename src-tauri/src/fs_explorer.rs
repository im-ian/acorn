use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use git2::{Repository, Status, StatusOptions};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const EVENT_FS_CHANGED: &str = "acorn:fs-changed";
const WATCH_BATCH_WINDOW: Duration = Duration::from_millis(75);
const WATCH_EVENT_CAP: usize = 256;
const WATCH_THROTTLE_GAP: Duration = Duration::from_millis(200);

const SUPERVISOR_INITIAL_BACKOFF: Duration = Duration::from_millis(800);
const SUPERVISOR_MAX_BACKOFF: Duration = Duration::from_millis(12_800);
const SUPERVISOR_MAX_RESTARTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Enospc,
    PathMissing,
    RescanRequired,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorAction {
    NoOp,
    WarnOnce,
    Restart { delay: Duration },
    Suspend,
    GiveUp,
}

#[derive(Debug, Default, Clone)]
pub struct SupervisorState {
    restarts: u32,
    enospc_logged: bool,
}

impl SupervisorState {
    pub fn record_restart(&mut self) {
        self.restarts = self.restarts.saturating_add(1);
    }

    pub fn record_enospc_logged(&mut self) {
        self.enospc_logged = true;
    }

    pub fn reset(&mut self) {
        self.restarts = 0;
    }

    fn backoff(&self) -> Duration {
        let shift = self.restarts.min(4);
        let ms = SUPERVISOR_INITIAL_BACKOFF
            .as_millis()
            .saturating_mul(1u128 << shift);
        let capped = ms.min(SUPERVISOR_MAX_BACKOFF.as_millis()) as u64;
        Duration::from_millis(capped)
    }
}

pub fn classify_error_message(msg: &str) -> ErrorClass {
    if msg.contains("No space left on device") {
        ErrorClass::Enospc
    } else if msg.contains("File system must be re-scanned") {
        ErrorClass::RescanRequired
    } else if msg.contains("No such file or directory") {
        ErrorClass::PathMissing
    } else {
        ErrorClass::Unknown
    }
}

pub fn decide(state: &SupervisorState, class: ErrorClass) -> SupervisorAction {
    match class {
        ErrorClass::Enospc => {
            if state.enospc_logged {
                SupervisorAction::NoOp
            } else {
                SupervisorAction::WarnOnce
            }
        }
        ErrorClass::PathMissing => SupervisorAction::Suspend,
        ErrorClass::RescanRequired | ErrorClass::Unknown => {
            if state.restarts >= SUPERVISOR_MAX_RESTARTS {
                SupervisorAction::GiveUp
            } else {
                SupervisorAction::Restart {
                    delay: state.backoff(),
                }
            }
        }
    }
}

const DEFAULT_IGNORE_GLOBS: &[&str] = &[
    "**/node_modules/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.svelte-kit/**",
    "**/.vite/**",
    "**/.turbo/**",
    "**/.cache/**",
    "**/.parcel-cache/**",
    "**/.pytest_cache/**",
    "**/__pycache__/**",
    "**/coverage/**",
];

#[derive(Debug)]
pub struct WatchIgnoreMatcher {
    set: GlobSet,
}

impl WatchIgnoreMatcher {
    pub fn with_defaults(user_globs: &[String]) -> Self {
        let mut builder = GlobSetBuilder::new();
        for pattern in DEFAULT_IGNORE_GLOBS {
            builder.add(Glob::new(pattern).expect("default ignore glob compiles"));
        }
        for user in user_globs {
            match Glob::new(user) {
                Ok(g) => {
                    builder.add(g);
                }
                Err(err) => {
                    tracing::warn!(pattern = %user, error = %err, "ignoring malformed watch exclude");
                }
            }
        }
        let set = builder.build().unwrap_or_else(|err| {
            tracing::warn!(error = %err, "watch ignore globset build failed; using empty set");
            GlobSet::empty()
        });
        Self { set }
    }

    pub fn is_ignored(&self, path: &Path, root: &Path) -> bool {
        match path.strip_prefix(root) {
            Ok(rel) => self.set.is_match(rel),
            Err(_) => true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: i64,
    /// True when `respect_gitignore` was true and the entry is ignored by
    /// the aggregated gitignore. We still surface it so the frontend can
    /// decide whether to dim it; default to hiding ignored entries.
    pub gitignored: bool,
}

#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

impl WatcherState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _batcher: WatchBatcher,
    root: PathBuf,
}

struct WatchBatcher {
    _thread: std::thread::JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize)]
struct FsChangePayload {
    paths: Vec<String>,
    root: String,
    overflow: bool,
    cap: usize,
    refresh: Option<FsRefreshHint>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct FsRefreshHint {
    kind: FsRefreshKind,
    path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FsRefreshKind {
    Root,
    Subtree,
}

fn canonical(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if p.as_os_str().is_empty() {
        return Err(AppError::InvalidPath("empty path".into()));
    }
    // For browsing we do not require the path to exist on create operations;
    // canonicalize only when the path already exists.
    if p.exists() {
        p.canonicalize().map_err(AppError::from)
    } else {
        Ok(p)
    }
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur: Option<&Path> = Some(start);
    while let Some(p) = cur {
        let dot_git = p.join(".git");
        if dot_git.exists() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}

fn build_gitignore(repo_root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(repo_root);
    let root_ignore = repo_root.join(".gitignore");
    if root_ignore.exists() {
        let _ = b.add(root_ignore);
    }
    let exclude = repo_root.join(".git").join("info").join("exclude");
    if exclude.exists() {
        let _ = b.add(exclude);
    }
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

#[derive(Debug, Clone, Serialize)]
pub struct ListResult {
    pub entries: Vec<FileEntry>,
    pub repo_root: Option<String>,
}

#[tauri::command]
pub fn fs_list_dir(
    path: String,
    show_hidden: bool,
    respect_gitignore: bool,
) -> AppResult<ListResult> {
    let dir = canonical(&path)?;
    if !dir.is_dir() {
        return Err(AppError::InvalidPath(format!("not a directory: {path}")));
    }
    let repo_root = find_repo_root(&dir);
    let gi = repo_root.as_deref().map(build_gitignore);

    let mut entries: Vec<FileEntry> = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let item = item?;
        let p = item.path();
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !show_hidden && is_hidden(&name) {
            continue;
        }
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // `DirEntry::metadata` follows symlinks on macOS, so check the link
        // type via `symlink_metadata` to distinguish links from their targets.
        let is_symlink = std::fs::symlink_metadata(&p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let is_dir = meta.is_dir();
        let gitignored = match (respect_gitignore, gi.as_ref(), repo_root.as_deref()) {
            (true, Some(g), Some(_)) => g.matched(&p, is_dir).is_ignore(),
            _ => false,
        };
        if respect_gitignore && gitignored {
            continue;
        }
        let size = if is_dir { 0 } else { meta.len() };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(FileEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            size,
            modified_ms,
            gitignored,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(ListResult {
        entries,
        repo_root: repo_root.map(|p| p.to_string_lossy().into_owned()),
    })
}

fn reject_dangerous(p: &Path) -> AppResult<()> {
    // Require absolute paths so relative arguments cannot resolve against
    // the process CWD (e.g., the app bundle) and overwrite something
    // outside the user's intended folder.
    if !p.is_absolute() {
        return Err(AppError::InvalidPath("absolute path required".into()));
    }
    for c in p.components() {
        if matches!(c, Component::ParentDir) {
            return Err(AppError::InvalidPath(
                "path traversal segment (`..`) is not allowed".into(),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> AppResult<()> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    reject_dangerous(&from_p)?;
    reject_dangerous(&to_p)?;
    if !from_p.exists() {
        return Err(AppError::InvalidPath(format!("source missing: {from}")));
    }
    if to_p.exists() {
        return Err(AppError::InvalidPath(format!("destination exists: {to}")));
    }
    std::fs::rename(&from_p, &to_p)?;
    Ok(())
}

#[tauri::command]
pub fn fs_trash(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    trash::delete(&p).map_err(|e| AppError::Other(format!("trash failed: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn fs_reveal(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("open failed: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(p.parent().unwrap_or(&p))
            .spawn()
            .map_err(|e| AppError::Other(format!("xdg-open failed: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("explorer failed: {e}")))?;
    }
    Ok(())
}

/// Open a file with the OS's default registered application. Used as a
/// fallback when the user has not set `$EDITOR` in their shell rc — the
/// PTY path otherwise blows up with `permission denied` because the
/// shell tries to execute the empty command followed by the file.
#[tauri::command]
pub fn fs_open_default(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("open failed: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("xdg-open failed: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", ""])
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("start failed: {e}")))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatusEntry {
    pub kind: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Per-path git status, mapped to a small set of buckets the frontend
/// uses to pick a color. Diff line counts are intentionally omitted here
/// because computing them requires extra per-path IO/diff work.
///
/// Paths are absolute strings keyed by full path so the FileExplorer's
/// flat lookup matches its entry paths.
///
/// `status_limit` mirrors VSCode's `git.statusLimit` (default 10_000).
/// When the libgit2 status list exceeds the limit the response is
/// truncated to the first `limit` entries and `huge=true` so the
/// frontend can stop auto-refreshing.
const DEFAULT_GIT_STATUS_LIMIT: u32 = 10_000;

#[derive(Debug, Clone, Serialize)]
pub struct GitStatusResult {
    pub statuses: HashMap<String, GitStatusEntry>,
    pub huge: bool,
    pub limit: u32,
}

#[tauri::command]
pub fn fs_git_status(
    repo_root: String,
    status_limit: Option<u32>,
) -> AppResult<GitStatusResult> {
    fs_git_status_with_limit(repo_root, status_limit)
}

/// Same as `fs_git_status` but explicit about the limit; kept callable
/// from unit tests without the `tauri::command` wrapper.
pub fn fs_git_status_with_limit(
    repo_root: String,
    status_limit: Option<u32>,
) -> AppResult<GitStatusResult> {
    let limit = status_limit.unwrap_or(DEFAULT_GIT_STATUS_LIMIT);
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(AppError::InvalidPath(format!("missing: {repo_root}")));
    }
    let empty = || GitStatusResult {
        statuses: HashMap::new(),
        huge: false,
        limit,
    };
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        // Not a git repo — return empty envelope, frontend treats this
        // as "no status colors to apply".
        Err(_) => return Ok(empty()),
    };
    let workdir = match repo.workdir() {
        Some(p) => p.to_path_buf(),
        None => return Ok(empty()),
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status failed: {e}")))?;

    let total = statuses.len();
    let huge = (total as u64) > limit as u64;
    let mut out: HashMap<String, GitStatusEntry> =
        HashMap::with_capacity(total.min(limit as usize));
    for (idx, entry) in statuses.iter().enumerate() {
        if (idx as u64) >= limit as u64 {
            break;
        }
        let Some(rel) = entry.path() else { continue };
        let abs = workdir.join(rel);
        let abs_str = abs.to_string_lossy().into_owned();
        let kind = classify_status(entry.status());
        out.insert(
            abs_str,
            GitStatusEntry {
                kind: kind.into(),
                additions: 0,
                deletions: 0,
            },
        );
    }
    Ok(GitStatusResult {
        statuses: out,
        huge,
        limit,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitDiffStatsRequest {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiffStatsEntry {
    pub additions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub fn fs_git_diff_stats(
    repo_root: String,
    entries: Vec<GitDiffStatsRequest>,
) -> AppResult<HashMap<String, GitDiffStatsEntry>> {
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(AppError::InvalidPath(format!("missing: {repo_root}")));
    }
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(HashMap::new()),
    };
    let workdir = match repo.workdir() {
        Some(p) => p.to_path_buf(),
        None => return Ok(HashMap::new()),
    };

    // Partition entries by handling strategy so one diff covers every
    // modified / renamed / conflicted path in a single pass.
    let mut added: Vec<(String, PathBuf)> = Vec::new();
    let mut deleted: Vec<(String, String)> = Vec::new();
    let mut diffable: Vec<(String, String)> = Vec::new();
    for entry in entries {
        let path = PathBuf::from(&entry.path);
        reject_dangerous(&path)?;
        let Ok(rel_path) = path.strip_prefix(&workdir) else {
            continue;
        };
        let rel = rel_path.to_string_lossy().into_owned();
        let abs = path.to_string_lossy().into_owned();
        match entry.kind.as_str() {
            "added" => added.push((abs, path)),
            "deleted" => deleted.push((abs, rel)),
            _ => diffable.push((abs, rel)),
        }
    }

    let mut out: HashMap<String, GitDiffStatsEntry> =
        HashMap::with_capacity(added.len() + deleted.len() + diffable.len());

    // Untracked / freshly-added: line count of the working-tree file.
    for (abs, path) in added {
        let additions = std::fs::read(&path)
            .map(|b| count_lines(&b))
            .unwrap_or(0);
        out.insert(abs, GitDiffStatsEntry { additions, deletions: 0 });
    }

    // Deleted: line count of the HEAD blob.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    for (abs, rel) in deleted {
        let deletions = head_tree
            .as_ref()
            .and_then(|t| t.get_path(Path::new(&rel)).ok())
            .and_then(|e| e.to_object(&repo).ok())
            .and_then(|o| o.as_blob().map(|b| count_lines(b.content())))
            .unwrap_or(0);
        out.insert(abs, GitDiffStatsEntry { additions: 0, deletions });
    }

    // Modified / renamed / conflicted: one diff scoped to every diffable
    // pathspec, fan out via `foreach` line callbacks per delta path.
    if !diffable.is_empty() {
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(false);
        for (_, rel) in &diffable {
            opts.pathspec(rel);
        }
        if let Ok(diff) =
            repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        {
            let mut per_path: HashMap<String, (u32, u32)> = HashMap::new();
            let _ = diff.foreach(
                &mut |_delta, _progress| true,
                None,
                None,
                Some(&mut |delta, _hunk, line| {
                    let rel = delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .and_then(|p| p.to_str())
                        .unwrap_or("")
                        .to_string();
                    if rel.is_empty() {
                        return true;
                    }
                    let entry = per_path.entry(rel).or_default();
                    match line.origin() {
                        '+' => entry.0 = entry.0.saturating_add(1),
                        '-' => entry.1 = entry.1.saturating_add(1),
                        _ => {}
                    }
                    true
                }),
            );
            for (abs, rel) in diffable {
                let (a, d) = per_path.get(&rel).copied().unwrap_or((0, 0));
                out.insert(abs, GitDiffStatsEntry { additions: a, deletions: d });
            }
        }
    }

    Ok(out)
}

fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let mut n = bytes.iter().filter(|&&b| b == b'\n').count() as u32;
    if bytes.last() != Some(&b'\n') {
        n += 1;
    }
    n
}

fn classify_status(s: Status) -> &'static str {
    if s.is_conflicted() {
        return "conflicted";
    }
    if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        return "deleted";
    }
    if s.intersects(Status::INDEX_NEW | Status::WT_NEW) {
        return "added";
    }
    if s.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        return "renamed";
    }
    if s.intersects(
        Status::INDEX_MODIFIED
            | Status::WT_MODIFIED
            | Status::INDEX_TYPECHANGE
            | Status::WT_TYPECHANGE,
    ) {
        return "modified";
    }
    "clean"
}

/// Read a file's contents as UTF-8 for the readonly code viewer.
/// Caps at 2 MB so a stray `git clone` of an LFS pointer or a giant
/// log file does not lock up the webview. Detects binary content by
/// the presence of a NUL byte in the first 4 KB and rejects up front.
#[derive(Debug, Clone, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

const VIEWER_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn fs_read_file(path: String) -> AppResult<ReadFileResult> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.is_file() {
        return Err(AppError::InvalidPath(format!("not a file: {path}")));
    }
    let meta = std::fs::metadata(&p)?;
    let size = meta.len();
    let mut probe = vec![0u8; 4096.min(size as usize)];
    use std::io::Read;
    let mut file = std::fs::File::open(&p)?;
    let probe_n = file.read(&mut probe)?;
    if probe[..probe_n].contains(&0) {
        return Ok(ReadFileResult {
            content: String::new(),
            size,
            truncated: false,
            binary: true,
        });
    }
    let truncated = size > VIEWER_MAX_BYTES;
    let to_read = if truncated { VIEWER_MAX_BYTES } else { size };
    let mut buf = Vec::with_capacity(to_read as usize);
    let file = std::fs::File::open(&p)?;
    let mut take = file.take(to_read);
    take.read_to_end(&mut buf)?;
    let content = String::from_utf8_lossy(&buf).into_owned();
    Ok(ReadFileResult {
        content,
        size,
        truncated,
        binary: false,
    })
}

/// Per-line change marker against HEAD for the file at `path`. Frontend
/// uses this to paint a VSCode-style gutter bar next to changed lines
/// when the readonly viewer is in view mode. `1`-indexed line numbers.
#[derive(Debug, Clone, Serialize)]
pub struct LineDiffEntry {
    pub line: u32,
    pub kind: String,
}

#[tauri::command]
pub fn fs_git_diff_lines(path: String) -> AppResult<Vec<LineDiffEntry>> {
    let target = PathBuf::from(&path);
    reject_dangerous(&target)?;
    if !target.is_file() {
        return Ok(Vec::new());
    }
    let repo = match Repository::discover(&target) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let workdir = match repo.workdir() {
        Some(p) => p.to_path_buf(),
        None => return Ok(Vec::new()),
    };
    let rel = match target.strip_prefix(&workdir) {
        Ok(r) => r.to_string_lossy().into_owned(),
        Err(_) => return Ok(Vec::new()),
    };

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&rel).context_lines(0).include_untracked(true);
    let tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = match repo.diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut opts)) {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out: Vec<LineDiffEntry> = Vec::new();
    let mut adds: Vec<u32> = Vec::new();
    let mut dels: Vec<u32> = Vec::new();
    let mut current_marker: Option<u32> = None;
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' => {
                if let Some(n) = line.new_lineno() {
                    adds.push(n);
                }
            }
            '-' => {
                if let Some(n) = line.old_lineno() {
                    dels.push(n);
                }
                // Track the new-side anchor for "modified" classification.
                if current_marker.is_none() {
                    current_marker = line.new_lineno();
                }
            }
            _ => {
                current_marker = None;
            }
        }
        true
    })
    .ok();

    // Classify: a deleted-only hunk shows as a "deleted" anchor on the
    // line immediately AFTER the deletion; an added line that follows
    // a deletion in the same hunk shows as "modified"; pure additions
    // show as "added".
    let del_set: std::collections::HashSet<u32> = dels.iter().copied().collect();
    let add_set: std::collections::HashSet<u32> = adds.iter().copied().collect();
    for n in adds.iter().copied() {
        // Heuristic: if the prior new-line was a deletion anchor or a
        // contiguous addition started at n, mark as modified vs added.
        // We classify all adds as `added` here; the frontend collapses
        // the visual to a single bar so the distinction is cosmetic.
        let kind = if del_set.contains(&n) {
            "modified"
        } else {
            "added"
        };
        out.push(LineDiffEntry {
            line: n,
            kind: kind.into(),
        });
    }
    // Surface pure deletions as a marker on the next surviving line so
    // the user knows something was removed at that spot. Use min(new
    // lineno) recorded next to the deletion when available.
    if adds.is_empty() && !dels.is_empty() {
        out.push(LineDiffEntry {
            line: 1,
            kind: "deleted".into(),
        });
    }
    let _ = add_set; // silence: kept for future "modified vs added" refinement
    Ok(out)
}

/// Return the current branch name (or short HEAD oid when detached) of
/// the repo enclosing `repo_root`. Empty string when the path is not a
/// git repo — frontend then hides the branch chip.
#[tauri::command]
pub fn fs_git_branch(repo_root: String) -> AppResult<String> {
    let root = PathBuf::from(&repo_root);
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(String::new()),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(String::new()),
    };
    if head.is_branch() {
        if let Some(name) = head.shorthand() {
            return Ok(name.to_string());
        }
    }
    if let Some(oid) = head.target() {
        let short = oid.to_string();
        return Ok(short.chars().take(7).collect());
    }
    Ok(String::new())
}

/// Return the cached `$EDITOR` value pulled from the user's shell rc.
/// Empty string when unset — frontend uses that to decide between the
/// PTY editor path and the OS-default opener.
#[tauri::command]
pub fn fs_shell_editor() -> String {
    crate::shell_env::resolve()
        .get("EDITOR")
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub fn fs_watch_set_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<()> {
    let mut guard = state.fs_watcher.inner.lock();
    if let Some(p) = path.as_deref() {
        let root = canonical(p)?;
        if !root.is_dir() {
            return Err(AppError::InvalidPath(format!("not a directory: {p}")));
        }
        if let Some(existing) = guard.as_ref() {
            if existing.root == root {
                return Ok(());
            }
        }
        let (tx, rx) = mpsc::channel();
        let batcher = spawn_watch_batcher(app.clone(), root.clone(), rx);
        let tx_for_cb = tx.clone();
        drop(tx);
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
            let _ = tx_for_cb.send(res);
        })
        .map_err(|e| AppError::Other(format!("notify init failed: {e}")))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| AppError::Other(format!("notify watch failed: {e}")))?;
        *guard = Some(WatcherHandle {
            _watcher: watcher,
            _batcher: batcher,
            root,
        });
    } else {
        *guard = None;
    }
    Ok(())
}

fn spawn_watch_batcher<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    rx: Receiver<notify::Result<Event>>,
) -> WatchBatcher {
    let thread = std::thread::spawn(move || run_watch_batcher(app, root, rx));
    WatchBatcher { _thread: thread }
}

fn run_watch_batcher<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    rx: Receiver<notify::Result<Event>>,
) {
    let mut last_emit: Option<Instant> = None;
    loop {
        let first = match rx.recv() {
            Ok(res) => res,
            Err(_) => break,
        };
        let mut batch = WatchBatch::new(&root, Arc::new(WatchIgnoreMatcher::with_defaults(&[])));
        batch.add_result(first);

        let deadline = Instant::now() + WATCH_BATCH_WINDOW;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline.saturating_duration_since(now)) {
                Ok(res) => batch.add_result(res),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let Some(payload) = batch.finish() else {
            continue;
        };

        // Cap emit rate at one payload per WATCH_THROTTLE_GAP so a sustained
        // burst (e.g. a long `cargo build` rewriting `target/`) cannot
        // deliver more than ~5 payloads/sec to the frontend.
        let wait = throttle_delay(last_emit, Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }

        last_emit = Some(Instant::now());
        if let Err(e) = app.emit(EVENT_FS_CHANGED, payload) {
            tracing::warn!(error = %e, "fs-changed emit failed");
        }
    }
}

fn throttle_delay(last_emit: Option<Instant>, now: Instant) -> Duration {
    let Some(last) = last_emit else {
        return Duration::ZERO;
    };
    let elapsed = now.saturating_duration_since(last);
    WATCH_THROTTLE_GAP.saturating_sub(elapsed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchedKind {
    Added,
    Updated,
    Removed,
}

impl BatchedKind {
    fn from_event_kind(k: &EventKind) -> Option<Self> {
        match k {
            EventKind::Create(_) => Some(Self::Added),
            EventKind::Modify(_) => Some(Self::Updated),
            EventKind::Remove(_) => Some(Self::Removed),
            _ => None,
        }
    }
}

/// Merge a new event kind for an already-seen path. Returns `None` when
/// the new event cancels the existing one (Add+Remove). Mirrors VSCode's
/// `coalesceEvents` rules in `watcher-common.ts:342-470`.
fn merge_kinds(existing: BatchedKind, incoming: BatchedKind) -> Option<BatchedKind> {
    use BatchedKind::*;
    match (existing, incoming) {
        (Added, Removed) => None,
        (Removed, Added) => Some(Updated),
        (Added, Updated) => Some(Added),
        _ => Some(incoming),
    }
}

#[derive(Debug)]
struct WatchBatch {
    root: PathBuf,
    seen: HashMap<PathBuf, BatchedKind>,
    common_ancestor: Option<PathBuf>,
    overflow: bool,
    ignore: Arc<WatchIgnoreMatcher>,
}

impl WatchBatch {
    fn new(root: &Path, ignore: Arc<WatchIgnoreMatcher>) -> Self {
        Self {
            root: root.to_path_buf(),
            seen: HashMap::new(),
            common_ancestor: None,
            overflow: false,
            ignore,
        }
    }

    fn add_result(&mut self, res: notify::Result<Event>) {
        let event = match res {
            Ok(e) => e,
            Err(err) => {
                tracing::debug!(error = %err, "fs watch error");
                return;
            }
        };
        self.add_event(event);
    }

    fn add_event(&mut self, event: Event) {
        if event.need_rescan() {
            self.add_path(self.root.clone(), BatchedKind::Updated);
            self.overflow = true;
            return;
        }

        let Some(kind) = BatchedKind::from_event_kind(&event.kind) else {
            return;
        };

        for path in event.paths {
            let Some(path) = normalize_watch_path(&path) else {
                continue;
            };
            if !path_is_inside_root(&path, &self.root) {
                continue;
            }
            if self.ignore.is_ignored(&path, &self.root) {
                continue;
            }
            self.add_path(path, kind);
        }
    }

    fn add_path(&mut self, path: PathBuf, kind: BatchedKind) {
        self.common_ancestor = Some(match self.common_ancestor.take() {
            Some(current) => common_ancestor(&current, &path),
            None => path.clone(),
        });

        if self.seen.len() >= WATCH_EVENT_CAP && !self.seen.contains_key(&path) {
            self.overflow = true;
            return;
        }

        let merged = match self.seen.get(&path).copied() {
            None => Some(kind),
            Some(existing) => merge_kinds(existing, kind),
        };
        match merged {
            None => {
                self.seen.remove(&path);
            }
            Some(k) => {
                self.seen.insert(path, k);
            }
        }
    }

    fn finish(self) -> Option<FsChangePayload> {
        if self.seen.is_empty() && !self.overflow {
            return None;
        }

        // Split: collect deletes, sort shortest-first, suppress any delete
        // whose ancestor is also being deleted (folder-delete fan-in).
        let mut deletes: Vec<PathBuf> = Vec::new();
        let mut others: Vec<PathBuf> = Vec::new();
        for (path, kind) in self.seen.into_iter() {
            match kind {
                BatchedKind::Removed => deletes.push(path),
                _ => others.push(path),
            }
        }
        deletes.sort_by_key(|p| p.as_os_str().len());
        let mut kept_deletes: Vec<PathBuf> = Vec::with_capacity(deletes.len());
        for d in deletes {
            let suppressed = kept_deletes
                .iter()
                .any(|parent| d != *parent && d.starts_with(parent));
            if suppressed {
                continue;
            }
            kept_deletes.push(d);
        }

        let mut all: Vec<PathBuf> = kept_deletes;
        all.append(&mut others);

        let refresh = self.overflow.then(|| {
            let refresh_path = self
                .common_ancestor
                .as_deref()
                .filter(|p| path_is_inside_root(p, &self.root))
                .unwrap_or(&self.root)
                .to_path_buf();
            FsRefreshHint {
                kind: if refresh_path == self.root {
                    FsRefreshKind::Root
                } else {
                    FsRefreshKind::Subtree
                },
                path: refresh_path.to_string_lossy().into_owned(),
            }
        });

        Some(FsChangePayload {
            paths: all
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            root: self.root.to_string_lossy().into_owned(),
            overflow: self.overflow,
            cap: WATCH_EVENT_CAP,
            refresh,
        })
    }
}

fn normalize_watch_path(path: &Path) -> Option<PathBuf> {
    // The watcher root is canonicalized at watch start (fs_watch_set_root),
    // and notify delivers paths in the same canonical form on macOS/Linux/
    // Windows. Avoid a per-event stat() — pure component walk only.
    normalize_absolute_path(path)
}

fn normalize_absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }

    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Some(out)
}

fn path_is_inside_root(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn common_ancestor(a: &Path, b: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for (a_component, b_component) in a.components().zip(b.components()) {
        if a_component != b_component {
            break;
        }
        out.push(a_component.as_os_str());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use std::fs;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn create_event(paths: Vec<PathBuf>) -> Event {
        let mut event = Event::new(EventKind::Create(CreateKind::Any));
        event.paths = paths;
        event
    }

    fn remove_event(paths: Vec<PathBuf>) -> Event {
        let mut event = Event::new(EventKind::Remove(RemoveKind::Any));
        event.paths = paths;
        event
    }

    fn modify_event(paths: Vec<PathBuf>) -> Event {
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.paths = paths;
        event
    }

    fn new_batch(root: &Path) -> WatchBatch {
        WatchBatch::new(root, Arc::new(WatchIgnoreMatcher::with_defaults(&[])))
    }

    #[test]
    fn lists_directory_dirs_first_then_alpha() {
        let d = tmpdir();
        fs::write(d.path().join("zebra.txt"), b"z").unwrap();
        fs::write(d.path().join("apple.txt"), b"a").unwrap();
        fs::create_dir(d.path().join("middle")).unwrap();
        fs::create_dir(d.path().join("Alpha")).unwrap();

        let res = fs_list_dir(d.path().to_string_lossy().into_owned(), false, false).unwrap();
        let names: Vec<_> = res.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["Alpha", "middle", "apple.txt", "zebra.txt"]);
    }

    #[test]
    fn hides_dotfiles_by_default() {
        let d = tmpdir();
        fs::write(d.path().join(".env"), b"").unwrap();
        fs::write(d.path().join("visible.txt"), b"").unwrap();

        let hidden_off =
            fs_list_dir(d.path().to_string_lossy().into_owned(), false, false).unwrap();
        assert_eq!(hidden_off.entries.len(), 1);
        let hidden_on = fs_list_dir(d.path().to_string_lossy().into_owned(), true, false).unwrap();
        assert_eq!(hidden_on.entries.len(), 2);
    }

    #[test]
    fn respects_gitignore_when_repo_root_present() {
        let d = tmpdir();
        fs::create_dir(d.path().join(".git")).unwrap();
        fs::write(d.path().join(".gitignore"), b"build/\nsecret.txt\n").unwrap();
        fs::create_dir(d.path().join("build")).unwrap();
        fs::write(d.path().join("secret.txt"), b"").unwrap();
        fs::write(d.path().join("keep.txt"), b"").unwrap();

        let on = fs_list_dir(d.path().to_string_lossy().into_owned(), false, true).unwrap();
        let names: Vec<_> = on.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["keep.txt"]);

        let off = fs_list_dir(d.path().to_string_lossy().into_owned(), false, false).unwrap();
        let off_names: Vec<_> = off.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(off_names, vec!["build", "keep.txt", "secret.txt"]);
    }

    #[test]
    fn watch_batch_filters_noisy_and_outside_paths() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = WatchBatch::new(&root, Arc::new(WatchIgnoreMatcher::with_defaults(&[])));

        batch.add_event(create_event(vec![
            root.join("src").join("main.rs"),
            root.join(".git").join("index"),
            root.join("node_modules").join("pkg").join("index.js"),
            root.join("target").join("debug").join("acorn"),
            root.join("src").join("..").join("src").join("lib.rs"),
            root.join("..").join("outside.rs"),
            PathBuf::from("relative.rs"),
        ]));

        let payload = batch.finish().unwrap();
        let mut paths = payload.paths;
        paths.sort();
        assert_eq!(
            paths,
            vec![
                root.join(".git")
                    .join("index")
                    .to_string_lossy()
                    .into_owned(),
                root.join("src")
                    .join("lib.rs")
                    .to_string_lossy()
                    .into_owned(),
                root.join("src")
                    .join("main.rs")
                    .to_string_lossy()
                    .into_owned(),
            ]
        );
        assert!(!payload.overflow);
        assert!(payload.refresh.is_none());
    }

    #[test]
    fn watch_batch_caps_paths_and_provides_subtree_refresh() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let src = root.join("src");
        let mut batch = WatchBatch::new(&root, Arc::new(WatchIgnoreMatcher::with_defaults(&[])));

        for n in 0..(WATCH_EVENT_CAP + 10) {
            batch.add_event(create_event(vec![src.join(format!("file-{n}.rs"))]));
        }

        let payload = batch.finish().unwrap();
        assert_eq!(payload.paths.len(), WATCH_EVENT_CAP);
        assert!(payload.overflow);
        assert_eq!(payload.cap, WATCH_EVENT_CAP);
        assert_eq!(
            payload.refresh,
            Some(FsRefreshHint {
                kind: FsRefreshKind::Subtree,
                path: src.to_string_lossy().into_owned(),
            })
        );
    }

    #[test]
    fn watch_batch_rescan_requests_root_refresh() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = WatchBatch::new(&root, Arc::new(WatchIgnoreMatcher::with_defaults(&[])));

        batch.add_event(Event::new(EventKind::Any).set_flag(notify::event::Flag::Rescan));

        let payload = batch.finish().unwrap();
        assert_eq!(payload.paths, vec![root.to_string_lossy().into_owned()]);
        assert!(payload.overflow);
        assert_eq!(
            payload.refresh,
            Some(FsRefreshHint {
                kind: FsRefreshKind::Root,
                path: root.to_string_lossy().into_owned(),
            })
        );
    }

    #[test]
    fn ignore_matcher_blocks_default_dirs() {
        let m = WatchIgnoreMatcher::with_defaults(&[]);
        let root = Path::new("/proj");
        assert!(m.is_ignored(&root.join("node_modules/pkg/index.js"), root));
        assert!(m.is_ignored(&root.join("target/debug/acorn"), root));
        assert!(m.is_ignored(&root.join("src/__pycache__/x.pyc"), root));
        assert!(!m.is_ignored(&root.join("src/main.rs"), root));
    }

    #[test]
    fn ignore_matcher_accepts_user_globs() {
        let m = WatchIgnoreMatcher::with_defaults(&[
            "out/**".to_string(),
            "**/*.log".to_string(),
        ]);
        let root = Path::new("/proj");
        assert!(m.is_ignored(&root.join("out/bundle.js"), root));
        assert!(m.is_ignored(&root.join("nested/a.log"), root));
        assert!(!m.is_ignored(&root.join("src/a.rs"), root));
    }

    #[test]
    fn ignore_matcher_treats_outside_root_as_ignored() {
        let m = WatchIgnoreMatcher::with_defaults(&[]);
        let root = Path::new("/proj");
        assert!(m.is_ignored(Path::new("/other/file.rs"), root));
    }

    #[test]
    fn ignore_matcher_skips_bad_user_globs() {
        let m = WatchIgnoreMatcher::with_defaults(&["[[invalid".to_string()]);
        let root = Path::new("/proj");
        assert!(!m.is_ignored(&root.join("src/a.rs"), root));
    }

    #[test]
    fn fs_git_status_marks_huge_when_over_limit() {
        use git2::Repository;

        let d = tmpdir();
        // Canonicalize to dodge macOS /tmp -> /private/tmp symlink — libgit2
        // returns workdir as the canonicalized path.
        let repo_path = d.path().canonicalize().unwrap();
        Repository::init(&repo_path).unwrap();
        // 12 untracked files; we'll set the limit to 5.
        for i in 0..12 {
            fs::write(repo_path.join(format!("u{i}.txt")), b"x").unwrap();
        }

        let res = fs_git_status_with_limit(
            repo_path.to_string_lossy().into_owned(),
            Some(5),
        )
        .unwrap();
        assert!(res.huge);
        assert_eq!(res.limit, 5);
        assert_eq!(res.statuses.len(), 5);
    }

    #[test]
    fn fs_git_status_default_envelope_not_huge_for_small_repo() {
        let d = tmpdir();
        // Canonicalize to dodge macOS /tmp -> /private/tmp symlink.
        let repo_path = d.path().canonicalize().unwrap();
        git2::Repository::init(&repo_path).unwrap();
        fs::write(repo_path.join("a.txt"), b"hi").unwrap();
        let res = fs_git_status_with_limit(
            repo_path.to_string_lossy().into_owned(),
            Some(10_000),
        )
        .unwrap();
        assert!(!res.huge);
        assert_eq!(res.limit, 10_000);
        assert!(res.statuses.contains_key(
            &repo_path.join("a.txt").to_string_lossy().into_owned()
        ));
    }

    #[test]
    fn rename_rejects_traversal_segments() {
        let res = fs_rename("/tmp/../etc/evil".to_string(), "/tmp/x".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn rename_file_roundtrip() {
        let d = tmpdir();
        let a = d.path().join("a.txt");
        let b = d.path().join("b.txt");
        std::fs::write(&a, b"hi").unwrap();
        fs_rename(
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(!a.exists());
        assert!(b.exists());
    }

    #[test]
    fn normalize_event_path_is_pure_for_missing_files() {
        // Path does not exist; must still normalize via component walk only.
        let p = normalize_watch_path(Path::new("/tmp/does-not-exist/a/./b/../c"));
        assert_eq!(p, Some(PathBuf::from("/tmp/does-not-exist/a/c")));
    }

    #[test]
    fn normalize_event_path_rejects_relative() {
        assert_eq!(normalize_watch_path(Path::new("relative/path")), None);
    }

    #[test]
    fn normalize_event_path_preserves_existing_absolute() {
        let d = tmpdir();
        let f = d.path().join("real.txt");
        fs::write(&f, b"x").unwrap();
        let out = normalize_watch_path(&f).expect("normalized");
        // No requirement to canonicalize; equality up to component walk is enough.
        assert!(out.is_absolute());
        assert!(out.ends_with("real.txt"));
    }

    #[test]
    fn supervisor_classifies_enospc() {
        let msg = "No space left on device (os error 28)";
        assert_eq!(classify_error_message(msg), ErrorClass::Enospc);
    }

    #[test]
    fn supervisor_classifies_rescan_required() {
        let msg = "File system must be re-scanned";
        assert_eq!(classify_error_message(msg), ErrorClass::RescanRequired);
    }

    #[test]
    fn supervisor_classifies_path_not_found() {
        assert_eq!(
            classify_error_message("Operation not permitted (os error 1)"),
            ErrorClass::Unknown,
        );
        assert_eq!(
            classify_error_message("No such file or directory (os error 2)"),
            ErrorClass::PathMissing,
        );
    }

    #[test]
    fn supervisor_restarts_first_unknown_error_after_800ms() {
        let state = SupervisorState::default();
        let action = decide(&state, ErrorClass::Unknown);
        assert_eq!(
            action,
            SupervisorAction::Restart {
                delay: Duration::from_millis(800)
            }
        );
    }

    #[test]
    fn supervisor_doubles_backoff_up_to_cap() {
        let mut state = SupervisorState::default();
        for expected_ms in [800u64, 1600, 3200, 6400, 12800] {
            let action = decide(&state, ErrorClass::Unknown);
            assert_eq!(
                action,
                SupervisorAction::Restart {
                    delay: Duration::from_millis(expected_ms)
                }
            );
            state.record_restart();
        }
        // After 5 restarts, give up.
        assert_eq!(decide(&state, ErrorClass::Unknown), SupervisorAction::GiveUp);
    }

    #[test]
    fn supervisor_suspends_on_path_missing() {
        let state = SupervisorState::default();
        assert_eq!(
            decide(&state, ErrorClass::PathMissing),
            SupervisorAction::Suspend
        );
    }

    #[test]
    fn supervisor_emits_warn_only_once_for_enospc() {
        let mut state = SupervisorState::default();
        assert_eq!(decide(&state, ErrorClass::Enospc), SupervisorAction::WarnOnce);
        state.record_enospc_logged();
        assert_eq!(decide(&state, ErrorClass::Enospc), SupervisorAction::NoOp);
    }

    #[test]
    fn supervisor_treats_rescan_required_as_restart() {
        let state = SupervisorState::default();
        assert_eq!(
            decide(&state, ErrorClass::RescanRequired),
            SupervisorAction::Restart {
                delay: Duration::from_millis(800)
            }
        );
    }

    #[test]
    fn throttle_delay_returns_zero_for_first_emit() {
        let now = Instant::now();
        assert_eq!(throttle_delay(None, now), Duration::ZERO);
    }

    #[test]
    fn throttle_delay_returns_zero_when_gap_already_exceeded() {
        let last = Instant::now();
        let now = last + Duration::from_millis(500);
        assert_eq!(throttle_delay(Some(last), now), Duration::ZERO);
    }

    #[test]
    fn throttle_delay_returns_remainder_when_too_soon() {
        let last = Instant::now();
        let now = last + Duration::from_millis(120);
        let got = throttle_delay(Some(last), now);
        // 200ms target - 120ms elapsed = 80ms remaining.
        assert!(got >= Duration::from_millis(75) && got <= Duration::from_millis(85));
    }

    #[test]
    fn coalesce_drops_create_then_delete_pair() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = new_batch(&root);
        let f = root.join("a.txt");
        batch.add_event(create_event(vec![f.clone()]));
        batch.add_event(remove_event(vec![f]));
        assert!(batch.finish().is_none(), "create+delete must net to nothing");
    }

    #[test]
    fn coalesce_flattens_delete_then_create_to_single_path() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = new_batch(&root);
        let f = root.join("a.txt");
        batch.add_event(remove_event(vec![f.clone()]));
        batch.add_event(create_event(vec![f.clone()]));
        let payload = batch.finish().expect("payload");
        assert_eq!(payload.paths, vec![f.to_string_lossy().into_owned()]);
    }

    #[test]
    fn coalesce_suppresses_child_deletes_under_parent_delete() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let dir = root.join("dir");
        let mut batch = new_batch(&root);
        batch.add_event(remove_event(vec![
            dir.join("a.txt"),
            dir.join("sub").join("b.txt"),
            dir.clone(),
        ]));
        let payload = batch.finish().expect("payload");
        assert_eq!(payload.paths, vec![dir.to_string_lossy().into_owned()]);
    }

    #[test]
    fn coalesce_keeps_unrelated_updates_alongside_deletes() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = new_batch(&root);
        let parent = root.join("dir");
        let other = root.join("untouched.txt");
        batch.add_event(modify_event(vec![other.clone()]));
        batch.add_event(remove_event(vec![parent.join("inside.txt"), parent.clone()]));
        let payload = batch.finish().expect("payload");
        let mut got = payload.paths;
        got.sort();
        let mut want = vec![
            parent.to_string_lossy().into_owned(),
            other.to_string_lossy().into_owned(),
        ];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn diff_stats_modified_returns_correct_counts() {
        use git2::{Repository, Signature};

        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        let repo = Repository::init(&repo_path).unwrap();

        fs::write(repo_path.join("a.rs"), "1\n2\n3\n4\n5\n").unwrap();
        fs::write(repo_path.join("b.rs"), "x\ny\n").unwrap();

        let sig = Signature::now("t", "t@t").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.rs")).unwrap();
            index.add_path(Path::new("b.rs")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }

        // Purely additive: insert 3 new lines between "2" and "3".
        fs::write(repo_path.join("a.rs"), "1\n2\nNEW1\nNEW2\nNEW3\n3\n4\n5\n").unwrap();

        let entries = vec![GitDiffStatsRequest {
            path: repo_path.join("a.rs").to_string_lossy().into_owned(),
            kind: "modified".to_string(),
        }];
        let stats = fs_git_diff_stats(
            repo_path.to_string_lossy().into_owned(),
            entries,
        )
        .unwrap();
        let entry = stats.values().next().expect("one entry");
        assert_eq!(entry.additions, 3);
        assert_eq!(entry.deletions, 0);
    }

    #[test]
    fn diff_stats_handles_multiple_modified_paths_in_one_call() {
        use git2::{Repository, Signature};

        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        let repo = Repository::init(&repo_path).unwrap();
        fs::write(repo_path.join("x.rs"), "a\nb\nc\n").unwrap();
        fs::write(repo_path.join("y.rs"), "a\nb\nc\n").unwrap();
        let sig = Signature::now("t", "t@t").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("x.rs")).unwrap();
            index.add_path(Path::new("y.rs")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }
        // x.rs: +2 lines (purely additive). y.rs: -1 line.
        fs::write(repo_path.join("x.rs"), "a\nb\nc\nNEW1\nNEW2\n").unwrap();
        fs::write(repo_path.join("y.rs"), "a\nc\n").unwrap();

        let entries = vec![
            GitDiffStatsRequest {
                path: repo_path.join("x.rs").to_string_lossy().into_owned(),
                kind: "modified".to_string(),
            },
            GitDiffStatsRequest {
                path: repo_path.join("y.rs").to_string_lossy().into_owned(),
                kind: "modified".to_string(),
            },
        ];
        let stats = fs_git_diff_stats(
            repo_path.to_string_lossy().into_owned(),
            entries,
        )
        .unwrap();
        let x_key = repo_path.join("x.rs").to_string_lossy().into_owned();
        let y_key = repo_path.join("y.rs").to_string_lossy().into_owned();
        assert_eq!(stats[&x_key].additions, 2);
        assert_eq!(stats[&x_key].deletions, 0);
        assert_eq!(stats[&y_key].additions, 0);
        assert_eq!(stats[&y_key].deletions, 1);
    }
}
