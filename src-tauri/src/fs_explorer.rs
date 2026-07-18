use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use git2::{Repository, Status, StatusOptions};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::worktree;

const EVENT_FS_CHANGED: &str = "acorn:fs-changed";
const WATCH_BATCH_WINDOW: Duration = Duration::from_millis(75);
const WATCH_EVENT_CAP: usize = 256;
const WATCH_THROTTLE_GAP: Duration = Duration::from_millis(200);
const WATCH_QUEUE_CAPACITY: usize = 1024;
const MAX_GITIGNORE_BYTES: u64 = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_GITIGNORE_LINES: usize = 10_000;
// Diff stats are informational. Treat unusually large repository inputs as
// unknown instead of reading entire files or blobs into memory just to count.
const MAX_DIFF_STAT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DIFF_STAT_LINES: u32 = 200_000;
const MAX_DIFF_STAT_PATHS: usize = 5_000;
const MAX_DIFF_STAT_CALLBACK_LINES: u32 = 500_000;

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

/// Glue between an error message and the supervisor state machine.
/// Mutates `state` (enospc_logged or restarts) as a side effect of the
/// returned action so callers do not have to remember which counter to bump.
pub fn handle_supervisor_error(msg: &str, state: &mut SupervisorState) -> SupervisorAction {
    let class = classify_error_message(msg);
    let action = decide(state, class);
    match action {
        SupervisorAction::WarnOnce => state.record_enospc_logged(),
        SupervisorAction::Restart { .. } => state.record_restart(),
        _ => {}
    }
    action
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
    /// Set when any `.git/...` path (excluding index.lock variants and
    /// watchman-cookie noise) was touched during this batch.
    dotgit_changed: bool,
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

#[derive(Debug, Clone)]
struct ScopedPath {
    requested: PathBuf,
    resolved: PathBuf,
    root: PathBuf,
}

#[derive(Debug, Clone)]
struct FsScope {
    roots: Vec<PathBuf>,
    external_files: Vec<PathBuf>,
}

impl FsScope {
    fn from_state(state: &AppState) -> Self {
        let mut roots = Vec::new();
        let mut project_roots = Vec::new();
        for project in state.projects.list() {
            if let Some(root) = Self::push_root(&mut roots, project.repo_path) {
                project_roots.push(root);
            }
        }
        project_roots.sort();
        project_roots.dedup();
        for project_root in &project_roots {
            match worktree::list_worktree_paths(project_root) {
                Ok(worktrees) => {
                    for worktree_path in worktrees {
                        Self::push_root(&mut roots, worktree_path);
                    }
                }
                Err(err) => {
                    tracing::debug!(
                        path = %project_root.display(),
                        error = %err,
                        "skipping linked worktree filesystem scope roots"
                    );
                }
            }
        }
        for session in state.sessions.list() {
            if session.project_scoped == false {
                continue;
            }
            let Ok(repo) = session.repo_path.canonicalize() else {
                continue;
            };
            if !project_roots.iter().any(|root| root == &repo) {
                continue;
            }
            Self::push_root(&mut roots, session.worktree_path);
        }
        roots.sort_by(|a, b| {
            b.components()
                .count()
                .cmp(&a.components().count())
                .then_with(|| a.cmp(b))
        });
        roots.dedup();
        let mut external_files = state.external_file_grants.lock().clone();
        external_files.sort();
        external_files.dedup();
        Self {
            roots,
            external_files,
        }
    }

    #[cfg(test)]
    fn from_roots<I>(roots: I) -> Self
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let mut out = Vec::new();
        for root in roots {
            Self::push_root(&mut out, root);
        }
        out.sort_by(|a, b| {
            b.components()
                .count()
                .cmp(&a.components().count())
                .then_with(|| a.cmp(b))
        });
        out.dedup();
        Self {
            roots: out,
            external_files: Vec::new(),
        }
    }

    #[cfg(test)]
    fn from_roots_and_external_files<I, J>(roots: I, external_files: J) -> Self
    where
        I: IntoIterator<Item = PathBuf>,
        J: IntoIterator<Item = PathBuf>,
    {
        let mut scope = Self::from_roots(roots);
        scope.external_files = external_files.into_iter().collect();
        scope.external_files.sort();
        scope.external_files.dedup();
        scope
    }

    fn push_root(roots: &mut Vec<PathBuf>, root: PathBuf) -> Option<PathBuf> {
        if root.as_os_str().is_empty() || !root.is_absolute() || !root.exists() {
            return None;
        }
        match root.canonicalize() {
            Ok(canonical_root) => {
                roots.push(canonical_root.clone());
                Some(canonical_root)
            }
            Err(err) => {
                tracing::debug!(
                    path = %root.display(),
                    error = %err,
                    "skipping filesystem scope root"
                );
                None
            }
        }
    }

    fn authorize_existing(&self, path: &Path) -> AppResult<ScopedPath> {
        reject_dangerous(path)?;
        let resolved = path.canonicalize().map_err(AppError::from)?;
        let root = self.match_root(&resolved)?;
        Ok(ScopedPath {
            requested: path.to_path_buf(),
            resolved,
            root,
        })
    }

    fn authorize_existing_or_missing(&self, path: &Path) -> AppResult<ScopedPath> {
        reject_dangerous(path)?;
        if path.exists() {
            return self.authorize_existing(path);
        }
        let requested = normalize_absolute_path(path)
            .ok_or_else(|| AppError::InvalidPath("absolute path required".into()))?;
        let nearest = nearest_existing_ancestor(&requested).ok_or_else(|| {
            AppError::InvalidPath(format!("path outside allowed roots: {}", path.display()))
        })?;
        let nearest_resolved = nearest.canonicalize().map_err(AppError::from)?;
        let suffix = requested.strip_prefix(&nearest).map_err(|_| {
            AppError::InvalidPath(format!("path outside allowed roots: {}", path.display()))
        })?;
        let resolved = nearest_resolved.join(suffix);
        let root = self.match_root(&resolved)?;
        let nearest_root = self.match_root(&nearest_resolved)?;
        if root != nearest_root {
            return Err(AppError::InvalidPath(format!(
                "path outside allowed roots: {}",
                path.display()
            )));
        }
        Ok(ScopedPath {
            requested: path.to_path_buf(),
            resolved,
            root,
        })
    }

    fn match_root(&self, path: &Path) -> AppResult<PathBuf> {
        if let Some(root) = self
            .roots
            .iter()
            .find(|root| path_is_inside_root(path, root))
            .cloned()
        {
            return Ok(root);
        }
        if self.external_files.iter().any(|file| file == path) {
            return Ok(path.to_path_buf());
        }
        Err(AppError::InvalidPath(format!(
            "path outside allowed project roots: {}",
            path.display()
        )))
    }
}

fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
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
    add_bounded_gitignore_file(&mut b, &root_ignore);
    let exclude = repo_root.join(".git").join("info").join("exclude");
    add_bounded_gitignore_file(&mut b, &exclude);
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

fn add_bounded_gitignore_file(builder: &mut GitignoreBuilder, path: &Path) {
    // Repositories are untrusted input. Never let a linked special file (for
    // example `/dev/zero`) or an oversized ignore file block the explorer.
    let Ok(link_meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if link_meta.file_type().is_symlink()
        || !link_meta.is_file()
        || link_meta.len() > MAX_GITIGNORE_BYTES
    {
        return;
    }

    let Ok(file) = File::open(path) else {
        return;
    };
    let Ok(open_meta) = file.metadata() else {
        return;
    };
    if !open_meta.is_file() || open_meta.len() > MAX_GITIGNORE_BYTES {
        return;
    }

    // Re-check the byte limit while reading because the file can grow after
    // metadata is inspected. Parsing happens only after all limits pass, so a
    // rejected file cannot leave a partially populated matcher behind.
    let mut bytes = Vec::with_capacity(open_meta.len() as usize);
    if file
        .take(MAX_GITIGNORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_GITIGNORE_BYTES
    {
        return;
    }
    let Ok(contents) = String::from_utf8(bytes) else {
        return;
    };
    let lines: Vec<&str> = contents.lines().collect();
    if lines.len() > MAX_GITIGNORE_LINES {
        return;
    }

    for (index, line) in lines.into_iter().enumerate() {
        // Match the ignore crate's file parser, including its first-line BOM
        // handling, while retaining the source path in parse diagnostics.
        let line = if index == 0 {
            line.trim_start_matches('\u{feff}')
        } else {
            line
        };
        let _ = builder.add_line(Some(path.to_path_buf()), line);
    }
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
    state: State<'_, AppState>,
    path: String,
    show_hidden: bool,
    respect_gitignore: bool,
) -> AppResult<ListResult> {
    let scope = FsScope::from_state(state.inner());
    fs_list_dir_scoped(&scope, path, show_hidden, respect_gitignore)
}

fn fs_list_dir_scoped(
    scope: &FsScope,
    path: String,
    show_hidden: bool,
    respect_gitignore: bool,
) -> AppResult<ListResult> {
    fs_list_dir_scoped_with_limit(
        scope,
        path,
        show_hidden,
        respect_gitignore,
        MAX_DIRECTORY_ENTRIES,
    )
}

fn fs_list_dir_scoped_with_limit(
    scope: &FsScope,
    path: String,
    show_hidden: bool,
    respect_gitignore: bool,
    max_entries: usize,
) -> AppResult<ListResult> {
    let dir = scope.authorize_existing(Path::new(&path))?.resolved;
    if !dir.is_dir() {
        return Err(AppError::InvalidPath(format!("not a directory: {path}")));
    }
    let repo_root = find_repo_root(&dir);
    let gi = repo_root.as_deref().map(build_gitignore);

    let mut entries: Vec<FileEntry> = Vec::new();
    for (index, item) in std::fs::read_dir(&dir)?.enumerate() {
        if index >= max_entries {
            return Err(AppError::Other(format!(
                "directory contains more than {max_entries} entries"
            )));
        }
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

pub(crate) fn move_to_trash(p: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};

        // Finder-backed AppleScript trashing can reject valid POSIX paths
        // before Finder moves the file. NSFileManager accepts file URLs
        // directly and avoids the extra Automation permission hop.
        let mut ctx = trash::TrashContext::new();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(p)
            .map_err(|e| AppError::Other(format!("trash failed: {e}")))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(p).map_err(|e| AppError::Other(format!("trash failed: {e}")))?;
    }

    Ok(())
}

#[tauri::command]
pub fn fs_rename(state: State<'_, AppState>, from: String, to: String) -> AppResult<()> {
    let scope = FsScope::from_state(state.inner());
    fs_rename_scoped(&scope, from, to)
}

fn fs_rename_scoped(scope: &FsScope, from: String, to: String) -> AppResult<()> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    let from_scoped = scope.authorize_existing(&from_p)?;
    let to_scoped = scope.authorize_existing_or_missing(&to_p)?;
    if from_scoped.root != to_scoped.root {
        return Err(AppError::InvalidPath(
            "rename destination must stay inside the same project root".into(),
        ));
    }
    if !from_p.exists() {
        return Err(AppError::InvalidPath(format!("source missing: {from}")));
    }
    if to_p.exists() || std::fs::symlink_metadata(&to_p).is_ok() {
        return Err(AppError::InvalidPath(format!("destination exists: {to}")));
    }
    std::fs::rename(&from_scoped.requested, &to_scoped.requested)?;
    Ok(())
}

#[tauri::command]
pub fn fs_trash(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let scope = FsScope::from_state(state.inner());
    fs_trash_scoped(&scope, path)
}

fn fs_trash_scoped(scope: &FsScope, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let scoped = scope.authorize_existing(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    move_to_trash(&scoped.requested)?;
    Ok(())
}

#[tauri::command]
pub fn fs_reveal(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let scope = FsScope::from_state(state.inner());
    fs_reveal_scoped(&scope, path)
}

fn fs_reveal_scoped(scope: &FsScope, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let scoped = scope.authorize_existing(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&scoped.requested)
            .spawn()
            .map_err(|e| AppError::Other(format!("open failed: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(scoped.requested.parent().unwrap_or(&scoped.requested))
            .spawn()
            .map_err(|e| AppError::Other(format!("xdg-open failed: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&scoped.requested)
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
pub fn fs_open_default(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let scope = FsScope::from_state(state.inner());
    fs_open_default_scoped(&scope, path)
}

fn fs_open_default_scoped(scope: &FsScope, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let scoped = scope.authorize_existing(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    tauri_plugin_opener::open_path(&scoped.resolved, None::<&str>)
        .map_err(|e| AppError::Other(format!("open failed: {e}")))?;
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
    state: State<'_, AppState>,
    repo_root: String,
    status_limit: Option<u32>,
) -> AppResult<GitStatusResult> {
    let scope = FsScope::from_state(state.inner());
    let root = scope.authorize_existing(Path::new(&repo_root))?.resolved;
    fs_git_status_with_limit(root.to_string_lossy().into_owned(), status_limit)
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

    // Count valid-path entries first so `huge` reflects what the frontend
    // can actually see — libgit2 occasionally emits pathless entries for
    // renames/conflicts which we skip below, and we don't want them to
    // inflate the count past the truncation threshold.
    let limit_usize = limit as usize;
    let valid_total = statuses.iter().filter(|e| e.path().is_some()).count();
    let huge = valid_total > limit_usize;
    let mut out: HashMap<String, GitStatusEntry> =
        HashMap::with_capacity(valid_total.min(limit_usize));
    for entry in statuses.iter() {
        if out.len() >= limit_usize {
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
    state: State<'_, AppState>,
    repo_root: String,
    entries: Vec<GitDiffStatsRequest>,
) -> AppResult<HashMap<String, GitDiffStatsEntry>> {
    let scope = FsScope::from_state(state.inner());
    fs_git_diff_stats_scoped(&scope, repo_root, entries)
}

fn fs_git_diff_stats_scoped(
    scope: &FsScope,
    repo_root: String,
    entries: Vec<GitDiffStatsRequest>,
) -> AppResult<HashMap<String, GitDiffStatsEntry>> {
    if entries.len() > MAX_DIFF_STAT_PATHS {
        return Err(AppError::Other(format!(
            "diff stat path limit exceeded (maximum {MAX_DIFF_STAT_PATHS})"
        )));
    }
    let root = scope.authorize_existing(Path::new(&repo_root))?.resolved;
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
        let scoped = match scope.authorize_existing_or_missing(&path) {
            Ok(path) => path,
            Err(err) => {
                tracing::debug!(
                    path = %entry.path,
                    error = %err,
                    "skipping diff stats path outside filesystem scope"
                );
                continue;
            }
        };
        let Ok(rel_path) = scoped.resolved.strip_prefix(&workdir) else {
            continue;
        };
        let rel = rel_path.to_string_lossy().into_owned();
        let abs = scoped.requested.to_string_lossy().into_owned();
        match entry.kind.as_str() {
            "added" => added.push((abs, scoped.resolved)),
            "deleted" => deleted.push((abs, rel)),
            _ => diffable.push((abs, rel)),
        }
    }

    let mut out: HashMap<String, GitDiffStatsEntry> =
        HashMap::with_capacity(added.len() + deleted.len() + diffable.len());

    // Untracked / freshly-added: line count of the working-tree file.
    for (abs, path) in added {
        let additions = count_file_lines_bounded(&path).ok_or_else(|| {
            AppError::Other(format!(
                "diff stats unavailable for oversized or unreadable file: {}",
                path.display()
            ))
        })?;
        out.insert(
            abs,
            GitDiffStatsEntry {
                additions,
                deletions: 0,
            },
        );
    }

    // Deleted: line count of the HEAD blob.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    for (abs, rel) in deleted {
        let deletions = head_tree
            .as_ref()
            .and_then(|t| t.get_path(Path::new(&rel)).ok())
            .and_then(|e| count_blob_lines_bounded(&repo, e.id()))
            .ok_or_else(|| {
                AppError::Other(format!(
                    "diff stats unavailable for oversized or unreadable blob: {rel}"
                ))
            })?;
        out.insert(
            abs,
            GitDiffStatsEntry {
                additions: 0,
                deletions,
            },
        );
    }

    // Modified / renamed / conflicted: one diff scoped to every diffable
    // pathspec, fan out via `foreach` line callbacks per delta path.
    if !diffable.is_empty() {
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(false)
            .disable_pathspec_match(true)
            .max_size(MAX_DIFF_STAT_FILE_BYTES as i64);
        for (_, rel) in &diffable {
            opts.pathspec(rel);
        }
        match repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)) {
            Ok(diff) => {
                let per_path: RefCell<HashMap<String, (u32, u32)>> = RefCell::new(HashMap::new());
                let current_path: RefCell<Option<String>> = RefCell::new(None);
                let mut callback_lines = 0u32;
                let mut limit_hit = false;
                let foreach_result = diff.foreach(
                    &mut |delta, _progress| {
                        let rel = delta
                            .new_file()
                            .path()
                            .or_else(|| delta.old_file().path())
                            .and_then(|path| path.to_str())
                            .filter(|path| !path.is_empty())
                            .map(str::to_owned);
                        if let Some(rel) = &rel {
                            per_path.borrow_mut().entry(rel.clone()).or_default();
                        }
                        *current_path.borrow_mut() = rel;
                        true
                    },
                    None,
                    None,
                    Some(&mut |_delta, _hunk, line| {
                        callback_lines = callback_lines.saturating_add(1);
                        if callback_lines > MAX_DIFF_STAT_CALLBACK_LINES {
                            limit_hit = true;
                            return false;
                        }
                        let current_path = current_path.borrow();
                        let Some(rel) = current_path.as_deref() else {
                            return true;
                        };
                        let mut counts = per_path.borrow_mut();
                        let Some(entry) = counts.get_mut(rel) else {
                            return true;
                        };
                        let changed_line = matches!(line.origin(), '+' | '-');
                        if changed_line && entry.0.saturating_add(entry.1) >= MAX_DIFF_STAT_LINES {
                            limit_hit = true;
                            return false;
                        } else {
                            match line.origin() {
                                '+' => entry.0 = entry.0.saturating_add(1),
                                '-' => entry.1 = entry.1.saturating_add(1),
                                _ => {}
                            }
                        }
                        true
                    }),
                );
                if limit_hit {
                    return Err(AppError::Other(format!(
                        "diff stat line limit exceeded (maximum {MAX_DIFF_STAT_LINES} per file, {MAX_DIFF_STAT_CALLBACK_LINES} total callbacks)"
                    )));
                }
                if let Err(err) = foreach_result {
                    return Err(err.into());
                }
                let per_path = per_path.into_inner();
                for (abs, rel) in diffable {
                    let (a, d) = per_path.get(&rel).copied().unwrap_or((0, 0));
                    out.insert(
                        abs,
                        GitDiffStatsEntry {
                            additions: a,
                            deletions: d,
                        },
                    );
                }
            }
            Err(err) => {
                return Err(err.into());
            }
        }
    }

    Ok(out)
}

fn count_file_lines_bounded(path: &Path) -> Option<u32> {
    let link_meta = std::fs::symlink_metadata(path).ok()?;
    if link_meta.file_type().is_symlink()
        || !link_meta.is_file()
        || link_meta.len() > MAX_DIFF_STAT_FILE_BYTES
    {
        return None;
    }

    let file = File::open(path).ok()?;
    let open_meta = file.metadata().ok()?;
    if !open_meta.is_file() || open_meta.len() > MAX_DIFF_STAT_FILE_BYTES {
        return None;
    }
    count_lines_bounded(file, MAX_DIFF_STAT_FILE_BYTES, MAX_DIFF_STAT_LINES)
        .ok()
        .flatten()
}

fn count_blob_lines_bounded(repo: &Repository, oid: git2::Oid) -> Option<u32> {
    // Inspect the object header before `find_blob` asks libgit2 to materialize
    // the blob contents.
    let odb = repo.odb().ok()?;
    let (size, kind) = odb.read_header(oid).ok()?;
    if kind != git2::ObjectType::Blob || u64::try_from(size).ok()? > MAX_DIFF_STAT_FILE_BYTES {
        return None;
    }
    let blob = repo.find_blob(oid).ok()?;
    if u64::try_from(blob.content().len()).ok()? > MAX_DIFF_STAT_FILE_BYTES {
        return None;
    }
    count_lines_bounded(
        blob.content(),
        MAX_DIFF_STAT_FILE_BYTES,
        MAX_DIFF_STAT_LINES,
    )
    .ok()
    .flatten()
}

fn count_lines_bounded<R: Read>(
    reader: R,
    max_bytes: u64,
    max_lines: u32,
) -> std::io::Result<Option<u32>> {
    let mut reader = reader.take(max_bytes.saturating_add(1));
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes_read = 0u64;
    let mut line_count = 0u32;
    let mut saw_bytes = false;
    let mut last_was_newline = false;

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(read as u64);
        if bytes_read > max_bytes {
            return Ok(None);
        }
        saw_bytes = true;
        last_was_newline = buffer[read - 1] == b'\n';
        let newlines = buffer[..read].iter().filter(|&&byte| byte == b'\n').count() as u32;
        let Some(next_count) = line_count.checked_add(newlines) else {
            return Ok(None);
        };
        if next_count > max_lines {
            return Ok(None);
        }
        line_count = next_count;
    }

    if saw_bytes && !last_was_newline {
        let Some(next_count) = line_count.checked_add(1) else {
            return Ok(None);
        };
        if next_count > max_lines {
            return Ok(None);
        }
        line_count = next_count;
    }

    Ok(Some(line_count))
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

#[derive(Debug, Clone, Serialize)]
pub struct PrepareAssetResult {
    pub size: u64,
}

const VIEWER_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn fs_grant_external_file(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    let resolved = p.canonicalize().map_err(AppError::from)?;
    if !resolved.is_file() {
        return Err(AppError::InvalidPath(format!("not a file: {path}")));
    }
    let mut grants = state.external_file_grants.lock();
    if !grants.iter().any(|granted| granted == &resolved) {
        grants.push(resolved);
    }
    Ok(())
}

#[tauri::command]
pub fn fs_file_exists(state: State<'_, AppState>, path: String) -> AppResult<bool> {
    let scope = FsScope::from_state(state.inner());
    fs_file_exists_scoped(&scope, path)
}

fn fs_file_exists_scoped(scope: &FsScope, path: String) -> AppResult<bool> {
    let p = PathBuf::from(&path);
    scope.authorize_existing_or_missing(&p)?;
    Ok(p.is_file())
}

#[tauri::command]
pub fn fs_read_file(state: State<'_, AppState>, path: String) -> AppResult<ReadFileResult> {
    let scope = FsScope::from_state(state.inner());
    fs_read_file_scoped(&scope, path)
}

#[tauri::command]
pub fn fs_prepare_asset<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<PrepareAssetResult> {
    let scope = FsScope::from_state(state.inner());
    fs_prepare_asset_scoped(&scope, app, path)
}

fn fs_prepare_asset_scoped<R: Runtime>(
    scope: &FsScope,
    app: AppHandle<R>,
    path: String,
) -> AppResult<PrepareAssetResult> {
    let p = PathBuf::from(&path);
    let scoped = scope.authorize_existing(&p)?;
    if !scoped.resolved.is_file() {
        return Err(AppError::InvalidPath(format!("not a file: {path}")));
    }
    validate_embeddable_asset(&scoped.requested, &scoped.resolved)?;
    let meta = std::fs::metadata(&scoped.resolved)?;
    app.asset_protocol_scope()
        .allow_file(&scoped.resolved)
        .map_err(|e| AppError::Other(format!("asset scope failed: {e}")))?;
    Ok(PrepareAssetResult { size: meta.len() })
}

fn validate_embeddable_asset(requested_path: &Path, resolved_path: &Path) -> AppResult<()> {
    // The frontend chooses its renderer from the requested filename, so a
    // symlink must not change whether the backend enforces PDF validation.
    let is_pdf = requested_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Ok(());
    }

    use std::io::Read;
    let mut header = [0u8; 5];
    let bytes_read = std::fs::File::open(resolved_path)?.read(&mut header)?;
    if bytes_read != header.len() || header != *b"%PDF-" {
        return Err(AppError::InvalidPath(
            "refusing to embed a file with an invalid PDF header".into(),
        ));
    }
    Ok(())
}

fn fs_read_file_scoped(scope: &FsScope, path: String) -> AppResult<ReadFileResult> {
    let p = PathBuf::from(&path);
    let scoped = scope.authorize_existing(&p)?;
    if !scoped.resolved.is_file() {
        return Err(AppError::InvalidPath(format!("not a file: {path}")));
    }
    let meta = std::fs::metadata(&scoped.resolved)?;
    let size = meta.len();
    let mut probe = vec![0u8; 4096.min(size as usize)];
    use std::io::Read;
    let mut file = std::fs::File::open(&scoped.resolved)?;
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
    let file = std::fs::File::open(&scoped.resolved)?;
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
pub fn fs_git_diff_lines(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Vec<LineDiffEntry>> {
    let scope = FsScope::from_state(state.inner());
    fs_git_diff_lines_scoped(&scope, path)
}

fn fs_git_diff_lines_scoped(scope: &FsScope, path: String) -> AppResult<Vec<LineDiffEntry>> {
    let target = PathBuf::from(&path);
    let scoped = scope.authorize_existing(&target)?;
    let target = scoped.resolved;
    let target_metadata = std::fs::metadata(&target)?;
    if !target_metadata.is_file() {
        return Ok(Vec::new());
    }
    if target_metadata.len() > MAX_DIFF_STAT_FILE_BYTES {
        return Err(AppError::Other(format!(
            "diff line byte limit exceeded for {} (maximum {MAX_DIFF_STAT_FILE_BYTES} bytes)",
            target.display()
        )));
    }
    let repo = match Repository::discover(&target) {
        Ok(r) => r,
        Err(err) if err.code() == git2::ErrorCode::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
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
    opts.pathspec(&rel)
        .disable_pathspec_match(true)
        .context_lines(0)
        .include_untracked(true)
        .recurse_untracked_dirs(false)
        .max_size(MAX_DIFF_STAT_FILE_BYTES as i64);
    let tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(err)
            if matches!(
                err.code(),
                git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch
            ) =>
        {
            None
        }
        Err(err) => return Err(err.into()),
    };
    let diff = repo.diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut opts))?;
    if diff.deltas().any(|delta| {
        delta.old_file().size() > MAX_DIFF_STAT_FILE_BYTES
            || delta.new_file().size() > MAX_DIFF_STAT_FILE_BYTES
    }) {
        return Err(AppError::Other(format!(
            "diff line byte limit exceeded for {} (maximum {MAX_DIFF_STAT_FILE_BYTES} bytes)",
            target.display()
        )));
    }

    let mut adds: Vec<u32> = Vec::new();
    let mut dels = std::collections::HashSet::new();
    let mut callback_lines = 0u32;
    let mut changed_lines = 0u32;
    let mut limit_hit = false;
    let print_result = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        callback_lines = callback_lines.saturating_add(1);
        if callback_lines > MAX_DIFF_STAT_CALLBACK_LINES {
            limit_hit = true;
            return false;
        }

        if matches!(line.origin(), '+' | '-') {
            if changed_lines >= MAX_DIFF_STAT_LINES {
                limit_hit = true;
                return false;
            }
            changed_lines = changed_lines.saturating_add(1);
        }

        match line.origin() {
            '+' => {
                if let Some(n) = line.new_lineno() {
                    adds.push(n);
                }
            }
            '-' => {
                if let Some(n) = line.old_lineno() {
                    dels.insert(n);
                }
            }
            _ => {}
        }
        true
    });
    if limit_hit {
        return Err(AppError::Other(format!(
            "diff line limit exceeded (maximum {MAX_DIFF_STAT_LINES} changed lines, {MAX_DIFF_STAT_CALLBACK_LINES} total callbacks)"
        )));
    }
    print_result?;

    // Classify: a deleted-only hunk shows as a "deleted" anchor on the
    // line immediately AFTER the deletion; an added line that follows
    // a deletion in the same hunk shows as "modified"; pure additions
    // show as "added".
    let mut out = Vec::with_capacity(adds.len().saturating_add(1));
    for n in adds.iter().copied() {
        // Heuristic: if the prior new-line was a deletion anchor or a
        // contiguous addition started at n, mark as modified vs added.
        // We classify all adds as `added` here; the frontend collapses
        // the visual to a single bar so the distinction is cosmetic.
        let kind = if dels.contains(&n) {
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
    Ok(out)
}

/// Return the current branch name (or short HEAD oid when detached) of
/// the repo enclosing `repo_root`. Empty string when the path is not a
/// git repo — frontend then hides the branch chip.
#[tauri::command]
pub fn fs_git_branch(state: State<'_, AppState>, repo_root: String) -> AppResult<String> {
    let scope = FsScope::from_state(state.inner());
    let root = scope.authorize_existing(Path::new(&repo_root))?.resolved;
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
        let scope = FsScope::from_state(state.inner());
        let root = scope.authorize_existing(Path::new(p))?.resolved;
        if !root.is_dir() {
            return Err(AppError::InvalidPath(format!("not a directory: {p}")));
        }
        if let Some(existing) = guard.as_ref() {
            if existing.root == root {
                return Ok(());
            }
        }
        let (tx, rx) = mpsc::sync_channel(WATCH_QUEUE_CAPACITY);
        let queue_overflowed = Arc::new(AtomicBool::new(false));
        let batcher =
            spawn_watch_batcher(app.clone(), root.clone(), rx, Arc::clone(&queue_overflowed));
        let tx_for_cb = tx.clone();
        let overflow_for_cb = Arc::clone(&queue_overflowed);
        drop(tx);
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
            try_enqueue_watch_result(&tx_for_cb, &overflow_for_cb, res);
        })
        .map_err(|e| AppError::Other(format!("notify init failed: {e}")))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| AppError::Other(format!("notify watch failed: {e}")))?;
        // Backend type name surfaces FSEvents vs inotify vs ReadDirectoryChangesW
        // vs PollWatcher in traces — support diagnostics can tell which path
        // notify picked at runtime without having to reproduce locally.
        tracing::info!(
            root = %root.display(),
            backend = std::any::type_name::<RecommendedWatcher>(),
            "fs watcher attached"
        );
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
    queue_overflowed: Arc<AtomicBool>,
) -> WatchBatcher {
    let thread = std::thread::spawn(move || run_watch_batcher(app, root, rx, queue_overflowed));
    WatchBatcher { _thread: thread }
}

fn try_enqueue_watch_result(
    tx: &SyncSender<notify::Result<Event>>,
    queue_overflowed: &AtomicBool,
    result: notify::Result<Event>,
) {
    match tx.try_send(result) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            queue_overflowed.store(true, AtomicOrdering::Release);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

fn run_watch_batcher<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    rx: Receiver<notify::Result<Event>>,
    queue_overflowed: Arc<AtomicBool>,
) {
    let mut last_emit: Option<Instant> = None;
    let mut supervisor = SupervisorState::default();
    loop {
        let first = match rx.recv() {
            Ok(res) => res,
            Err(_) => break,
        };
        let mut batch = WatchBatch::new(&root, Arc::new(WatchIgnoreMatcher::with_defaults(&[])));
        ingest_result(&mut batch, first, &mut supervisor);

        let deadline = Instant::now() + WATCH_BATCH_WINDOW;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline.saturating_duration_since(now)) {
                Ok(res) => ingest_result(&mut batch, res, &mut supervisor),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        apply_watch_queue_overflow(&mut batch, &queue_overflowed);

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

fn apply_watch_queue_overflow(batch: &mut WatchBatch, queue_overflowed: &AtomicBool) -> bool {
    if !queue_overflowed.swap(false, AtomicOrdering::AcqRel) {
        return false;
    }
    batch.request_root_refresh();
    true
}

fn throttle_delay(last_emit: Option<Instant>, now: Instant) -> Duration {
    let Some(last) = last_emit else {
        return Duration::ZERO;
    };
    let elapsed = now.saturating_duration_since(last);
    WATCH_THROTTLE_GAP.saturating_sub(elapsed)
}

/// Funnel a single notify result into the batch, classifying any error via
/// the supervisor state machine before swallowing it. ENOSPC is logged once
/// at warn level; transient and unknown errors get their own trace levels so
/// log grepping can distinguish "self-heals on next event" from "watcher is
/// drifting toward give-up".
fn ingest_result(
    batch: &mut WatchBatch,
    res: notify::Result<Event>,
    supervisor: &mut SupervisorState,
) {
    match res {
        Ok(event) => batch.add_event(event),
        Err(err) => {
            let msg = err.to_string();
            match handle_supervisor_error(&msg, supervisor) {
                SupervisorAction::NoOp => {
                    tracing::debug!(error = %msg, "fs watch error (suppressed)");
                }
                SupervisorAction::WarnOnce => {
                    tracing::warn!(error = %msg, "fs watcher hit inotify limit (ENOSPC)");
                }
                SupervisorAction::Restart { .. } => {
                    tracing::warn!(error = %msg, "fs watcher error (restart deferred to follow-up)");
                }
                SupervisorAction::Suspend => {
                    tracing::warn!(error = %msg, "fs watcher root missing (suspend deferred to follow-up)");
                }
                SupervisorAction::GiveUp => {
                    tracing::error!(error = %msg, "fs watcher exceeded restart budget");
                }
            }
        }
    }
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
    dotgit_changed: bool,
}

impl WatchBatch {
    fn new(root: &Path, ignore: Arc<WatchIgnoreMatcher>) -> Self {
        Self {
            root: root.to_path_buf(),
            seen: HashMap::new(),
            common_ancestor: None,
            overflow: false,
            ignore,
            dotgit_changed: false,
        }
    }

    fn add_event(&mut self, event: Event) {
        if event.need_rescan() {
            self.request_root_refresh();
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
            match classify_watch_path(&path, &self.root) {
                WatchPathClass::Drop => continue,
                WatchPathClass::DotGit => {
                    self.dotgit_changed = true;
                    continue;
                }
                WatchPathClass::WorkingTree => {}
            }
            if self.ignore.is_ignored(&path, &self.root) {
                continue;
            }
            self.add_path(path, kind);
        }
    }

    fn request_root_refresh(&mut self) {
        self.seen.clear();
        self.seen.insert(self.root.clone(), BatchedKind::Updated);
        self.common_ancestor = Some(self.root.clone());
        self.overflow = true;
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
        if self.seen.is_empty() && !self.overflow && !self.dotgit_changed {
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
            dotgit_changed: self.dotgit_changed,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchPathClass {
    /// Pure noise — drop the event entirely.
    Drop,
    /// Lives under `<root>/.git/` and survives the noise filter.
    DotGit,
    /// Ordinary working-tree path.
    WorkingTree,
}

/// Classify a watch event path. Mirrors VSCode's git extension regex at
/// repository.ts:470 — drop `.git/index.lock`, `.git/worktrees/*/index.lock`,
/// and `.watchman-cookie-*`; mark anything else inside `<root>/.git/` so the
/// frontend can drive git status without invalidating working-tree caches.
pub fn classify_watch_path(path: &Path, root: &Path) -> WatchPathClass {
    let Ok(rel) = path.strip_prefix(root) else {
        return WatchPathClass::Drop;
    };
    if let Some(name) = rel.file_name().and_then(|n| n.to_str()) {
        if name.starts_with(".watchman-cookie-") {
            return WatchPathClass::Drop;
        }
    }
    let mut components = rel.components();
    let first = match components.next() {
        Some(Component::Normal(c)) => c.to_str(),
        _ => return WatchPathClass::WorkingTree,
    };
    if first != Some(".git") {
        return WatchPathClass::WorkingTree;
    }
    if let Some(name) = rel.file_name().and_then(|n| n.to_str()) {
        if name == "index.lock" {
            return WatchPathClass::Drop;
        }
    }
    WatchPathClass::DotGit
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
    use acorn_session::{Session, SessionKind};
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use std::fs;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn scope_for(root: &Path) -> FsScope {
        FsScope::from_roots([root.to_path_buf()])
    }

    fn test_session(repo: &Path, worktree: &Path, project_scoped: bool) -> Session {
        let mut session = Session::new(
            "test".to_string(),
            repo.to_path_buf(),
            worktree.to_path_buf(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.project_scoped = project_scoped;
        session
    }

    fn init_repo_with_tracked_file(path: &Path) -> git2::Repository {
        let repo = git2::Repository::init(path).unwrap();
        fs::write(path.join("tracked.txt"), b"initial").unwrap();
        let sig = git2::Signature::now("acorn-test", "test@acorn").unwrap();
        let tree_id = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("tracked.txt")).unwrap();
            index.write_tree().unwrap()
        };
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        drop(tree);
        repo
    }

    fn commit_paths(repo: &git2::Repository, paths: &[&str]) {
        let sig = git2::Signature::now("acorn-test", "test@acorn").unwrap();
        let mut index = repo.index().unwrap();
        for path in paths {
            index.add_path(Path::new(path)).unwrap();
        }
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "commit", &tree, &[])
            .unwrap();
    }

    #[test]
    fn scope_from_state_ignores_local_session_roots() {
        let state = AppState::new();
        let local = tmpdir();
        state
            .sessions
            .insert(test_session(local.path(), local.path(), false));

        let scope = FsScope::from_state(&state);

        assert!(scope.roots.is_empty());
    }

    #[test]
    fn scope_from_state_requires_registered_project_for_session_worktree() {
        let state = AppState::new();
        let repo = tmpdir();
        let worktree = tmpdir();
        state
            .sessions
            .insert(test_session(repo.path(), worktree.path(), true));

        let scope = FsScope::from_state(&state);

        assert!(scope.roots.is_empty());
    }

    #[test]
    fn scope_from_state_includes_registered_project_and_project_worktree() {
        let state = AppState::new();
        let repo = tmpdir();
        let worktree = tmpdir();
        state
            .projects
            .ensure(repo.path().to_path_buf(), "repo".to_string());
        state
            .sessions
            .insert(test_session(repo.path(), worktree.path(), true));

        let scope = FsScope::from_state(&state);
        let roots = scope.roots;

        assert!(roots.contains(&repo.path().canonicalize().unwrap()));
        assert!(roots.contains(&worktree.path().canonicalize().unwrap()));
    }

    #[test]
    fn scope_from_state_includes_registered_project_linked_worktrees() {
        let state = AppState::new();
        let repo_dir = tmpdir();
        let linked_parent = tmpdir();
        let linked_worktree = linked_parent.path().join("PR532");
        let repo = init_repo_with_tracked_file(repo_dir.path());
        repo.worktree("PR532", &linked_worktree, None).unwrap();
        state
            .projects
            .ensure(repo_dir.path().to_path_buf(), "repo".to_string());

        let scope = FsScope::from_state(&state);
        let roots = scope.roots;

        assert!(roots.contains(&repo_dir.path().canonicalize().unwrap()));
        assert!(roots.contains(&linked_worktree.canonicalize().unwrap()));
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

        let scope = scope_for(d.path());
        let res = fs_list_dir_scoped(
            &scope,
            d.path().to_string_lossy().into_owned(),
            false,
            false,
        )
        .unwrap();
        let names: Vec<_> = res.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["Alpha", "middle", "apple.txt", "zebra.txt"]);
    }

    #[test]
    fn rejects_directories_over_the_entry_budget() {
        let d = tmpdir();
        fs::write(d.path().join("one.txt"), b"").unwrap();
        fs::write(d.path().join("two.txt"), b"").unwrap();
        fs::write(d.path().join("three.txt"), b"").unwrap();

        let scope = scope_for(d.path());
        let err = fs_list_dir_scoped_with_limit(
            &scope,
            d.path().to_string_lossy().into_owned(),
            false,
            false,
            2,
        )
        .unwrap_err();

        assert!(err.to_string().contains("more than 2 entries"));
    }

    #[test]
    fn hides_dotfiles_by_default() {
        let d = tmpdir();
        fs::write(d.path().join(".env"), b"").unwrap();
        fs::write(d.path().join("visible.txt"), b"").unwrap();

        let scope = scope_for(d.path());
        let hidden_off = fs_list_dir_scoped(
            &scope,
            d.path().to_string_lossy().into_owned(),
            false,
            false,
        )
        .unwrap();
        assert_eq!(hidden_off.entries.len(), 1);
        let hidden_on =
            fs_list_dir_scoped(&scope, d.path().to_string_lossy().into_owned(), true, false)
                .unwrap();
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

        let scope = scope_for(d.path());
        let on = fs_list_dir_scoped(&scope, d.path().to_string_lossy().into_owned(), false, true)
            .unwrap();
        let names: Vec<_> = on.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["keep.txt"]);

        let off = fs_list_dir_scoped(
            &scope,
            d.path().to_string_lossy().into_owned(),
            false,
            false,
        )
        .unwrap();
        let off_names: Vec<_> = off.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(off_names, vec!["build", "keep.txt", "secret.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_gitignore_files() {
        use std::os::unix::fs::symlink;

        let d = tmpdir();
        fs::create_dir(d.path().join(".git")).unwrap();
        let outside = tmpdir();
        let outside_ignore = outside.path().join("ignore");
        fs::write(&outside_ignore, b"secret.txt\n").unwrap();
        symlink(&outside_ignore, d.path().join(".gitignore")).unwrap();
        fs::write(d.path().join("secret.txt"), b"").unwrap();

        let scope = scope_for(d.path());
        let result =
            fs_list_dir_scoped(&scope, d.path().to_string_lossy().into_owned(), false, true)
                .unwrap();
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.name == "secret.txt"));
    }

    #[test]
    fn skips_oversized_gitignore_files() {
        let d = tmpdir();
        fs::create_dir(d.path().join(".git")).unwrap();
        let mut oversized = b"secret.txt\n".to_vec();
        oversized.resize(MAX_GITIGNORE_BYTES as usize + 1, b'#');
        fs::write(d.path().join(".gitignore"), oversized).unwrap();
        fs::write(d.path().join("secret.txt"), b"").unwrap();

        let scope = scope_for(d.path());
        let result =
            fs_list_dir_scoped(&scope, d.path().to_string_lossy().into_owned(), false, true)
                .unwrap();
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.name == "secret.txt"));
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
        assert!(payload.dotgit_changed, ".git/index sets the dotgit flag");
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
    fn watch_callback_queue_is_bounded_and_coalesces_overflow_to_one_root_refresh() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        let queue_overflowed = AtomicBool::new(false);

        try_enqueue_watch_result(
            &tx,
            &queue_overflowed,
            Ok(create_event(vec![root.join("first.rs")])),
        );
        try_enqueue_watch_result(
            &tx,
            &queue_overflowed,
            Ok(create_event(vec![root.join("dropped.rs")])),
        );

        let queued = rx.try_recv().expect("the first event remains queued");
        assert_eq!(
            queued.expect("queued notify event").paths,
            vec![root.join("first.rs")]
        );
        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(queue_overflowed.load(AtomicOrdering::Acquire));

        let mut batch = new_batch(&root);
        assert!(apply_watch_queue_overflow(&mut batch, &queue_overflowed));
        assert!(!apply_watch_queue_overflow(&mut batch, &queue_overflowed));
        let payload = batch.finish().expect("overflow refresh payload");
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
        let m = WatchIgnoreMatcher::with_defaults(&["out/**".to_string(), "**/*.log".to_string()]);
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

        let res =
            fs_git_status_with_limit(repo_path.to_string_lossy().into_owned(), Some(5)).unwrap();
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
        let res = fs_git_status_with_limit(repo_path.to_string_lossy().into_owned(), Some(10_000))
            .unwrap();
        assert!(!res.huge);
        assert_eq!(res.limit, 10_000);
        assert!(res
            .statuses
            .contains_key(&repo_path.join("a.txt").to_string_lossy().into_owned()));
    }

    #[test]
    fn rename_rejects_traversal_segments() {
        let scope = FsScope::from_roots([PathBuf::from("/tmp")]);
        let res = fs_rename_scoped(&scope, "/tmp/../etc/evil".to_string(), "/tmp/x".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn scope_rejects_file_read_outside_registered_root() {
        let allowed = tmpdir();
        let outside = tmpdir();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, b"secret").unwrap();

        let scope = scope_for(allowed.path());
        let res = fs_read_file_scoped(&scope, outside_file.to_string_lossy().into_owned());

        assert!(res.is_err());
    }

    #[test]
    fn scope_allows_granted_external_file_read_outside_registered_root() {
        let allowed = tmpdir();
        let outside = tmpdir();
        let outside_file = outside.path().join("note.txt");
        fs::write(&outside_file, b"hello").unwrap();
        let outside_file = outside_file.canonicalize().unwrap();

        let scope = FsScope::from_roots_and_external_files(
            [allowed.path().to_path_buf()],
            [outside_file.clone()],
        );
        let res = fs_read_file_scoped(&scope, outside_file.to_string_lossy().into_owned()).unwrap();

        assert_eq!(res.content, "hello");
    }

    #[test]
    fn embedded_pdf_requires_pdf_magic_bytes() {
        let d = tmpdir();
        let valid = d.path().join("valid.pdf");
        let disguised_html = d.path().join("disguised.pdf");
        fs::write(&valid, b"%PDF-1.7\n").unwrap();
        fs::write(&disguised_html, b"<html><script></script></html>").unwrap();

        assert!(validate_embeddable_asset(&valid, &valid).is_ok());
        assert!(validate_embeddable_asset(&disguised_html, &disguised_html).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn embedded_pdf_symlink_validates_requested_extension() {
        use std::os::unix::fs::symlink;

        let d = tmpdir();
        let html = d.path().join("payload.html");
        let pdf_link = d.path().join("preview.pdf");
        fs::write(&html, b"<html><script></script></html>").unwrap();
        symlink(&html, &pdf_link).unwrap();

        assert!(validate_embeddable_asset(&pdf_link, &html).is_err());
    }

    #[test]
    fn embedded_non_pdf_asset_is_unchanged() {
        let d = tmpdir();
        let image = d.path().join("image.png");
        fs::write(&image, b"not checked here").unwrap();

        assert!(validate_embeddable_asset(&image, &image).is_ok());
    }

    #[test]
    fn scope_rejects_rename_destination_outside_registered_root() {
        let allowed = tmpdir();
        let outside = tmpdir();
        let source = allowed.path().join("a.txt");
        let target = outside.path().join("a.txt");
        fs::write(&source, b"hi").unwrap();

        let scope = scope_for(allowed.path());
        let res = fs_rename_scoped(
            &scope,
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        );

        assert!(res.is_err());
        assert!(source.exists());
        assert!(!target.exists());
    }

    #[test]
    fn fs_file_exists_only_accepts_files() {
        let d = tmpdir();
        let file = d.path().join("a.txt");
        let dir = d.path().join("folder");
        fs::write(&file, b"hi").unwrap();
        fs::create_dir(&dir).unwrap();
        let scope = scope_for(d.path());

        assert!(fs_file_exists_scoped(&scope, file.to_string_lossy().into_owned()).unwrap());
        assert!(!fs_file_exists_scoped(&scope, dir.to_string_lossy().into_owned()).unwrap());
        assert!(!fs_file_exists_scoped(
            &scope,
            d.path().join("missing.txt").to_string_lossy().into_owned()
        )
        .unwrap());
    }

    #[test]
    fn rename_file_roundtrip() {
        let d = tmpdir();
        let a = d.path().join("a.txt");
        let b = d.path().join("b.txt");
        std::fs::write(&a, b"hi").unwrap();
        let scope = scope_for(d.path());
        fs_rename_scoped(
            &scope,
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
        assert_eq!(
            decide(&state, ErrorClass::Unknown),
            SupervisorAction::GiveUp
        );
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
        assert_eq!(
            decide(&state, ErrorClass::Enospc),
            SupervisorAction::WarnOnce
        );
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
    fn handle_supervisor_error_records_enospc_dedup() {
        // Locks down the mutation side-effect of handle_supervisor_error
        // so a regression that drops the state.record_enospc_logged() call
        // is caught directly instead of only through the existing
        // decide()-only tests.
        let mut state = SupervisorState::default();
        assert_eq!(
            handle_supervisor_error("No space left on device", &mut state),
            SupervisorAction::WarnOnce,
        );
        assert_eq!(
            handle_supervisor_error("No space left on device", &mut state),
            SupervisorAction::NoOp,
        );
    }

    #[test]
    fn handle_supervisor_error_records_restart_increment() {
        let mut state = SupervisorState::default();
        let first = handle_supervisor_error("boom", &mut state);
        let second = handle_supervisor_error("boom", &mut state);
        assert_eq!(
            first,
            SupervisorAction::Restart {
                delay: Duration::from_millis(800)
            }
        );
        assert_eq!(
            second,
            SupervisorAction::Restart {
                delay: Duration::from_millis(1_600)
            }
        );
    }

    #[test]
    fn classify_drops_index_lock_files() {
        let root = Path::new("/r");
        assert_eq!(
            classify_watch_path(&root.join(".git/index.lock"), root),
            WatchPathClass::Drop,
        );
        assert_eq!(
            classify_watch_path(&root.join(".git/worktrees/wt-a/index.lock"), root),
            WatchPathClass::Drop,
        );
        assert_eq!(
            classify_watch_path(&root.join("src/.watchman-cookie-1234"), root),
            WatchPathClass::Drop,
        );
    }

    #[test]
    fn classify_treats_dotgit_paths_as_dotgit() {
        let root = Path::new("/r");
        assert_eq!(
            classify_watch_path(&root.join(".git/index"), root),
            WatchPathClass::DotGit,
        );
        assert_eq!(
            classify_watch_path(&root.join(".git/HEAD"), root),
            WatchPathClass::DotGit,
        );
        assert_eq!(
            classify_watch_path(&root.join(".git/refs/heads/main"), root),
            WatchPathClass::DotGit,
        );
    }

    #[test]
    fn classify_keeps_working_tree_paths() {
        let root = Path::new("/r");
        assert_eq!(
            classify_watch_path(&root.join("src/main.rs"), root),
            WatchPathClass::WorkingTree,
        );
    }

    #[test]
    fn watch_batch_sets_dotgit_flag_and_omits_path_from_paths_list() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = new_batch(&root);
        batch.add_event(create_event(vec![
            root.join("src/main.rs"),
            root.join(".git/index"),
            root.join(".git/index.lock"),
        ]));
        let payload = batch.finish().expect("payload");
        assert_eq!(
            payload.paths,
            vec![root.join("src/main.rs").to_string_lossy().into_owned()]
        );
        assert!(payload.dotgit_changed);
    }

    #[test]
    fn watch_batch_does_not_set_dotgit_flag_when_only_noise_seen() {
        let d = tmpdir();
        let root = d.path().canonicalize().unwrap();
        let mut batch = new_batch(&root);
        batch.add_event(create_event(vec![root.join(".git/index.lock")]));
        assert!(
            batch.finish().is_none(),
            "noise-only batch produces no payload"
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
        assert!(
            batch.finish().is_none(),
            "create+delete must net to nothing"
        );
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
        batch.add_event(remove_event(vec![
            parent.join("inside.txt"),
            parent.clone(),
        ]));
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
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }

        // Purely additive: insert 3 new lines between "2" and "3".
        fs::write(repo_path.join("a.rs"), "1\n2\nNEW1\nNEW2\nNEW3\n3\n4\n5\n").unwrap();

        let entries = vec![GitDiffStatsRequest {
            path: repo_path.join("a.rs").to_string_lossy().into_owned(),
            kind: "modified".to_string(),
        }];
        let scope = scope_for(&repo_path);
        let stats =
            fs_git_diff_stats_scoped(&scope, repo_path.to_string_lossy().into_owned(), entries)
                .unwrap();
        let entry = stats.values().next().expect("one entry");
        assert_eq!(entry.additions, 3);
        assert_eq!(entry.deletions, 0);
    }

    #[test]
    fn bounded_line_counter_enforces_byte_and_line_limits() {
        assert_eq!(
            count_lines_bounded(std::io::Cursor::new(b"alpha\nbeta"), 10, 2).unwrap(),
            Some(2)
        );
        assert_eq!(
            count_lines_bounded(std::io::Cursor::new(Vec::<u8>::new()), 0, 0).unwrap(),
            Some(0)
        );
        assert_eq!(
            count_lines_bounded(std::io::Cursor::new(b"12345"), 4, 10).unwrap(),
            None
        );
        assert_eq!(
            count_lines_bounded(std::io::Cursor::new(b"a\nb\nc\n"), 16, 2).unwrap(),
            None
        );
    }

    #[test]
    fn diff_stats_rejects_oversized_added_files_instead_of_reporting_zero() {
        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        Repository::init(&repo_path).unwrap();
        let oversized = repo_path.join("oversized.txt");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_DIFF_STAT_FILE_BYTES + 1)
            .unwrap();

        let scope = scope_for(&repo_path);
        let error = fs_git_diff_stats_scoped(
            &scope,
            repo_path.to_string_lossy().into_owned(),
            vec![GitDiffStatsRequest {
                path: oversized.to_string_lossy().into_owned(),
                kind: "added".to_string(),
            }],
        )
        .expect_err("oversized file should not look like a zero-line file");

        assert!(error.to_string().contains("diff stats unavailable"));
    }

    #[test]
    fn diff_stats_aborts_when_changed_line_limit_is_exceeded() {
        use git2::Signature;

        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        let repo = Repository::init(&repo_path).unwrap();
        let changed = repo_path.join("many-lines.txt");
        fs::write(&changed, "base\n").unwrap();

        let sig = Signature::now("t", "t@t").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("many-lines.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }

        let mut contents = String::from("base\n");
        contents.push_str(&"added\n".repeat(MAX_DIFF_STAT_LINES as usize + 1));
        fs::write(&changed, contents).unwrap();

        let scope = scope_for(&repo_path);
        let error = fs_git_diff_stats_scoped(
            &scope,
            repo_path.to_string_lossy().into_owned(),
            vec![GitDiffStatsRequest {
                path: changed.to_string_lossy().into_owned(),
                kind: "modified".to_string(),
            }],
        )
        .expect_err("line-heavy diff should stop at the callback budget");

        assert!(error.to_string().contains("diff stat line limit exceeded"));
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
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
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
        let scope = scope_for(&repo_path);
        let stats =
            fs_git_diff_stats_scoped(&scope, repo_path.to_string_lossy().into_owned(), entries)
                .unwrap();
        let x_key = repo_path.join("x.rs").to_string_lossy().into_owned();
        let y_key = repo_path.join("y.rs").to_string_lossy().into_owned();
        assert_eq!(stats[&x_key].additions, 2);
        assert_eq!(stats[&x_key].deletions, 0);
        assert_eq!(stats[&y_key].additions, 0);
        assert_eq!(stats[&y_key].deletions, 1);
    }

    #[test]
    fn diff_lines_returns_markers_for_requested_file() {
        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        let repo = Repository::init(&repo_path).unwrap();
        let changed = repo_path.join("normal.txt");
        fs::write(&changed, "one\ntwo\nthree\n").unwrap();
        commit_paths(&repo, &["normal.txt"]);
        fs::write(&changed, "one\ntwo\nadded\nthree\n").unwrap();

        let scope = scope_for(&repo_path);
        let lines =
            fs_git_diff_lines_scoped(&scope, changed.to_string_lossy().into_owned()).unwrap();
        let markers: Vec<_> = lines
            .iter()
            .map(|entry| (entry.line, entry.kind.as_str()))
            .collect();

        assert_eq!(markers, vec![(3, "added")]);
    }

    #[test]
    fn diff_lines_treats_glob_metacharacters_as_literal_filename() {
        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        let repo = Repository::init(&repo_path).unwrap();
        let target = repo_path.join("literal[ab].txt");
        let glob_match = repo_path.join("literala.txt");
        fs::write(&target, "one\ntwo\n").unwrap();
        fs::write(&glob_match, "one\ntwo\n").unwrap();
        commit_paths(&repo, &["literal[ab].txt", "literala.txt"]);

        fs::write(&target, "one\nchanged\n").unwrap();
        fs::write(&glob_match, "one\ntwo\nunrelated\nlines\n").unwrap();

        let scope = scope_for(&repo_path);
        let lines =
            fs_git_diff_lines_scoped(&scope, target.to_string_lossy().into_owned()).unwrap();
        let markers: Vec<_> = lines
            .iter()
            .map(|entry| (entry.line, entry.kind.as_str()))
            .collect();

        assert_eq!(markers, vec![(2, "modified")]);
    }

    #[test]
    fn diff_lines_aborts_when_changed_line_limit_is_exceeded() {
        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        let repo = Repository::init(&repo_path).unwrap();
        let changed = repo_path.join("many-lines.txt");
        fs::write(&changed, "base\n").unwrap();
        commit_paths(&repo, &["many-lines.txt"]);

        let mut contents = String::from("base\n");
        contents.push_str(&"x\n".repeat(MAX_DIFF_STAT_LINES as usize + 1));
        fs::write(&changed, contents).unwrap();

        let scope = scope_for(&repo_path);
        let error = fs_git_diff_lines_scoped(&scope, changed.to_string_lossy().into_owned())
            .expect_err("line-heavy diff should stop at the changed-line budget");

        assert!(error.to_string().contains("diff line limit exceeded"));
    }

    #[test]
    fn diff_lines_rejects_oversized_worktree_file() {
        let d = tmpdir();
        let repo_path = d.path().canonicalize().unwrap();
        Repository::init(&repo_path).unwrap();
        let oversized = repo_path.join("oversized.txt");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_DIFF_STAT_FILE_BYTES + 1)
            .unwrap();

        let scope = scope_for(&repo_path);
        let error = fs_git_diff_lines_scoped(&scope, oversized.to_string_lossy().into_owned())
            .expect_err("oversized file should stop before diff generation");

        assert!(error.to_string().contains("diff line byte limit exceeded"));
    }
}
