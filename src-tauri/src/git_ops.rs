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
}

/// Resolve an origin remote URL into a GitHub-style web URL pointing at the
/// given commit. Returns `None` when there is no `origin` remote, the URL
/// cannot be parsed, or the host is not recognised as GitHub.
pub fn web_url_for_commit(repo_path: &Path, sha: &str) -> AppResult<Option<String>> {
    let repo = ensure_repo(repo_path)?;
    let remote = match repo.find_remote("origin") {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let Some(url) = remote.url() else {
        return Ok(None);
    };
    Ok(parse_github_commit_url(url, sha))
}

fn parse_github_commit_url(remote: &str, sha: &str) -> Option<String> {
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

    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }

    let owner_repo = path.trim_start_matches('/').trim_end_matches(".git");
    if owner_repo.is_empty() || !owner_repo.contains('/') {
        return None;
    }
    Some(format!("https://github.com/{owner_repo}/commit/{sha}"))
}

pub fn list_commits(
    repo_path: &Path,
    offset: usize,
    limit: usize,
) -> AppResult<Vec<CommitInfo>> {
    let repo = ensure_repo(repo_path)?;
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
        });
    }
    Ok(out)
}

pub fn list_staged(repo_path: &Path) -> AppResult<Vec<StagedFile>> {
    let repo = ensure_repo(repo_path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true);
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
    Ok(files)
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
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?;
    collect_diff(&repo, &diff)
}

fn collect_diff(_repo: &Repository, diff: &git2::Diff) -> AppResult<DiffPayload> {
    use std::cell::RefCell;
    let acc: RefCell<Vec<DiffFile>> = RefCell::new(Vec::new());
    let current: RefCell<Option<DiffFile>> = RefCell::new(None);

    diff.foreach(
        &mut |delta, _| {
            if let Some(prev) = current.borrow_mut().take() {
                acc.borrow_mut().push(prev);
            }
            *current.borrow_mut() = Some(DiffFile {
                old_path: delta.old_file().path().map(|p| p.display().to_string()),
                new_path: delta.new_file().path().map(|p| p.display().to_string()),
                patch: String::new(),
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
