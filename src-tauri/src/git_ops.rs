use git2::{DiffOptions, Repository};
use serde::Serialize;
use std::path::Path;

use crate::error::AppResult;
use crate::worktree::ensure_repo;

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
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

fn cached_ssh_hostname(alias: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Ok(map) = cache.lock() {
        if let Some(hit) = map.get(alias) {
            return hit.clone();
        }
    }

    let resolved = resolve_ssh_hostname(alias);
    if let Ok(mut map) = cache.lock() {
        map.insert(alias.to_string(), resolved.clone());
    }
    resolved
}

fn resolve_ssh_hostname(alias: &str) -> Option<String> {
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

pub fn list_commits(
    repo_path: &Path,
    offset: usize,
    limit: usize,
) -> AppResult<Vec<CommitInfo>> {
    let repo = ensure_repo(repo_path)?;
    let pushed_set = pushed_oid_set(&repo);

    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TIME)?;

    let mut out = Vec::with_capacity(limit);
    for oid in walk.skip(offset).take(limit) {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let author = commit.author();
        out.push(CommitInfo {
            sha: oid.to_string(),
            short_sha: oid.to_string().chars().take(7).collect(),
            author: author.name().unwrap_or("?").to_string(),
            timestamp: commit.time().seconds(),
            summary: commit.summary().unwrap_or("").to_string(),
            pushed: pushed_set.contains(&oid),
        });
    }
    Ok(out)
}

/// Build the set of commit OIDs reachable from any remote-tracking branch.
/// A commit is "pushed" if its OID is in this set. Computed in a single
/// revwalk to avoid quadratic per-commit ancestry checks.
fn pushed_oid_set(repo: &Repository) -> std::collections::HashSet<git2::Oid> {
    let mut set = std::collections::HashSet::new();
    let Ok(mut walk) = repo.revwalk() else {
        return set;
    };
    let _ = walk.set_sorting(git2::Sort::TOPOLOGICAL);

    let Ok(branches) = repo.branches(Some(git2::BranchType::Remote)) else {
        return set;
    };
    let mut pushed_any = false;
    for entry in branches.flatten() {
        let (branch, _) = entry;
        if branch.get().symbolic_target().is_some() {
            continue;
        }
        if let Some(oid) = branch.get().target() {
            if walk.push(oid).is_ok() {
                pushed_any = true;
            }
        }
    }
    if !pushed_any {
        return set;
    }
    for oid in walk.flatten() {
        set.insert(oid);
    }
    set
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
    let repo = ensure_repo(repo_path)?;
    let oid = git2::Oid::from_str(sha)?;
    let commit = repo.find_commit(oid)?;
    let parent = commit.parent(0).ok();
    let parent_tree = parent.as_ref().map(|p| p.tree()).transpose()?;
    let commit_tree = commit.tree()?;
    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&commit_tree),
        Some(&mut opts),
    )?;
    collect_diff(&repo, &diff)
}

pub fn diff_staged(repo_path: &Path) -> AppResult<DiffPayload> {
    let repo = ensure_repo(repo_path)?;
    let head_tree = repo.head().ok().and_then(|r| r.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    collect_diff(&repo, &diff)
}

fn collect_diff(repo: &Repository, diff: &git2::Diff) -> AppResult<DiffPayload> {
    use std::cell::RefCell;
    let acc: RefCell<Vec<DiffFile>> = RefCell::new(Vec::new());
    let current: RefCell<Option<DiffFile>> = RefCell::new(None);

    diff.foreach(
        &mut |delta, _| {
            if let Some(prev) = current.borrow_mut().take() {
                acc.borrow_mut().push(prev);
            }
            let old_path = delta.old_file().path().map(|p| p.display().to_string());
            let new_path = delta.new_file().path().map(|p| p.display().to_string());
            let path_for_type = new_path.as_deref().or(old_path.as_deref()).unwrap_or("");
            let is_image = is_image_path(path_for_type);
            let (old_image, new_image) = if is_image {
                (
                    image_data_uri(repo, delta.old_file().id(), old_path.as_deref()),
                    image_data_uri_workdir(
                        repo,
                        delta.new_file().id(),
                        new_path.as_deref(),
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
        None,
        Some(&mut |_delta, _hunk, line| {
            if let Some(f) = current.borrow_mut().as_mut() {
                let origin = line.origin();
                let prefix = match origin {
                    '+' | '-' | ' ' => format!("{origin}"),
                    _ => String::new(),
                };
                let content = std::str::from_utf8(line.content()).unwrap_or("");
                f.patch.push_str(&prefix);
                f.patch.push_str(content);
            }
            true
        }),
    )?;
    if let Some(prev) = current.borrow_mut().take() {
        acc.borrow_mut().push(prev);
    }
    Ok(DiffPayload {
        files: acc.into_inner(),
    })
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

fn image_mime(path: &str) -> &'static str {
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

fn encode_data_uri(bytes: &[u8], path: &str) -> String {
    use base64::Engine as _;
    format!(
        "data:{};base64,{}",
        image_mime(path),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn image_data_uri(repo: &Repository, oid: git2::Oid, path: Option<&str>) -> Option<String> {
    let path = path?;
    if oid.is_zero() {
        return None;
    }
    let blob = repo.find_blob(oid).ok()?;
    Some(encode_data_uri(blob.content(), path))
}

/// Resolve image bytes for the "new" side of a diff.
/// Falls back to reading the workdir file when the diff has no oid (untracked
/// or staged-but-unwritten cases).
fn image_data_uri_workdir(
    repo: &Repository,
    oid: git2::Oid,
    path: Option<&str>,
) -> Option<String> {
    let path = path?;
    if !oid.is_zero() {
        if let Ok(blob) = repo.find_blob(oid) {
            return Some(encode_data_uri(blob.content(), path));
        }
    }
    let workdir = repo.workdir()?;
    let abs = workdir.join(path);
    let bytes = std::fs::read(abs).ok()?;
    Some(encode_data_uri(&bytes, path))
}
