use git2::{DiffOptions, Repository};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::error::{AppError, AppResult};
use crate::worktree::ensure_repo;

// Repositories are untrusted input. These limits bound the local diff payload
// before it is serialized across the Tauri boundary; ordinary source diffs
// remain far below them, while oversized images use the existing no-preview UI.
const MAX_DIFF_TEXT_FILE_BYTES: i64 = 8 * 1024 * 1024;
const MAX_DIFF_FILES: usize = 5_000;
const MAX_DIFF_PATCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_DIFF_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIFF_TOTAL_IMAGE_BYTES: usize = 24 * 1024 * 1024;

// Commit repositories are untrusted too. Pagination and object budgets bound
// the response page, while graph budgets keep pushed classification finite.
const MAX_COMMIT_PAGE_SIZE: usize = 500;
const MAX_COMMIT_OFFSET: usize = 100_000;
const MAX_COMMIT_PAGE_OBJECT_BYTES: usize = 1024 * 1024;
const MAX_COMMIT_PAGE_TOTAL_OBJECT_BYTES: usize = 16 * 1024 * 1024;
const MAX_REMOTE_TRACKING_REFS: usize = 2_048;
const MAX_PUSHED_HISTORY_COMMITS: usize = 250_000;
const MAX_PUSHED_HISTORY_PARENT_EDGES: usize = 1_000_000;
const MAX_PUSHED_HISTORY_COMMIT_OBJECT_BYTES: usize = 1024 * 1024;
const MAX_PUSHED_HISTORY_TOTAL_OBJECT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy)]
struct DiffLimits {
    max_files: usize,
    max_patch_bytes: usize,
    max_image_bytes: usize,
    max_total_image_bytes: usize,
}

const LOCAL_DIFF_LIMITS: DiffLimits = DiffLimits {
    max_files: MAX_DIFF_FILES,
    max_patch_bytes: MAX_DIFF_PATCH_BYTES,
    max_image_bytes: MAX_DIFF_IMAGE_BYTES,
    max_total_image_bytes: MAX_DIFF_TOTAL_IMAGE_BYTES,
};

#[derive(Clone, Copy)]
struct PushedHistoryLimits {
    max_remote_refs: usize,
    max_commits: usize,
    max_parent_edges: usize,
    max_commit_object_bytes: usize,
    max_total_object_bytes: usize,
}

const LOCAL_PUSHED_HISTORY_LIMITS: PushedHistoryLimits = PushedHistoryLimits {
    max_remote_refs: MAX_REMOTE_TRACKING_REFS,
    max_commits: MAX_PUSHED_HISTORY_COMMITS,
    max_parent_edges: MAX_PUSHED_HISTORY_PARENT_EDGES,
    max_commit_object_bytes: MAX_PUSHED_HISTORY_COMMIT_OBJECT_BYTES,
    max_total_object_bytes: MAX_PUSHED_HISTORY_TOTAL_OBJECT_BYTES,
};

#[derive(Clone, Copy)]
struct CommitPageObjectLimits {
    max_object_bytes: usize,
    max_total_object_bytes: usize,
}

const LOCAL_COMMIT_PAGE_OBJECT_LIMITS: CommitPageObjectLimits = CommitPageObjectLimits {
    max_object_bytes: MAX_COMMIT_PAGE_OBJECT_BYTES,
    max_total_object_bytes: MAX_COMMIT_PAGE_TOTAL_OBJECT_BYTES,
};

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Git author email. Surfaced so the UI can resolve a GitHub avatar
    /// (e.g. parse the `users.noreply.github.com` pattern for a login).
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
    /// Commit message body — everything after the first-line headline. Empty
    /// when the commit has no body. Surfaced so the RightPanel commits view
    /// can render the description (with markdown / images) alongside the diff.
    pub body: String,
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StagedFile {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffPayload {
    pub files: Vec<DiffFile>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DiffImages {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_image: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffFile {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub patch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_image: Option<String>,
    pub is_image: bool,
}

/// Resolve an origin remote URL into a GitHub-style web URL pointing at the
/// given commit. Returns `None` when there is no `origin` remote, the URL
/// cannot be parsed, or the host is not recognised as GitHub.
pub fn web_url_for_commit(repo_path: &Path, sha: &str) -> AppResult<Option<String>> {
    let Some(owner_repo) = github_owner_repo(repo_path)? else {
        return Ok(None);
    };
    Ok(Some(format!(
        "https://github.com/{owner_repo}/commit/{sha}"
    )))
}

/// Return the GitHub `owner/repo` slug derived from the repo's `origin`
/// remote, or `None` when there's no origin, the URL is unparseable, or the
/// host isn't GitHub. Reused by features that talk to the GitHub web/API
/// layer (commit URLs, PR listing).
pub fn github_owner_repo(repo_path: &Path) -> AppResult<Option<String>> {
    let repo = ensure_repo(repo_path)?;
    let remote = match repo.find_remote("origin") {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let Some(url) = remote.url() else {
        return Ok(None);
    };
    Ok(parse_github_owner_repo(url))
}

pub fn is_git_repository(repo_path: &Path) -> bool {
    Repository::discover(repo_path).is_ok()
}

fn parse_github_owner_repo(remote: &str) -> Option<String> {
    let trimmed = remote.trim();
    // Pull "host" + "owner/repo[.git]" out of any of the three common URL
    // shapes git uses.
    let (host, path) = if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, rest) = rest.split_once(':')?;
        (host, rest)
    } else if let Some(rest) = trimmed.strip_prefix("ssh://") {
        let after_user = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (host, path) = after_user.split_once('/')?;
        (host, path)
    } else if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
    {
        let after_user = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (host, path) = after_user.split_once('/')?;
        (host, path)
    } else {
        return None;
    };

    if !is_github_host(host) {
        return None;
    }

    let owner_repo = path.trim_start_matches('/').trim_end_matches(".git");
    if owner_repo.is_empty() || !owner_repo.contains('/') {
        return None;
    }
    Some(owner_repo.to_string())
}

/// Test whether `host` ultimately points at github.com.
///
/// Direct match for plain `github.com`. For everything else we resolve via
/// `ssh -G <host>` — multi-identity setups commonly alias github.com in
/// `~/.ssh/config` with blocks like:
///
/// ```text
/// Host github-im-ian
///     HostName github.com
///     IdentityFile ~/.ssh/id_im_ian
/// ```
///
/// which produces remotes such as `git@github-im-ian:org/repo.git`. Without
/// alias resolution we'd reject those as "not GitHub" even though they're
/// just GitHub-with-routing.
fn is_github_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("github.com") {
        return true;
    }
    cached_ssh_hostname(host)
        .map(|real| real.eq_ignore_ascii_case("github.com"))
        .unwrap_or(false)
}

const SSH_HOSTNAME_CACHE_CAPACITY: usize = 64;

struct SshHostnameCache {
    entries: HashMap<String, Option<String>>,
    insertion_order: VecDeque<String>,
    capacity: usize,
}

impl SshHostnameCache {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(capacity),
            insertion_order: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn get(&self, alias: &str) -> Option<&Option<String>> {
        self.entries.get(alias)
    }

    fn insert(&mut self, alias: String, hostname: Option<String>) {
        if self.entries.contains_key(&alias) {
            self.entries.insert(alias, hostname);
            return;
        }
        if self.capacity == 0 {
            return;
        }
        while self.entries.len() >= self.capacity {
            let Some(oldest) = self.insertion_order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.insertion_order.push_back(alias.clone());
        self.entries.insert(alias, hostname);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

fn ssh_hostname_cache() -> &'static Mutex<SshHostnameCache> {
    static CACHE: OnceLock<Mutex<SshHostnameCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SshHostnameCache::with_capacity(SSH_HOSTNAME_CACHE_CAPACITY)))
}

fn cached_ssh_hostname(alias: &str) -> Option<String> {
    if !is_plain_hostname(alias) {
        return None;
    }
    let cache = ssh_hostname_cache();

    // A poisoned lock would otherwise silently skip the cache and re-spawn
    // `ssh -G` on every call; the map itself stays valid, so recover it.
    {
        let map = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(hit) = map.get(alias) {
            return hit.clone();
        }
    }

    let resolved = resolve_ssh_hostname(alias);
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(alias.to_string(), resolved.clone());
    resolved
}

/// Aliases come from git remote URLs, i.e. repo-controlled data. Only pass
/// plain host-shaped strings to `ssh -G`: anything with spaces, globs, or an
/// option-like leading `-` could match an unexpected wildcard `Host` block
/// (whose `ProxyCommand` OpenSSH would then execute) or be parsed as a flag.
fn is_plain_hostname(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 255
        && !alias.starts_with('-')
        && alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn resolve_ssh_hostname(alias: &str) -> Option<String> {
    if !is_plain_hostname(alias) {
        return None;
    }
    let out = std::process::Command::new("ssh")
        .args(["-G", alias])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        // `ssh -G` lowercases keys; the hostname line is exactly:
        //     hostname github.com
        if let Some(rest) = line.strip_prefix("hostname ") {
            let h = rest.trim();
            if !h.is_empty() {
                return Some(h.to_string());
            }
        }
    }
    None
}

pub fn list_commits(repo_path: &Path, offset: usize, limit: usize) -> AppResult<Vec<CommitInfo>> {
    validate_commit_page(offset, limit)?;
    let repo = ensure_repo(repo_path)?;
    if limit == 0 {
        return Ok(Vec::new());
    }

    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TIME)?;

    let mut page_oids = Vec::with_capacity(limit);
    for oid in walk.skip(offset).take(limit) {
        page_oids.push(oid?);
    }
    if page_oids.is_empty() {
        return Ok(Vec::new());
    }

    validate_commit_page_objects(&repo, &page_oids, LOCAL_COMMIT_PAGE_OBJECT_LIMITS)?;
    let pushed_set = pushed_page_oids(&repo, &page_oids, LOCAL_PUSHED_HISTORY_LIMITS)?;
    let mut out = Vec::with_capacity(page_oids.len());
    for oid in page_oids {
        let commit = repo.find_commit(oid)?;
        let author = commit.author();
        out.push(CommitInfo {
            sha: oid.to_string(),
            short_sha: oid.to_string().chars().take(7).collect(),
            author: author.name().unwrap_or("?").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            summary: commit.summary().unwrap_or("").to_string(),
            body: commit.body().unwrap_or("").to_string(),
            pushed: pushed_set.contains(&oid),
        });
    }
    Ok(out)
}

fn validate_commit_page(offset: usize, limit: usize) -> AppResult<()> {
    if limit > MAX_COMMIT_PAGE_SIZE {
        return Err(AppError::Other(format!(
            "commit page limit exceeded (maximum {MAX_COMMIT_PAGE_SIZE})"
        )));
    }
    if offset > MAX_COMMIT_OFFSET {
        return Err(AppError::Other(format!(
            "commit offset limit exceeded (maximum {MAX_COMMIT_OFFSET})"
        )));
    }
    Ok(())
}

fn validate_commit_page_objects(
    repo: &Repository,
    page_oids: &[git2::Oid],
    limits: CommitPageObjectLimits,
) -> AppResult<()> {
    let odb = repo.odb()?;
    let mut total_object_bytes = 0usize;
    for oid in page_oids {
        let (object_bytes, object_type) = odb.read_header(*oid)?;
        if object_type != git2::ObjectType::Commit {
            return Err(AppError::Other(format!(
                "commit page contains non-commit object {oid}"
            )));
        }
        if object_bytes > limits.max_object_bytes {
            return Err(AppError::Other(format!(
                "commit page object byte limit exceeded (maximum {})",
                limits.max_object_bytes
            )));
        }
        total_object_bytes = total_object_bytes
            .checked_add(object_bytes)
            .ok_or_else(|| AppError::Other("commit page object byte count overflow".to_string()))?;
        if total_object_bytes > limits.max_total_object_bytes {
            return Err(AppError::Other(format!(
                "commit page total object byte limit exceeded (maximum {})",
                limits.max_total_object_bytes
            )));
        }
    }
    Ok(())
}

/// Return only requested OIDs that are reachable from a remote-tracking ref.
/// A bounded explicit walk avoids retaining the repository's entire remote
/// history and errors instead of presenting an unproven negative result.
fn pushed_page_oids(
    repo: &Repository,
    candidates: &[git2::Oid],
    limits: PushedHistoryLimits,
) -> AppResult<HashSet<git2::Oid>> {
    let mut candidate_set = HashSet::new();
    candidate_set
        .try_reserve(candidates.len())
        .map_err(|_| AppError::Other("failed to reserve pushed commit candidates".to_string()))?;
    candidate_set.extend(candidates.iter().copied());
    if candidate_set.is_empty() {
        return Ok(HashSet::new());
    }

    let branches = repo.branches(Some(git2::BranchType::Remote))?;
    let mut remote_ref_count = 0usize;
    let mut remote_tip_set = HashSet::new();
    let mut remote_tips = Vec::new();
    for entry in branches {
        remote_ref_count = remote_ref_count
            .checked_add(1)
            .ok_or_else(|| AppError::Other("remote tracking ref count overflow".to_string()))?;
        if remote_ref_count > limits.max_remote_refs {
            return Err(AppError::Other(format!(
                "remote tracking ref limit exceeded (maximum {})",
                limits.max_remote_refs
            )));
        }

        let (branch, _) = entry?;
        if branch.get().symbolic_target().is_some() {
            continue;
        }
        let oid = branch.get().target().ok_or_else(|| {
            AppError::Other("remote tracking ref has no direct target".to_string())
        })?;
        if remote_tip_set.contains(&oid) {
            continue;
        }
        remote_tip_set
            .try_reserve(1)
            .map_err(|_| AppError::Other("failed to reserve remote commit tips".to_string()))?;
        remote_tips
            .try_reserve(1)
            .map_err(|_| AppError::Other("failed to reserve remote commit tips".to_string()))?;
        remote_tip_set.insert(oid);
        remote_tips.push(oid);
    }
    if remote_tips.is_empty() {
        return Ok(HashSet::new());
    }

    let mut pushed = HashSet::new();
    pushed
        .try_reserve(candidate_set.len())
        .map_err(|_| AppError::Other("failed to reserve pushed commit results".to_string()))?;
    for oid in &remote_tips {
        if candidate_set.contains(oid) {
            pushed.insert(*oid);
        }
    }
    if pushed.len() == candidate_set.len() {
        return Ok(pushed);
    }

    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    for oid in remote_tips {
        enqueue_pushed_history_commit(&mut seen, &mut pending, oid, limits.max_commits)?;
    }

    let odb = repo.odb()?;
    let mut parent_edges = 0usize;
    let mut total_object_bytes = 0usize;

    while let Some(oid) = pending.pop() {
        if candidate_set.contains(&oid) {
            pushed.insert(oid);
            if pushed.len() == candidate_set.len() {
                return Ok(pushed);
            }
        }

        let (object_bytes, object_type) = odb.read_header(oid)?;
        if object_type != git2::ObjectType::Commit {
            return Err(AppError::Other(format!(
                "remote tracking ref history contains non-commit object {oid}"
            )));
        }
        if object_bytes > limits.max_commit_object_bytes {
            return Err(AppError::Other(format!(
                "remote commit object byte limit exceeded (maximum {})",
                limits.max_commit_object_bytes
            )));
        }
        total_object_bytes = total_object_bytes
            .checked_add(object_bytes)
            .ok_or_else(|| {
                AppError::Other("remote commit object byte count overflow".to_string())
            })?;
        if total_object_bytes > limits.max_total_object_bytes {
            return Err(AppError::Other(format!(
                "remote commit history byte limit exceeded (maximum {})",
                limits.max_total_object_bytes
            )));
        }

        let commit = repo.find_commit(oid)?;
        parent_edges = parent_edges
            .checked_add(commit.parent_count())
            .ok_or_else(|| {
                AppError::Other("remote commit parent edge count overflow".to_string())
            })?;
        if parent_edges > limits.max_parent_edges {
            return Err(AppError::Other(format!(
                "remote commit parent edge limit exceeded (maximum {})",
                limits.max_parent_edges
            )));
        }
        for index in 0..commit.parent_count() {
            enqueue_pushed_history_commit(
                &mut seen,
                &mut pending,
                commit.parent_id(index)?,
                limits.max_commits,
            )?;
        }
    }

    Ok(pushed)
}

fn enqueue_pushed_history_commit(
    seen: &mut HashSet<git2::Oid>,
    pending: &mut Vec<git2::Oid>,
    oid: git2::Oid,
    max_commits: usize,
) -> AppResult<()> {
    if seen.contains(&oid) {
        return Ok(());
    }
    if seen.len() >= max_commits {
        return Err(AppError::Other(format!(
            "remote commit history limit exceeded (maximum {max_commits})"
        )));
    }
    seen.try_reserve(1)
        .map_err(|_| AppError::Other("failed to reserve remote commit history".to_string()))?;
    pending
        .try_reserve(1)
        .map_err(|_| AppError::Other("failed to reserve remote commit history".to_string()))?;
    seen.insert(oid);
    pending.push(oid);
    Ok(())
}

pub fn list_staged(repo_path: &Path) -> AppResult<Vec<StagedFile>> {
    let repo = ensure_repo(repo_path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let mut files = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();
        let status = describe_status(s);
        if !status.is_empty() {
            files.push(StagedFile { path, status });
        }
    }
    files.sort_by(|a, b| {
        status_sort_key(&a.status)
            .cmp(&status_sort_key(&b.status))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(files)
}

fn status_sort_key(status: &str) -> u8 {
    if status.contains("untracked") {
        0
    } else if status.contains("staged") {
        1
    } else if status.contains("modified") {
        2
    } else if status.contains("deleted") {
        3
    } else {
        4
    }
}

fn describe_status(s: git2::Status) -> String {
    let mut tags = Vec::new();
    if s.is_index_new() {
        tags.push("staged-new");
    }
    if s.is_index_modified() {
        tags.push("staged-modified");
    }
    if s.is_index_deleted() {
        tags.push("staged-deleted");
    }
    if s.is_index_renamed() {
        tags.push("staged-renamed");
    }
    if s.is_wt_new() {
        tags.push("untracked");
    }
    if s.is_wt_modified() {
        tags.push("modified");
    }
    if s.is_wt_deleted() {
        tags.push("deleted");
    }
    tags.join(",")
}

pub fn diff_for_commit(repo_path: &Path, sha: &str) -> AppResult<DiffPayload> {
    diff_for_commit_with_image_target(repo_path, sha, None)
}

pub fn diff_images_for_commit(
    repo_path: &Path,
    sha: &str,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> AppResult<DiffImages> {
    validate_optional_git_paths(old_path, new_path)?;
    let target = DiffImageTarget { old_path, new_path };
    let payload = diff_for_commit_with_image_target(repo_path, sha, Some(&target))?;
    Ok(images_from_payload(payload, &target))
}

fn diff_for_commit_with_image_target(
    repo_path: &Path,
    sha: &str,
    image_target: Option<&DiffImageTarget<'_>>,
) -> AppResult<DiffPayload> {
    let repo = ensure_repo(repo_path)?;
    let oid = git2::Oid::from_str(sha)?;
    let commit = repo.find_commit(oid)?;
    let parent = commit.parent(0).ok();
    let parent_tree = parent.as_ref().map(|p| p.tree()).transpose()?;
    let commit_tree = commit.tree()?;
    let mut opts = DiffOptions::new();
    opts.max_size(MAX_DIFF_TEXT_FILE_BYTES);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))?;
    collect_diff(&repo, &diff, image_target)
}

pub fn diff_staged(repo_path: &Path) -> AppResult<DiffPayload> {
    diff_staged_with_pathspec(repo_path, None, None)
}

pub fn diff_staged_file(repo_path: &Path, path: &str) -> AppResult<DiffPayload> {
    validate_relative_git_path(path)?;
    diff_staged_with_pathspec(repo_path, Some(path), None)
}

pub fn diff_images_staged(
    repo_path: &Path,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> AppResult<DiffImages> {
    validate_optional_git_paths(old_path, new_path)?;
    let target = DiffImageTarget { old_path, new_path };
    let pathspec = new_path.or(old_path);
    let payload = diff_staged_with_pathspec(repo_path, pathspec, Some(&target))?;
    Ok(images_from_payload(payload, &target))
}

fn diff_staged_with_pathspec(
    repo_path: &Path,
    pathspec: Option<&str>,
    image_target: Option<&DiffImageTarget<'_>>,
) -> AppResult<DiffPayload> {
    let repo = ensure_repo(repo_path)?;
    let head_tree = repo.head().ok().and_then(|r| r.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .max_size(MAX_DIFF_TEXT_FILE_BYTES);
    if let Some(path) = pathspec {
        // A repository may legitimately contain glob metacharacters in a
        // filename. File-scoped requests must never expand those characters
        // into additional diff paths.
        opts.disable_pathspec_match(true);
        opts.pathspec(path);
    }
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    collect_diff(&repo, &diff, image_target)
}

fn validate_optional_git_paths(old_path: Option<&str>, new_path: Option<&str>) -> AppResult<()> {
    if old_path.is_none() && new_path.is_none() {
        return Err(AppError::InvalidPath("diff image path is missing".into()));
    }
    if let Some(path) = old_path {
        validate_relative_git_path(path)?;
    }
    if let Some(path) = new_path {
        validate_relative_git_path(path)?;
    }
    Ok(())
}

pub(crate) fn validate_relative_git_path(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidPath("empty git path".into()));
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err(AppError::InvalidPath(
            "git diff path must be relative".into(),
        ));
    }
    for component in p.components() {
        if matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return Err(AppError::InvalidPath(
                "git diff path must stay inside the repository".into(),
            ));
        }
    }
    Ok(())
}

struct DiffImageTarget<'a> {
    old_path: Option<&'a str>,
    new_path: Option<&'a str>,
}

fn target_matches(
    target: &DiffImageTarget<'_>,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> bool {
    target.old_path.is_some_and(|path| Some(path) == old_path)
        || target.new_path.is_some_and(|path| Some(path) == new_path)
}

fn images_from_payload(payload: DiffPayload, target: &DiffImageTarget<'_>) -> DiffImages {
    payload
        .files
        .into_iter()
        .find(|file| target_matches(target, file.old_path.as_deref(), file.new_path.as_deref()))
        .map(|file| DiffImages {
            old_image: file.old_image,
            new_image: file.new_image,
        })
        .unwrap_or_default()
}

fn collect_diff(
    repo: &Repository,
    diff: &git2::Diff,
    image_target: Option<&DiffImageTarget<'_>>,
) -> AppResult<DiffPayload> {
    collect_diff_with_image_target_and_limits(repo, diff, image_target, LOCAL_DIFF_LIMITS)
}

#[cfg(test)]
fn collect_diff_with_limits(
    repo: &Repository,
    diff: &git2::Diff,
    limits: DiffLimits,
) -> AppResult<DiffPayload> {
    collect_diff_with_image_target_and_limits(repo, diff, None, limits)
}

fn collect_diff_with_image_target_and_limits(
    repo: &Repository,
    diff: &git2::Diff,
    image_target: Option<&DiffImageTarget<'_>>,
    limits: DiffLimits,
) -> AppResult<DiffPayload> {
    let delta_count = diff.deltas().len();
    if delta_count > limits.max_files {
        return Err(AppError::Other(format!(
            "diff file limit exceeded (maximum {})",
            limits.max_files
        )));
    }

    let acc: RefCell<Vec<DiffFile>> = RefCell::new(Vec::with_capacity(delta_count));
    let current: RefCell<Option<DiffFile>> = RefCell::new(None);
    let patch_bytes = Cell::new(0usize);
    let patch_limit_hit = Cell::new(false);
    let mut image_bytes_remaining = limits.max_total_image_bytes;

    let foreach_result = diff.foreach(
        &mut |delta, _| {
            if let Some(prev) = current.borrow_mut().take() {
                acc.borrow_mut().push(prev);
            }
            let old_path = delta.old_file().path().map(|p| p.display().to_string());
            let new_path = delta.new_file().path().map(|p| p.display().to_string());
            let path_for_type = new_path.as_deref().or(old_path.as_deref()).unwrap_or("");
            let is_image = is_image_path(path_for_type);
            let should_load_images = is_image
                && image_target.is_some_and(|target| {
                    target_matches(target, old_path.as_deref(), new_path.as_deref())
                });
            let (old_image, new_image) = if should_load_images {
                (
                    image_data_uri_bounded(
                        repo,
                        delta.old_file().id(),
                        old_path.as_deref(),
                        limits.max_image_bytes,
                        &mut image_bytes_remaining,
                    ),
                    image_data_uri_workdir_bounded(
                        repo,
                        delta.new_file().id(),
                        new_path.as_deref(),
                        limits.max_image_bytes,
                        &mut image_bytes_remaining,
                    ),
                )
            } else {
                (None, None)
            };
            *current.borrow_mut() = Some(DiffFile {
                old_path,
                new_path,
                patch: String::new(),
                old_image,
                new_image,
                is_image,
            });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            // Without this callback the patch stream contains only +/-/space
            // body lines, so the renderer has no per-line numbering anchor.
            // libgit2's `header()` already includes the trailing newline.
            let raw_header = hunk.header();
            if !reserve_patch_bytes(&patch_bytes, raw_header.len(), limits.max_patch_bytes) {
                patch_limit_hit.set(true);
                return false;
            }
            if let Some(f) = current.borrow_mut().as_mut() {
                let header = std::str::from_utf8(raw_header).unwrap_or("");
                f.patch.push_str(header);
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            if let Some(f) = current.borrow_mut().as_mut() {
                let origin = line.origin();
                let prefix = matches!(origin, '+' | '-' | ' ').then_some(origin);
                let prefix_bytes = usize::from(prefix.is_some());
                let Some(additional_bytes) = line.content().len().checked_add(prefix_bytes) else {
                    patch_limit_hit.set(true);
                    return false;
                };
                if !reserve_patch_bytes(&patch_bytes, additional_bytes, limits.max_patch_bytes) {
                    patch_limit_hit.set(true);
                    return false;
                }
                let content = std::str::from_utf8(line.content()).unwrap_or("");
                if let Some(prefix) = prefix {
                    f.patch.push(prefix);
                }
                f.patch.push_str(content);
            }
            true
        }),
    );
    if patch_limit_hit.get() {
        return Err(AppError::Other(format!(
            "diff patch byte limit exceeded (maximum {})",
            limits.max_patch_bytes
        )));
    }
    foreach_result?;
    if let Some(prev) = current.borrow_mut().take() {
        acc.borrow_mut().push(prev);
    }
    Ok(DiffPayload {
        files: acc.into_inner(),
    })
}

fn reserve_patch_bytes(used: &Cell<usize>, additional: usize, limit: usize) -> bool {
    let Some(total) = used.get().checked_add(additional) else {
        return false;
    };
    if total > limit {
        return false;
    }
    used.set(total);
    true
}

fn is_image_path(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
    )
}

pub(crate) fn image_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub(crate) fn encode_data_uri(bytes: &[u8], path: &str) -> String {
    use base64::Engine as _;
    format!(
        "data:{};base64,{}",
        image_mime(path),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn image_data_uri_bounded(
    repo: &Repository,
    oid: git2::Oid,
    path: Option<&str>,
    max_image_bytes: usize,
    image_bytes_remaining: &mut usize,
) -> Option<String> {
    let path = path?;
    if oid.is_zero() {
        return None;
    }
    let allowed_bytes = max_image_bytes.min(*image_bytes_remaining);
    let odb = repo.odb().ok()?;
    let (size, kind) = odb.read_header(oid).ok()?;
    if kind != git2::ObjectType::Blob || size > allowed_bytes {
        return None;
    }
    let blob = repo.find_blob(oid).ok()?;
    if blob.content().len() > allowed_bytes {
        return None;
    }
    let preview = encode_data_uri(blob.content(), path);
    *image_bytes_remaining -= blob.content().len();
    Some(preview)
}

/// Resolve image bytes for the "new" side of a diff.
/// Falls back to reading the workdir file when the diff has no oid (untracked
/// or staged-but-unwritten cases).
fn image_data_uri_workdir_bounded(
    repo: &Repository,
    oid: git2::Oid,
    path: Option<&str>,
    max_image_bytes: usize,
    image_bytes_remaining: &mut usize,
) -> Option<String> {
    let path = path?;
    if !oid.is_zero() {
        return image_data_uri_bounded(
            repo,
            oid,
            Some(path),
            max_image_bytes,
            image_bytes_remaining,
        );
    }
    let allowed_bytes = max_image_bytes.min(*image_bytes_remaining);
    let bytes = read_workdir_image(repo, path, allowed_bytes)?;
    let preview = encode_data_uri(&bytes, path);
    *image_bytes_remaining -= bytes.len();
    Some(preview)
}

fn read_workdir_image(repo: &Repository, path: &str, max_bytes: usize) -> Option<Vec<u8>> {
    validate_relative_git_path(path).ok()?;
    let workdir = repo.workdir()?.canonicalize().ok()?;
    let candidate = workdir.join(path);
    let metadata = std::fs::symlink_metadata(&candidate).ok()?;
    let max_bytes_u64 = u64::try_from(max_bytes).unwrap_or(u64::MAX);
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes_u64 {
        return None;
    }
    let resolved = candidate.canonicalize().ok()?;
    if !resolved.starts_with(&workdir) {
        return None;
    }
    let file = File::open(resolved).ok()?;
    let open_meta = file.metadata().ok()?;
    if !open_meta.is_file() || open_meta.len() > max_bytes_u64 {
        return None;
    }

    // Re-check while reading because a regular file may grow after metadata
    // inspection. `take` also bounds unusual virtual files reporting size 0.
    let capacity = usize::try_from(open_meta.len()).ok()?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes_u64.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > max_bytes {
        return None;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "acorn-git-ops-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn commit_file(
        repo: &git2::Repository,
        rel: &str,
        contents: &str,
        message: &str,
        parents: &[&git2::Commit<'_>],
    ) -> git2::Oid {
        let workdir = repo.workdir().expect("workdir");
        let path = workdir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&path, contents).expect("write file");
        let mut idx = repo.index().expect("index");
        idx.add_path(std::path::Path::new(rel)).expect("add");
        idx.write().expect("write index");
        let tree_id = idx.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let sig = git2::Signature::now("test", "t@example").expect("sig");
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, parents)
            .expect("commit")
    }

    fn linear_history(repo: &git2::Repository) -> [git2::Oid; 4] {
        let first_oid = commit_file(repo, "history.txt", "a\n", "first", &[]);
        let first = repo.find_commit(first_oid).expect("first commit");
        let second_oid = commit_file(repo, "history.txt", "b\n", "second", &[&first]);
        drop(first);
        let second = repo.find_commit(second_oid).expect("second commit");
        let third_oid = commit_file(repo, "history.txt", "c\n", "third", &[&second]);
        drop(second);
        let third = repo.find_commit(third_oid).expect("third commit");
        let fourth_oid = commit_file(repo, "history.txt", "d\n", "fourth", &[&third]);
        drop(third);
        [first_oid, second_oid, third_oid, fourth_oid]
    }

    fn set_remote_ref(repo: &git2::Repository, name: &str, oid: git2::Oid) {
        repo.reference(
            &format!("refs/remotes/origin/{name}"),
            oid,
            true,
            "test remote ref",
        )
        .expect("create remote ref");
    }

    fn test_pushed_history_limits() -> PushedHistoryLimits {
        PushedHistoryLimits {
            max_remote_refs: 16,
            max_commits: 32,
            max_parent_edges: 64,
            max_commit_object_bytes: 1024 * 1024,
            max_total_object_bytes: 8 * 1024 * 1024,
        }
    }

    #[test]
    fn ssh_hostname_cache_bounds_successes_and_failures() {
        let mut cache = SshHostnameCache::with_capacity(2);

        cache.insert("first".to_string(), Some("github.com".to_string()));
        cache.insert("second".to_string(), None);
        cache.insert("third".to_string(), Some("example.com".to_string()));

        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("first"), None);
        assert_eq!(cache.get("second"), Some(&None));
        assert_eq!(cache.get("third"), Some(&Some("example.com".to_string())));
    }

    #[test]
    fn ssh_hostname_validation_rejects_oversized_cache_keys() {
        assert!(is_plain_hostname(&"a".repeat(255)));
        assert!(!is_plain_hostname(&"a".repeat(256)));
    }

    #[test]
    fn commit_pagination_rejects_pathological_renderer_values() {
        assert!(validate_commit_page(0, MAX_COMMIT_PAGE_SIZE).is_ok());
        assert!(validate_commit_page(MAX_COMMIT_OFFSET, 50).is_ok());

        let page_error = validate_commit_page(0, usize::MAX).unwrap_err();
        assert!(page_error.to_string().contains("page limit exceeded"));

        let offset_error = validate_commit_page(usize::MAX, 50).unwrap_err();
        assert!(offset_error.to_string().contains("offset limit exceeded"));
    }

    #[test]
    fn commit_page_object_budgets_enforce_individual_and_total_boundaries() {
        let root = unique_temp_dir("commit-page-object-budgets");
        let repo = git2::Repository::init(&root).expect("init repo");
        let [first, second, _third, _fourth] = linear_history(&repo);
        let odb = repo.odb().expect("object database");
        let first_bytes = odb.read_header(first).expect("first header").0;
        let second_bytes = odb.read_header(second).expect("second header").0;
        let total_bytes = first_bytes
            .checked_add(second_bytes)
            .expect("small test object sizes");
        let (largest_oid, largest_bytes) = if first_bytes >= second_bytes {
            (first, first_bytes)
        } else {
            (second, second_bytes)
        };

        let exact = CommitPageObjectLimits {
            max_object_bytes: largest_bytes,
            max_total_object_bytes: total_bytes,
        };
        validate_commit_page_objects(&repo, &[first, second], exact)
            .expect("objects exactly at page budgets");

        let individual_limited = CommitPageObjectLimits {
            max_object_bytes: largest_bytes - 1,
            max_total_object_bytes: total_bytes,
        };
        let individual_error =
            validate_commit_page_objects(&repo, &[largest_oid], individual_limited)
                .expect_err("commit exceeds individual page object budget");
        assert!(individual_error
            .to_string()
            .contains("commit page object byte limit"));

        let total_limited = CommitPageObjectLimits {
            max_object_bytes: largest_bytes,
            max_total_object_bytes: total_bytes - 1,
        };
        let total_error = validate_commit_page_objects(&repo, &[first, second], total_limited)
            .expect_err("commits exceed total page object budget");
        assert!(total_error
            .to_string()
            .contains("commit page total object byte limit"));

        drop(odb);
        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn commit_page_object_validation_rejects_non_commit_oids() {
        let root = unique_temp_dir("commit-page-non-commit");
        let repo = git2::Repository::init(&root).expect("init repo");
        let blob = repo.blob(b"not a commit").expect("create blob");

        let error = validate_commit_page_objects(
            &repo,
            &[blob],
            CommitPageObjectLimits {
                max_object_bytes: 1024,
                max_total_object_bytes: 1024,
            },
        )
        .expect_err("page oid must be a commit");
        assert!(error.to_string().contains("non-commit object"));

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn zero_sized_commit_page_skips_history_traversal() {
        let root = unique_temp_dir("zero-commit-page");
        git2::Repository::init(&root).expect("init repo");

        assert!(list_commits(&root, 0, 0).unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_marks_only_remote_reachable_page_commits() {
        let root = unique_temp_dir("pushed-history-exact");
        let repo = git2::Repository::init(&root).expect("init repo");
        let [first, second, third, _fourth] = linear_history(&repo);
        set_remote_ref(&repo, "main", second);

        let pushed = pushed_page_oids(&repo, &[third, second, first], test_pushed_history_limits())
            .expect("classify page commits");
        assert!(!pushed.contains(&third));
        assert!(pushed.contains(&second));
        assert!(pushed.contains(&first));

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_without_remotes_returns_exact_negatives() {
        let root = unique_temp_dir("pushed-history-no-remotes");
        let repo = git2::Repository::init(&root).expect("init repo");
        let commit = commit_file(&repo, "a.txt", "a\n", "only", &[]);
        let limits = PushedHistoryLimits {
            max_remote_refs: 0,
            max_commits: 0,
            max_parent_edges: 0,
            max_commit_object_bytes: 0,
            max_total_object_bytes: 0,
        };

        assert!(pushed_page_oids(&repo, &[commit], limits)
            .expect("no remotes")
            .is_empty());

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_counts_symbolic_remote_refs_against_the_budget() {
        let root = unique_temp_dir("pushed-history-ref-budget");
        let repo = git2::Repository::init(&root).expect("init repo");
        let commit = commit_file(&repo, "a.txt", "a\n", "only", &[]);
        set_remote_ref(&repo, "main", commit);
        set_remote_ref(&repo, "backup", commit);
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test symbolic remote ref",
        )
        .expect("create symbolic remote ref");

        let too_small = PushedHistoryLimits {
            max_remote_refs: 2,
            ..test_pushed_history_limits()
        };
        let error = pushed_page_oids(&repo, &[commit], too_small)
            .expect_err("all remote iterator entries must count");
        assert!(error.to_string().contains("remote tracking ref limit"));

        let exact = PushedHistoryLimits {
            max_remote_refs: 3,
            ..test_pushed_history_limits()
        };
        assert!(pushed_page_oids(&repo, &[commit], exact)
            .expect("exact remote ref budget")
            .contains(&commit));

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_enforces_unique_commit_and_parent_edge_budgets() {
        let root = unique_temp_dir("pushed-history-graph-budgets");
        let repo = git2::Repository::init(&root).expect("init repo");
        let [_first, _second, third, fourth] = linear_history(&repo);
        set_remote_ref(&repo, "main", third);

        let commit_limited = PushedHistoryLimits {
            max_commits: 2,
            ..test_pushed_history_limits()
        };
        let commit_error = pushed_page_oids(&repo, &[fourth], commit_limited)
            .expect_err("remote graph exceeds unique commit budget");
        assert!(commit_error
            .to_string()
            .contains("remote commit history limit"));

        let edge_limited = PushedHistoryLimits {
            max_parent_edges: 1,
            ..test_pushed_history_limits()
        };
        let edge_error = pushed_page_oids(&repo, &[fourth], edge_limited)
            .expect_err("remote graph exceeds parent edge budget");
        assert!(edge_error
            .to_string()
            .contains("remote commit parent edge limit"));

        let exact = PushedHistoryLimits {
            max_commits: 3,
            max_parent_edges: 2,
            ..test_pushed_history_limits()
        };
        assert!(pushed_page_oids(&repo, &[fourth], exact)
            .expect("exact graph budgets")
            .is_empty());

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_enforces_commit_object_budgets() {
        let root = unique_temp_dir("pushed-history-object-budgets");
        let repo = git2::Repository::init(&root).expect("init repo");
        let [first, second, third, fourth] = linear_history(&repo);
        set_remote_ref(&repo, "main", third);
        let odb = repo.odb().expect("object database");
        let first_bytes = odb.read_header(first).expect("first header").0;
        let second_bytes = odb.read_header(second).expect("second header").0;
        let third_bytes = odb.read_header(third).expect("third header").0;

        let per_object_limited = PushedHistoryLimits {
            max_commit_object_bytes: third_bytes - 1,
            ..test_pushed_history_limits()
        };
        let object_error = pushed_page_oids(&repo, &[fourth], per_object_limited)
            .expect_err("remote commit exceeds per-object budget");
        assert!(object_error
            .to_string()
            .contains("remote commit object byte limit"));

        let total_bytes = first_bytes
            .checked_add(second_bytes)
            .and_then(|bytes| bytes.checked_add(third_bytes))
            .expect("small test object sizes");
        let cumulative_limited = PushedHistoryLimits {
            max_commit_object_bytes: first_bytes.max(second_bytes).max(third_bytes),
            max_total_object_bytes: total_bytes - 1,
            ..test_pushed_history_limits()
        };
        let total_error = pushed_page_oids(&repo, &[fourth], cumulative_limited)
            .expect_err("remote history exceeds cumulative object budget");
        assert!(total_error
            .to_string()
            .contains("remote commit history byte limit"));

        drop(odb);
        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_returns_early_after_all_candidates_are_found() {
        let root = unique_temp_dir("pushed-history-early-success");
        let repo = git2::Repository::init(&root).expect("init repo");
        let [_first, second, third, _fourth] = linear_history(&repo);
        set_remote_ref(&repo, "main", third);
        set_remote_ref(&repo, "backup", second);
        let limits = PushedHistoryLimits {
            max_remote_refs: 2,
            max_commits: 0,
            max_parent_edges: 0,
            max_commit_object_bytes: 0,
            max_total_object_bytes: 0,
        };

        assert!(pushed_page_oids(&repo, &[third], limits)
            .expect("tip candidate needs no ancestor traversal")
            .contains(&third));

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushed_history_rejects_non_commit_remote_targets() {
        let root = unique_temp_dir("pushed-history-non-commit");
        let repo = git2::Repository::init(&root).expect("init repo");
        let commit = commit_file(&repo, "a.txt", "a\n", "only", &[]);
        let blob = repo.blob(b"not a commit").expect("create blob");
        set_remote_ref(&repo, "invalid", blob);

        let error = pushed_page_oids(&repo, &[commit], test_pushed_history_limits())
            .expect_err("non-commit remote target must fail closed");
        assert!(error.to_string().contains("non-commit object"));

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_commit_page_skips_invalid_remote_history() {
        let root = unique_temp_dir("empty-page-skips-remote-history");
        let repo = git2::Repository::init(&root).expect("init repo");
        commit_file(&repo, "a.txt", "a\n", "only", &[]);
        let blob = repo.blob(b"not a commit").expect("create blob");
        set_remote_ref(&repo, "invalid", blob);
        drop(repo);

        assert!(list_commits(&root, 1, 1)
            .expect("empty page does not need pushed classification")
            .is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_for_commit_includes_hunk_headers() {
        let root = unique_temp_dir("hunk-headers");
        let repo = git2::Repository::init(&root).expect("init repo");
        let v1 = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
        let first_oid = commit_file(&repo, "a.txt", v1, "init", &[]);
        let first = repo.find_commit(first_oid).expect("first commit");
        let v2 = "alpha\nbeta\nGAMMA\ndelta\nepsilon\n";
        let second_oid = commit_file(&repo, "a.txt", v2, "mutate", &[&first]);
        drop(first);
        drop(repo);

        let payload =
            diff_for_commit(&root, &second_oid.to_string()).expect("diff for second commit");
        assert_eq!(payload.files.len(), 1);
        let patch = &payload.files[0].patch;
        assert!(
            patch.lines().any(|l| l.starts_with("@@")),
            "patch should contain at least one hunk header, got: {patch:?}",
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_diff_metadata_does_not_embed_bytes_until_requested() {
        let root = unique_temp_dir("lazy-image-diff");
        let repo = git2::Repository::init(&root).expect("init repo");
        let first_oid = commit_file(&repo, "preview.png", "old-image", "init", &[]);
        let first = repo.find_commit(first_oid).expect("first commit");
        let second_oid = commit_file(
            &repo,
            "preview.png",
            "new-image",
            "replace image",
            &[&first],
        );
        drop(first);
        drop(repo);

        let sha = second_oid.to_string();
        let payload = diff_for_commit(&root, &sha).expect("image diff metadata");
        assert_eq!(payload.files.len(), 1);
        let file = &payload.files[0];
        assert!(file.is_image);
        assert!(file.old_image.is_none());
        assert!(file.new_image.is_none());

        let images = diff_images_for_commit(
            &root,
            &sha,
            file.old_path.as_deref(),
            file.new_path.as_deref(),
        )
        .expect("lazy image bytes");
        assert!(images
            .old_image
            .as_deref()
            .is_some_and(|data| data.starts_with("data:image/png;base64,")));
        assert!(images
            .new_image
            .as_deref()
            .is_some_and(|data| data.starts_with("data:image/png;base64,")));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_staged_file_limits_payload_to_requested_path() {
        let root = unique_temp_dir("staged-file-pathspec");
        let repo = git2::Repository::init(&root).expect("init repo");
        let first_oid = commit_file(&repo, "a.txt", "alpha\n", "init a", &[]);
        let first = repo.find_commit(first_oid).expect("first commit");
        let second_oid = commit_file(&repo, "b.txt", "bravo\n", "init b", &[&first]);
        let _second = repo.find_commit(second_oid).expect("second commit");
        fs::write(root.join("a.txt"), "alpha\nchanged\n").expect("write a");
        fs::write(root.join("b.txt"), "bravo\nchanged\n").expect("write b");
        drop(_second);
        drop(first);
        drop(repo);

        let payload = diff_staged_file(&root, "a.txt").expect("diff for a.txt");
        assert_eq!(payload.files.len(), 1);
        assert_eq!(payload.files[0].new_path.as_deref(), Some("a.txt"));
        assert!(
            payload.files[0].patch.contains("+changed"),
            "expected selected file patch, got {:?}",
            payload.files[0].patch
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_staged_file_treats_glob_metacharacters_literally() {
        let root = unique_temp_dir("staged-file-literal-pathspec");
        let repo = git2::Repository::init(&root).expect("init repo");
        let first_oid = commit_file(&repo, "*.rs", "literal\n", "init literal", &[]);
        let first = repo.find_commit(first_oid).expect("first commit");
        let second_oid = commit_file(&repo, "other.rs", "other\n", "init other", &[&first]);
        let _second = repo.find_commit(second_oid).expect("second commit");
        fs::write(root.join("*.rs"), "literal\nchanged\n").expect("write literal glob file");
        fs::write(root.join("other.rs"), "other\nchanged\n").expect("write other file");
        drop(_second);
        drop(first);
        drop(repo);

        let payload = diff_staged_file(&root, "*.rs").expect("diff for literal glob path");
        assert_eq!(payload.files.len(), 1);
        assert_eq!(payload.files[0].new_path.as_deref(), Some("*.rs"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_staged_file_rejects_paths_outside_repo() {
        let root = unique_temp_dir("staged-file-path-validation");
        git2::Repository::init(&root).expect("init repo");

        assert!(diff_staged_file(&root, "../outside.txt").is_err());
        assert!(diff_staged_file(&root, "/tmp/outside.txt").is_err());
        assert!(diff_staged_file(&root, "").is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn workdir_image_read_stays_inside_repo() {
        let parent = unique_temp_dir("image-containment");
        let root = parent.join("repo");
        fs::create_dir_all(&root).expect("create repo dir");
        fs::write(parent.join("outside.png"), b"outside").expect("write outside image");
        let repo = git2::Repository::init(&root).expect("init repo");
        fs::write(root.join("inside.png"), b"inside").expect("write image");

        assert_eq!(
            read_workdir_image(&repo, "inside.png", MAX_DIFF_IMAGE_BYTES),
            Some(b"inside".to_vec())
        );
        assert_eq!(
            read_workdir_image(&repo, "../outside.png", MAX_DIFF_IMAGE_BYTES),
            None
        );

        drop(repo);
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn workdir_image_read_rejects_files_over_the_byte_limit() {
        let root = unique_temp_dir("image-byte-limit");
        let repo = git2::Repository::init(&root).expect("init repo");
        fs::write(root.join("large.png"), b"12345").expect("write image");

        assert_eq!(read_workdir_image(&repo, "large.png", 4), None);
        assert_eq!(
            read_workdir_image(&repo, "large.png", 5),
            Some(b"12345".to_vec())
        );

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn repository_image_preview_respects_per_image_and_aggregate_budgets() {
        let root = unique_temp_dir("image-blob-budget");
        let repo = git2::Repository::init(&root).expect("init repo");
        let oid = repo.blob(b"image-bytes").expect("write blob");

        let mut too_small = 10;
        assert_eq!(
            image_data_uri_bounded(&repo, oid, Some("asset.png"), 64, &mut too_small),
            None
        );
        assert_eq!(too_small, 10);

        let mut exact = 11;
        let preview = image_data_uri_bounded(&repo, oid, Some("asset.png"), 64, &mut exact)
            .expect("preview within budget");
        assert!(preview.starts_with("data:image/png;base64,"));
        assert_eq!(exact, 0);

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collect_diff_enforces_file_and_patch_budgets() {
        let root = unique_temp_dir("patch-byte-limit");
        let repo = git2::Repository::init(&root).expect("init repo");
        commit_file(&repo, "a.txt", "alpha\n", "init", &[]);
        fs::write(root.join("a.txt"), "alpha\nbravo\n").expect("modify file");
        let head_tree = repo
            .head()
            .expect("head")
            .peel_to_tree()
            .expect("head tree");
        let diff = repo
            .diff_tree_to_workdir_with_index(Some(&head_tree), None)
            .expect("workdir diff");

        let file_limits = DiffLimits {
            max_files: 0,
            ..LOCAL_DIFF_LIMITS
        };
        let file_error = collect_diff_with_limits(&repo, &diff, file_limits)
            .expect_err("diff with too many files should be rejected");
        assert!(file_error.to_string().contains("file limit"));

        let limits = DiffLimits {
            max_patch_bytes: 4,
            ..LOCAL_DIFF_LIMITS
        };
        let error = collect_diff_with_limits(&repo, &diff, limits)
            .expect_err("oversized patch should be rejected");
        assert!(error.to_string().contains("patch byte limit"));

        drop(diff);
        drop(head_tree);
        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn workdir_image_read_rejects_symlink() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("image-symlink");
        let outside = unique_temp_dir("image-symlink-outside");
        let outside_image = outside.join("secret.png");
        fs::write(&outside_image, b"secret").expect("write outside image");
        symlink(&outside_image, root.join("linked.png")).expect("create symlink");
        let repo = git2::Repository::init(&root).expect("init repo");

        assert_eq!(
            read_workdir_image(&repo, "linked.png", MAX_DIFF_IMAGE_BYTES),
            None
        );

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
