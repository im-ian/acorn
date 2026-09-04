use git2::{BranchType, ErrorCode, Repository, WorktreeAddOptions, WorktreePruneOptions};
use serde::Serialize;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const ACORN_DIR: &str = ".acorn";
const EXCLUDE_ENTRY: &str = ".acorn/";
const MAX_GIT_EXCLUDE_BYTES: u64 = 1024 * 1024;
const DELETED_WORKTREES_DIR: &str = ".acorn-deleted-worktrees";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorktree {
    pub token: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub git_common_dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectWorktreeInfo {
    pub name: String,
    pub path: String,
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectBranchInfo {
    pub name: String,
    pub is_remote: bool,
}

pub fn ensure_repo(path: &Path) -> AppResult<Repository> {
    // `discover` walks up from `path` to find the nearest `.git`, so callers
    // can pass any subdirectory (e.g. a session's PTY cwd that drifted into
    // `<repo>/src-tauri`) without the open failing. Also handles linked
    // worktrees, where `.git` is a file pointing at the parent repo.
    //
    // If `path` itself no longer exists (typical when a linked worktree was
    // pruned externally — e.g. `claude -w` cleaning up on exit — but the
    // session row in our store still references it), libgit2 refuses to
    // resolve the path and `discover` returns "failed to resolve path".
    // Walk up to the nearest existing ancestor first so the call survives
    // until the persistent reconcile sweep in `list_sessions` rewrites the
    // session's `worktree_path` back to the main repo. Without this layer,
    // any UI poll (`list_commits`, `list_staged`, `diff_*`) racing the
    // sweep still bubbles the raw git error into the right panel.
    let start = walk_to_existing_ancestor(path);
    Repository::discover(&start).map_err(|e| {
        AppError::Other(format!(
            "could not find git repository from '{}': {}",
            path.display(),
            e.message()
        ))
    })
}

pub fn project_root_for_path(path: &Path) -> AppResult<PathBuf> {
    let path = path.canonicalize()?;
    match Repository::discover(&path) {
        Ok(repo) => {
            let Some(workdir) = repo.workdir() else {
                return Ok(path);
            };
            workdir.canonicalize().map_err(|err| {
                AppError::Io(std::io::Error::new(
                    err.kind(),
                    format!(
                        "failed to resolve repository workdir '{}': {err}",
                        workdir.display()
                    ),
                ))
            })
        }
        Err(err)
            if err.code() == git2::ErrorCode::NotFound
                && !repository_marker_in_ancestry(&path)? =>
        {
            Ok(path)
        }
        Err(err) => Err(AppError::Git(err)),
    }
}

/// Libgit2 can report a broken or inaccessible `.git` entry as `NotFound`.
/// Before treating that code as proof a picked folder is not a repository,
/// verify that no repository marker exists anywhere in its ancestry.
fn repository_marker_in_ancestry(path: &Path) -> AppResult<bool> {
    let metadata = std::fs::metadata(path)?;
    let mut directory = if metadata.is_dir() {
        Some(path)
    } else {
        path.parent()
    };
    while let Some(current) = directory {
        let marker = current.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Ok(_) => return Ok(true),
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(AppError::Io(std::io::Error::new(
                    err.kind(),
                    format!(
                        "failed to inspect repository marker '{}': {err}",
                        marker.display()
                    ),
                )));
            }
        }
        directory = current.parent();
    }
    Ok(false)
}

fn walk_to_existing_ancestor(path: &Path) -> PathBuf {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => probe = parent.to_path_buf(),
            _ => return path.to_path_buf(),
        }
    }
    probe
}

pub fn worktree_root(repo_path: &Path) -> PathBuf {
    repo_path.join(ACORN_DIR).join("worktrees")
}

fn ensure_git_excluded(repo: &Repository) -> AppResult<()> {
    // A linked worktree's `Repository::path()` is its per-worktree admin
    // directory. Ignore rules live in the shared Git common directory, so use
    // `commondir()` for both main and linked worktree repositories.
    let common_dir = repo.commondir().canonicalize()?;
    let info_dir = common_dir.join("info");
    ensure_real_directory(&info_dir)?;
    let exclude_path = info_dir.join("exclude");

    let mut file = open_git_exclude(&exclude_path)?;
    let mut contents = Vec::with_capacity(
        usize::try_from(file.metadata()?.len().min(MAX_GIT_EXCLUDE_BYTES)).unwrap_or(0),
    );
    (&mut file)
        .take(MAX_GIT_EXCLUDE_BYTES + 1)
        .read_to_end(&mut contents)?;
    if contents.len() as u64 > MAX_GIT_EXCLUDE_BYTES {
        return Err(AppError::InvalidPath(format!(
            "Git exclude file exceeds {MAX_GIT_EXCLUDE_BYTES} bytes: {}",
            exclude_path.display()
        )));
    }

    let already = String::from_utf8_lossy(&contents)
        .lines()
        .any(|line| line.trim() == EXCLUDE_ENTRY);
    if already {
        return Ok(());
    }

    writeln!(file, "{EXCLUDE_ENTRY}")?;
    Ok(())
}

fn ensure_real_directory(path: &Path) -> AppResult<()> {
    ensure_real_directory_named(path, "Git metadata path")
}

fn ensure_real_directory_named(path: &Path, label: &str) -> AppResult<()> {
    loop {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::InvalidPath(format!(
                        "{label} must be a real directory: {}",
                        path.display()
                    )));
                }
                return Ok(());
            }
            Err(err) if err.kind() == ErrorKind::NotFound => match std::fs::create_dir(path) {
                Ok(()) => {}
                Err(create_err) if create_err.kind() == ErrorKind::AlreadyExists => {}
                Err(create_err) => return Err(create_err.into()),
            },
            Err(err) => return Err(err.into()),
        }
    }
}

fn open_git_exclude(path: &Path) -> AppResult<File> {
    loop {
        match std::fs::symlink_metadata(path) {
            Ok(path_metadata) => {
                validate_git_exclude_metadata(path, &path_metadata)?;
                let file = OpenOptions::new().read(true).append(true).open(path)?;
                let opened_metadata = file.metadata()?;
                validate_git_exclude_metadata(path, &opened_metadata)?;
                validate_same_file(path, &path_metadata, &opened_metadata)?;
                return Ok(file);
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                match OpenOptions::new()
                    .read(true)
                    .append(true)
                    .create_new(true)
                    .open(path)
                {
                    Ok(file) => {
                        validate_git_exclude_metadata(path, &file.metadata()?)?;
                        return Ok(file);
                    }
                    Err(create_err) if create_err.kind() == ErrorKind::AlreadyExists => {}
                    Err(create_err) => return Err(create_err.into()),
                }
            }
            Err(err) => return Err(err.into()),
        }
    }
}

fn validate_git_exclude_metadata(path: &Path, metadata: &Metadata) -> AppResult<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "Git exclude path must be a regular file: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(AppError::InvalidPath(format!(
                "Git exclude path must not be hard-linked: {}",
                path.display()
            )));
        }
    }
    if metadata.len() > MAX_GIT_EXCLUDE_BYTES {
        return Err(AppError::InvalidPath(format!(
            "Git exclude file exceeds {MAX_GIT_EXCLUDE_BYTES} bytes: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_same_file(path: &Path, before: &Metadata, opened: &Metadata) -> AppResult<()> {
    use std::os::unix::fs::MetadataExt;

    if before.dev() != opened.dev() || before.ino() != opened.ino() {
        return Err(AppError::InvalidPath(format!(
            "Git exclude file changed while opening: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_same_file(_path: &Path, _before: &Metadata, _opened: &Metadata) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
pub fn create_worktree(repo_path: &Path, name: &str) -> AppResult<PathBuf> {
    create_worktree_from_base_branch(repo_path, name, None)
}

pub fn create_worktree_from_base_branch(
    repo_path: &Path,
    name: &str,
    base_branch: Option<&str>,
) -> AppResult<PathBuf> {
    let repo = ensure_repo(repo_path)?;
    ensure_git_excluded(&repo).ok();
    let root = checked_worktree_root(repo_path, true)?;
    let target = root.join(name);

    if target.exists() {
        return Err(AppError::InvalidPath(format!(
            "worktree path already exists: {}",
            target.display()
        )));
    }

    let base = worktree_base_commit(&repo, base_branch)?;
    repo.branch(name, &base, false)?;
    let branch_ref_name = format!("refs/heads/{name}");
    let branch_ref = repo.find_reference(&branch_ref_name)?;
    let mut opts = WorktreeAddOptions::new();
    opts.checkout_existing(true).reference(Some(&branch_ref));
    if let Err(err) = repo.worktree(name, &target, Some(&opts)) {
        if let Ok(mut branch) = repo.find_branch(name, BranchType::Local) {
            let _ = branch.delete();
        }
        return Err(err.into());
    }
    Ok(target)
}

#[derive(Debug, Clone, Copy)]
pub struct EnsureWorktreeOptions<'a> {
    pub create_if_missing: bool,
    pub fetch_ref: Option<&'a str>,
    pub base_branch: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnsuredWorktree {
    pub path: String,
    pub branch: String,
    pub created: bool,
}

/// Guarantee a checkout of `branch` — reuse an existing one, or add a linked
/// worktree under `.acorn/worktrees/`. The git branch name and the worktree
/// directory name are independent so a PR head like `feature/foo` can live in
/// `pr-91-foo` without minting a second branch.
pub fn ensure_worktree_for_branch(
    repo_path: &Path,
    branch: &str,
    worktree_name_hint: &str,
    options: EnsureWorktreeOptions<'_>,
) -> AppResult<EnsuredWorktree> {
    let branch = normalize_local_branch_name(branch)?;
    if let Some(fetch_ref) = options.fetch_ref {
        validate_pull_head_fetch_ref(fetch_ref)?;
    }
    let hint = sanitize_worktree_dir_name(worktree_name_hint);

    if let Some(path) = find_checkout_for_branch(repo_path, &branch)? {
        return Ok(ensured_worktree(path, branch, false));
    }

    materialize_local_branch(repo_path, &branch, &options)?;

    if let Some(path) = find_checkout_for_branch(repo_path, &branch)? {
        return Ok(ensured_worktree(path, branch, false));
    }

    match add_worktree_for_local_branch(repo_path, &branch, &hint) {
        Ok(path) => Ok(ensured_worktree(path, branch, true)),
        Err(error) => {
            if let Some(path) = find_checkout_for_branch(repo_path, &branch)? {
                return Ok(ensured_worktree(path, branch, false));
            }
            Err(error)
        }
    }
}

fn ensured_worktree(path: PathBuf, branch: String, created: bool) -> EnsuredWorktree {
    EnsuredWorktree {
        path: path.to_string_lossy().into_owned(),
        branch,
        created,
    }
}

fn normalize_local_branch_name(branch: &str) -> AppResult<String> {
    let branch = branch.trim();
    let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch).trim();
    validate_git_branch_name(branch)?;
    Ok(branch.to_string())
}

fn validate_git_branch_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::Other("branch name must not be empty".into()));
    }
    if name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name.contains('\0')
    {
        return Err(AppError::Other(format!("invalid branch name: {name}")));
    }
    if name.bytes().any(|byte| {
        byte.is_ascii_control()
            || matches!(
                byte,
                b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\' | b'\x7f'
            )
    }) {
        return Err(AppError::Other(format!("invalid branch name: {name}")));
    }
    Ok(())
}

fn validate_pull_head_fetch_ref(fetch_ref: &str) -> AppResult<()> {
    let valid = fetch_ref
        .strip_prefix("refs/pull/")
        .and_then(|rest| rest.strip_suffix("/head"))
        .is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        });
    if valid {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "unsupported fetch ref: {fetch_ref}"
        )))
    }
}

fn sanitize_worktree_dir_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "worktree".to_string()
    } else {
        trimmed.to_string()
    }
}

fn find_checkout_for_branch(repo_path: &Path, branch: &str) -> AppResult<Option<PathBuf>> {
    let repo = ensure_repo(repo_path)?;
    if let Some(workdir) = repo.workdir() {
        if current_branch(workdir).ok().as_deref() == Some(branch) {
            return Ok(Some(workdir.to_path_buf()));
        }
    }
    for path in list_worktree_paths(repo_path)? {
        if current_branch(&path).ok().as_deref() == Some(branch) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn materialize_local_branch(
    repo_path: &Path,
    branch: &str,
    options: &EnsureWorktreeOptions<'_>,
) -> AppResult<()> {
    let repo = ensure_repo(repo_path)?;
    if repo.find_reference(&format!("refs/heads/{branch}")).is_ok() {
        return Ok(());
    }

    let remote_ref = format!("refs/remotes/origin/{branch}");
    if repo.find_reference(&remote_ref).is_ok() {
        create_local_branch_from_ref(&repo, branch, &remote_ref)?;
        return Ok(());
    }
    drop(repo);

    if let Some(fetch_ref) = options.fetch_ref {
        fetch_ref_into_branch(repo_path, fetch_ref, branch)?;
        return Ok(());
    }

    if options.create_if_missing {
        let repo = ensure_repo(repo_path)?;
        let base = worktree_base_commit(&repo, options.base_branch)?;
        repo.branch(branch, &base, false)?;
        return Ok(());
    }

    Err(AppError::Other(format!("branch was not found: {branch}")))
}

fn create_local_branch_from_ref(
    repo: &Repository,
    branch: &str,
    source_ref: &str,
) -> AppResult<()> {
    let commit = repo.find_reference(source_ref)?.peel_to_commit()?;
    repo.branch(branch, &commit, false)?;
    Ok(())
}

fn fetch_ref_into_branch(repo_path: &Path, fetch_ref: &str, branch: &str) -> AppResult<()> {
    let spec = format!("{fetch_ref}:refs/heads/{branch}");
    let output = crate::cli_resolver::run("git", |cmd| {
        cmd.current_dir(repo_path);
        cmd.args(["fetch", "origin", &spec]);
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = stderr.trim();
    let detail = if detail.is_empty() {
        stdout.trim()
    } else {
        detail
    };
    Err(AppError::Other(if detail.is_empty() {
        format!("failed to fetch {fetch_ref}")
    } else {
        format!("failed to fetch {fetch_ref}: {detail}")
    }))
}

fn add_worktree_for_local_branch(repo_path: &Path, branch: &str, hint: &str) -> AppResult<PathBuf> {
    let repo = ensure_repo(repo_path)?;
    ensure_git_excluded(&repo).ok();
    let (name, target) = unique_managed_worktree_target(&repo, repo_path, hint)?;
    let branch_ref_name = format!("refs/heads/{branch}");
    let branch_ref = repo.find_reference(&branch_ref_name)?;
    let mut opts = WorktreeAddOptions::new();
    opts.checkout_existing(true).reference(Some(&branch_ref));
    repo.worktree(&name, &target, Some(&opts))?;
    Ok(target)
}

fn unique_managed_worktree_target(
    repo: &Repository,
    repo_path: &Path,
    hint: &str,
) -> AppResult<(String, PathBuf)> {
    let root = checked_worktree_root(repo_path, true)?;
    let mut n = 1u32;
    loop {
        let name = if n == 1 {
            hint.to_string()
        } else {
            format!("{hint}-{n}")
        };
        let target = root.join(&name);
        let registration_taken = match repo.find_worktree(&name) {
            Ok(_) => true,
            Err(err) if err.code() == ErrorCode::NotFound => false,
            Err(err) => return Err(err.into()),
        };
        if !target.exists() && !registration_taken {
            return Ok((name, target));
        }
        if n >= 100 {
            return Err(AppError::Other(format!(
                "could not find a free worktree name for {hint}"
            )));
        }
        n += 1;
    }
}

pub fn validate_worktree_base_branch(repo_path: &Path, branch: &str) -> AppResult<()> {
    let repo = ensure_repo(repo_path)?;
    configured_worktree_base_commit(&repo, branch).map(|_| ())
}

fn worktree_base_commit<'repo>(
    repo: &'repo Repository,
    configured_branch: Option<&str>,
) -> AppResult<git2::Commit<'repo>> {
    if let Some(branch) = configured_branch {
        return configured_worktree_base_commit(repo, branch);
    }

    // Acorn-created worktrees start from the project's stable default branch,
    // not whichever feature branch the project root is currently using.
    for name in [
        "refs/heads/main",
        "refs/remotes/origin/main",
        "refs/heads/master",
        "refs/remotes/origin/master",
    ] {
        if let Ok(commit) = repo
            .find_reference(name)
            .and_then(|reference| reference.peel_to_commit())
        {
            return Ok(commit);
        }
    }
    Ok(repo.head()?.peel_to_commit()?)
}

fn configured_worktree_base_commit<'repo>(
    repo: &'repo Repository,
    branch: &str,
) -> AppResult<git2::Commit<'repo>> {
    let branch = branch.trim();
    let candidates = if branch.starts_with("refs/heads/") || branch.starts_with("refs/remotes/") {
        vec![branch.to_string()]
    } else if branch.starts_with("refs/") {
        Vec::new()
    } else {
        vec![
            format!("refs/heads/{branch}"),
            format!("refs/remotes/{branch}"),
            format!("refs/remotes/origin/{branch}"),
        ]
    };

    for name in candidates {
        if let Ok(commit) = repo
            .find_reference(&name)
            .and_then(|reference| reference.peel_to_commit())
        {
            return Ok(commit);
        }
    }

    Err(AppError::Other(format!(
        "configured worktree base branch was not found: {branch}"
    )))
}

/// Returns absolute on-disk paths of linked worktrees. Used by the
/// post-PTY-exit "did claude just create a worktree?" detector — names alone
/// aren't enough because we need to point a session at the new worktree's
/// directory to respawn the child there.
///
/// Note: this only enumerates *linked* worktrees. The main repo checkout is
/// excluded; libgit2's `worktrees()` only reports `.git/worktrees/<name>`
/// entries. That matches what we want — `claude -w` always adds a linked
/// worktree, never modifies the main one.
/// List every registered linked worktree path.
///
/// Callers treat the result as authoritative — `authorize_registered_worktree`
/// denies anything missing from it — so a registration that cannot be read has
/// to be an error rather than an omission.
///
/// libgit2's own `git_worktree_list` silently drops a registration directory it
/// cannot read, and the name never reaches us, so propagating its errors is not
/// enough. Enumerate `<commondir>/worktrees` ourselves and resolve each entry
/// through libgit2, failing the whole batch if any step fails.
///
/// A *stale* registration (the checkout was deleted, the registration remains)
/// still resolves here and yields its recorded path — that is the case
/// `stage_remove_worktree_at_path` prunes — so only a genuinely unreadable
/// registration fails the listing.
pub fn list_worktree_paths(repo_path: &Path) -> AppResult<Vec<std::path::PathBuf>> {
    let repo = ensure_repo(repo_path)?;
    let registrations = repo.commondir().join("worktrees");
    let entries = match std::fs::read_dir(&registrations) {
        Ok(entries) => entries,
        // No linked worktree has ever been created for this repository.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(AppError::Io(std::io::Error::new(
                error.kind(),
                format!(
                    "failed to read linked worktree registrations in {}: {error}",
                    registrations.display()
                ),
            )))
        }
    };

    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            AppError::Io(std::io::Error::new(
                error.kind(),
                format!(
                    "failed to read a linked worktree registration in {}: {error}",
                    registrations.display()
                ),
            ))
        })?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            AppError::InvalidPath(format!(
                "linked worktree registration name is not valid UTF-8: {}",
                entry.path().display()
            ))
        })?;
        paths.push(repo.find_worktree(name)?.path().to_path_buf());
    }
    Ok(paths)
}

pub fn list_worktree_infos(repo_path: &Path) -> AppResult<Vec<ProjectWorktreeInfo>> {
    let mut infos: Vec<ProjectWorktreeInfo> = list_worktree_paths(repo_path)?
        .into_iter()
        .map(project_worktree_info_from_path)
        .collect();
    infos.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(infos)
}

pub fn list_branch_infos(repo_path: &Path) -> AppResult<Vec<ProjectBranchInfo>> {
    let repo = ensure_repo(repo_path)?;
    let mut infos = Vec::new();
    for entry in repo.branches(None)? {
        let (branch, kind) = entry?;
        if branch.get().symbolic_target()?.is_some() {
            continue;
        }
        let Some(name) = branch.name()? else {
            continue;
        };
        infos.push(ProjectBranchInfo {
            name: name.to_string(),
            is_remote: kind == BranchType::Remote,
        });
    }
    infos.sort_by(|a, b| {
        a.is_remote
            .cmp(&b.is_remote)
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(infos)
}

fn project_worktree_info_from_path(path: PathBuf) -> ProjectWorktreeInfo {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let modified_ms = std::fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(system_time_millis);
    ProjectWorktreeInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        modified_ms,
    }
}

fn system_time_millis(time: SystemTime) -> Option<i64> {
    let millis = time.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

/// `Path::exists()` reports a metadata access failure as `false`. Every caller
/// below acts destructively on that answer — pruning a Git registration or
/// reporting "already gone" to a caller that then drops the session record — so
/// an inaccessible path has to be an error, not an absent one.
fn path_entry_exists(path: &Path) -> AppResult<bool> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::Io(std::io::Error::new(
            error.kind(),
            format!(
                "failed to inspect worktree path {}: {error}",
                path.display()
            ),
        ))),
    }
}

pub fn stage_remove_worktree_at_path(
    repo_path: &Path,
    worktree_path: &Path,
) -> AppResult<Option<RemovedWorktree>> {
    if path_entry_exists(worktree_path)? && !is_linked_worktree_root(worktree_path) {
        return Err(AppError::InvalidPath(format!(
            "not a linked git worktree: {}",
            worktree_path.display()
        )));
    }

    let repo = ensure_repo(repo_path)?;
    let names = repo.worktrees()?;
    for name in names.iter().filter_map(|name| name.ok().flatten()) {
        let wt = repo.find_worktree(name)?;
        if same_path(wt.path(), worktree_path) {
            if !path_entry_exists(worktree_path)? {
                if has_staged_worktree_backup(worktree_path)? {
                    return Ok(None);
                }
                prune_missing_registered_worktree(&wt, worktree_path)?;
                return Ok(None);
            }
            validate_real_directory_entry(worktree_path, "linked worktree path")?;
            let token = Uuid::new_v4().to_string();
            let backup_root = ensure_removed_worktree_backup_root(worktree_path)?;
            let backup = backup_root.join(&token);
            std::fs::rename(worktree_path, &backup)?;
            if let Err(error) = validate_real_directory_entry(&backup, "removed worktree backup") {
                let _ = std::fs::rename(&backup, worktree_path);
                return Err(error);
            }
            return Ok(Some(RemovedWorktree {
                token,
                repo_path: repo_path.to_string_lossy().into_owned(),
                worktree_path: worktree_path.to_string_lossy().into_owned(),
                git_common_dir: repo.commondir().to_string_lossy().into_owned(),
            }));
        }
    }

    if is_acorn_managed_worktree_path(repo_path, worktree_path)? {
        if path_entry_exists(worktree_path)? && is_linked_worktree_root(worktree_path) {
            std::fs::remove_dir_all(worktree_path)?;
            return Ok(None);
        }
        if !path_entry_exists(worktree_path)? {
            return Ok(None);
        }
    }

    if !path_entry_exists(worktree_path)? {
        return Ok(None);
    }

    Err(AppError::InvalidPath(format!(
        "linked git worktree is not registered: {}",
        worktree_path.display()
    )))
}

#[cfg(test)]
pub fn remove_worktree_at_path(repo_path: &Path, worktree_path: &Path) -> AppResult<()> {
    if let Some(removed) = stage_remove_worktree_at_path(repo_path, worktree_path)? {
        discard_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )?;
    }
    Ok(())
}

pub fn restore_removed_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    token: &str,
    git_common_dir: &Path,
) -> AppResult<()> {
    validate_removal_token(token)?;
    let backup = existing_removed_worktree_backup_root(worktree_path)?
        .map(|root| root.join(token))
        .ok_or_else(|| {
            AppError::InvalidPath(format!(
                "removed worktree backup is not available for: {}",
                worktree_path.display()
            ))
        })?;
    if matches!(
        std::fs::symlink_metadata(&backup),
        Err(error) if error.kind() == ErrorKind::NotFound
    ) {
        return Err(AppError::InvalidPath(format!(
            "removed worktree backup is not available: {}",
            backup.display()
        )));
    }
    validate_real_directory_entry(&backup, "removed worktree backup")?;
    let repo = validate_removal_repository(repo_path, git_common_dir)?;
    validate_removed_worktree_backup(&repo, worktree_path, &backup)?;
    match std::fs::symlink_metadata(worktree_path) {
        Ok(_) => {
            return Err(AppError::InvalidPath(format!(
                "worktree path already exists: {}",
                worktree_path.display()
            )));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    std::fs::rename(&backup, worktree_path)?;
    if let Err(error) = validate_real_directory_entry(worktree_path, "restored worktree path") {
        let _ = std::fs::rename(worktree_path, &backup);
        return Err(error);
    }
    remove_empty_backup_root(worktree_path);
    Ok(())
}

pub fn discard_removed_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    token: &str,
    git_common_dir: &Path,
) -> AppResult<()> {
    validate_removal_token(token)?;
    let repo = validate_removal_repository(repo_path, git_common_dir)?;
    if let Some(root) = existing_removed_worktree_backup_root(worktree_path)? {
        let backup = root.join(token);
        match std::fs::symlink_metadata(&backup) {
            Ok(_) => {
                validate_real_directory_entry(&backup, "removed worktree backup")?;
                validate_removed_worktree_backup(&repo, worktree_path, &backup)?;
                std::fs::remove_dir_all(&backup)?;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    remove_empty_backup_root(worktree_path);
    if worktree_path.exists() {
        return Ok(());
    }
    prune_registered_worktree_at_path(&repo, worktree_path)?;
    Ok(())
}

fn validate_removal_repository(repo_path: &Path, git_common_dir: &Path) -> AppResult<Repository> {
    let repo = ensure_repo(repo_path)?;
    let expected = repo.commondir().canonicalize()?;
    let supplied = git_common_dir.canonicalize().map_err(|_| {
        AppError::InvalidPath(format!(
            "Git common directory is missing: {}",
            git_common_dir.display()
        ))
    })?;
    if supplied != expected {
        return Err(AppError::InvalidPath(format!(
            "Git common directory does not match the repository: {}",
            git_common_dir.display()
        )));
    }
    Ok(repo)
}

fn validate_removed_worktree_backup(
    repo: &Repository,
    worktree_path: &Path,
    backup_path: &Path,
) -> AppResult<()> {
    validate_real_directory_entry(backup_path, "removed worktree backup")?;
    let worktree_name = repo
        .worktrees()?
        .iter()
        .filter_map(|name| name.ok().flatten())
        .find_map(|name| {
            let worktree = repo.find_worktree(name).ok()?;
            same_path_with_resolved_parent(worktree.path(), worktree_path).then(|| name.to_string())
        })
        .ok_or_else(|| {
            AppError::InvalidPath(format!(
                "removed worktree is not registered: {}",
                worktree_path.display()
            ))
        })?;
    let expected_git_dir = repo
        .commondir()
        .join("worktrees")
        .join(worktree_name)
        .canonicalize()?;
    let backup_repo = Repository::open(backup_path).map_err(|_| {
        AppError::InvalidPath(format!(
            "removed worktree backup is not a valid repository: {}",
            backup_path.display()
        ))
    })?;
    let backup_git_dir = backup_repo.path().canonicalize()?;
    if backup_git_dir != expected_git_dir {
        return Err(AppError::InvalidPath(format!(
            "removed worktree backup does not match its registered path: {}",
            worktree_path.display()
        )));
    }
    Ok(())
}

fn same_path_with_resolved_parent(left: &Path, right: &Path) -> bool {
    fn resolve(path: &Path) -> PathBuf {
        path.canonicalize().unwrap_or_else(|_| {
            path.parent()
                .and_then(|parent| parent.canonicalize().ok())
                .and_then(|parent| path.file_name().map(|name| parent.join(name)))
                .unwrap_or_else(|| path.to_path_buf())
        })
    }

    resolve(left) == resolve(right)
}

fn prune_registered_worktree_at_path(repo: &Repository, worktree_path: &Path) -> AppResult<bool> {
    let names = repo.worktrees()?;
    for name in names.iter().filter_map(|name| name.ok().flatten()) {
        let wt = repo.find_worktree(name)?;
        if same_path(wt.path(), worktree_path) {
            prune_missing_registered_worktree(&wt, worktree_path)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn prune_missing_registered_worktree(wt: &git2::Worktree, worktree_path: &Path) -> AppResult<()> {
    let mut options = WorktreePruneOptions::new();
    if !worktree_path.exists() {
        options.locked(true);
    }
    wt.prune(Some(&mut options))?;
    Ok(())
}

fn removed_worktree_backup_root_path(worktree_path: &Path) -> AppResult<PathBuf> {
    let parent = worktree_path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!(
            "worktree path has no parent directory: {}",
            worktree_path.display()
        ))
    })?;
    Ok(parent.join(DELETED_WORKTREES_DIR))
}

fn ensure_removed_worktree_backup_root(worktree_path: &Path) -> AppResult<PathBuf> {
    let root = removed_worktree_backup_root_path(worktree_path)?;
    ensure_real_directory_named(&root, "removed worktree backup root")?;
    validate_removed_worktree_backup_root(worktree_path, &root)?;
    Ok(root)
}

fn existing_removed_worktree_backup_root(worktree_path: &Path) -> AppResult<Option<PathBuf>> {
    let root = removed_worktree_backup_root_path(worktree_path)?;
    match std::fs::symlink_metadata(&root) {
        Ok(_) => {
            validate_real_directory_entry(&root, "removed worktree backup root")?;
            validate_removed_worktree_backup_root(worktree_path, &root)?;
            Ok(Some(root))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn validate_removed_worktree_backup_root(worktree_path: &Path, root: &Path) -> AppResult<()> {
    let parent = worktree_path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!(
            "worktree path has no parent directory: {}",
            worktree_path.display()
        ))
    })?;
    let canonical_parent = parent.canonicalize()?;
    let canonical_root = root.canonicalize()?;
    if canonical_root.parent() != Some(canonical_parent.as_path()) {
        return Err(AppError::InvalidPath(format!(
            "removed worktree backup root escapes its parent: {}",
            root.display()
        )));
    }
    Ok(())
}

fn validate_real_directory_entry(path: &Path, label: &str) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{label} must be a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_removal_token(token: &str) -> AppResult<()> {
    let safe = !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if safe {
        return Ok(());
    }
    Err(AppError::InvalidPath(
        "invalid worktree removal token".into(),
    ))
}

fn remove_empty_backup_root(worktree_path: &Path) {
    let Ok(root) = removed_worktree_backup_root_path(worktree_path) else {
        return;
    };
    if std::fs::symlink_metadata(&root)
        .map(|metadata| !metadata.file_type().is_symlink() && metadata.is_dir())
        .unwrap_or(false)
    {
        let _ = std::fs::remove_dir(&root);
    }
}

fn has_staged_worktree_backup(worktree_path: &Path) -> AppResult<bool> {
    let Some(root) = existing_removed_worktree_backup_root(worktree_path)? else {
        return Ok(false);
    };
    Ok(root.read_dir()?.next().is_some())
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_acorn_managed_worktree_path(repo_path: &Path, worktree_path: &Path) -> AppResult<bool> {
    if worktree_path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Ok(false);
    }
    let root = checked_worktree_root(repo_path, false)?;
    Ok(worktree_path.parent() == Some(root.as_path()) && worktree_path.file_name().is_some())
}

/// Validate Acorn's managed-worktree storage without following repository-
/// controlled symlinks. A cloned repository can contain `.acorn` (or a
/// `worktrees` entry beneath it) as a symlink; blindly creating or deleting
/// through that path would escape the repository boundary.
fn checked_worktree_root(repo_path: &Path, create: bool) -> AppResult<PathBuf> {
    let canonical_repo = repo_path.canonicalize()?;
    if !canonical_repo.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "repository path is not a directory: {}",
            repo_path.display()
        )));
    }

    let acorn_dir = repo_path.join(ACORN_DIR);
    let root = worktree_root(repo_path);
    if !checked_directory_component(&acorn_dir, create)? {
        return Ok(root);
    }
    if !checked_directory_component(&root, create)? {
        return Ok(root);
    }

    let canonical_root = root.canonicalize()?;
    if !canonical_root.starts_with(&canonical_repo) {
        return Err(AppError::InvalidPath(format!(
            "managed worktree root escapes repository: {}",
            root.display()
        )));
    }
    Ok(root)
}

fn checked_directory_component(path: &Path, create: bool) -> AppResult<bool> {
    loop {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::InvalidPath(format!(
                        "managed worktree path component must be a real directory: {}",
                        path.display()
                    )));
                }
                return Ok(true);
            }
            Err(err) if err.kind() == ErrorKind::NotFound && create => {
                match std::fs::create_dir(path) {
                    Ok(()) => {}
                    Err(create_err) if create_err.kind() == ErrorKind::AlreadyExists => {}
                    Err(create_err) => return Err(create_err.into()),
                }
                // Re-read with symlink_metadata after creation so a component
                // that appeared concurrently is validated before use.
            }
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(err.into()),
        }
    }
}

/// Returns `true` when `path` is the root of a *linked* git worktree.
/// Linked worktrees mark their root with a `.git` *file* (pointing at the
/// parent repo's `worktrees/<name>` admin dir) instead of a `.git` directory.
/// Cheap: a single stat, no libgit2 open. Used to surface a worktree
/// indicator on session tabs regardless of how the worktree was created
/// (Acorn's "new isolated session" button, `claude -w` adoption, or a
/// repo that was already a worktree when added as a project).
pub fn is_linked_worktree_root(path: &Path) -> bool {
    std::fs::symlink_metadata(path.join(".git"))
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

pub fn current_branch(repo_path: &Path) -> AppResult<String> {
    let repo = ensure_repo(repo_path)?;
    let head = repo.head()?;
    Ok(head
        .shorthand()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "HEAD".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "acorn-worktree-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn init_repo_with_tracked_file(path: &Path) -> Repository {
        let repo = Repository::init(path).expect("init repo");
        std::fs::write(path.join("tracked.txt"), "initial").expect("write tracked file");
        let sig = git2::Signature::now("acorn-test", "test@acorn").expect("sig");
        let tree_id = {
            let mut idx = repo.index().expect("index");
            idx.add_path(Path::new("tracked.txt"))
                .expect("add tracked file");
            idx.write_tree().expect("write tree")
        };
        let tree = repo.find_tree(tree_id).expect("find tree");
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .expect("initial commit");
        drop(tree);
        repo
    }

    fn checkout_branch(repo: &Repository, name: &str) {
        let refname = format!("refs/heads/{name}");
        let object = repo
            .revparse_single(&refname)
            .unwrap_or_else(|_| panic!("find {refname}"));
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.checkout_tree(&object, Some(&mut checkout))
            .unwrap_or_else(|_| panic!("checkout {refname} tree"));
        repo.set_head(&refname)
            .unwrap_or_else(|_| panic!("set HEAD to {refname}"));
    }

    fn git_exclude_path(repo: &Repository) -> PathBuf {
        repo.commondir().join("info").join("exclude")
    }

    #[test]
    fn ensure_git_excluded_creates_missing_file_and_keeps_existing_rules() {
        let root = unique_temp_dir("git-exclude-normal");
        let repo = Repository::init(&root).expect("init repo");
        let exclude = git_exclude_path(&repo);
        std::fs::remove_file(&exclude).ok();

        ensure_git_excluded(&repo).expect("create missing exclude");
        assert_eq!(
            std::fs::read_to_string(&exclude).expect("read created exclude"),
            format!("{EXCLUDE_ENTRY}\n")
        );

        std::fs::write(&exclude, "custom-rule\n").expect("write existing exclude");
        ensure_git_excluded(&repo).expect("append Acorn rule");
        ensure_git_excluded(&repo).expect("keep Acorn rule idempotent");
        let contents = std::fs::read_to_string(&exclude).expect("read updated exclude");
        assert!(contents.starts_with("custom-rule\n"));
        assert_eq!(
            contents
                .lines()
                .filter(|line| line.trim() == EXCLUDE_ENTRY)
                .count(),
            1
        );

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_git_excluded_uses_common_dir_for_linked_worktree() {
        let root = unique_temp_dir("git-exclude-linked");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "linked").expect("create linked worktree");
        let linked_repo = Repository::open(&worktree_path).expect("open linked worktree");
        let exclude = git_exclude_path(&linked_repo);
        std::fs::write(&exclude, "shared-rule\n").expect("reset shared exclude");

        ensure_git_excluded(&linked_repo).expect("update common exclude");

        let contents = std::fs::read_to_string(root.join(".git/info/exclude"))
            .expect("read main repository exclude");
        assert!(contents.contains("shared-rule"));
        assert!(contents.lines().any(|line| line.trim() == EXCLUDE_ENTRY));

        drop(linked_repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn ensure_git_excluded_rejects_external_symlink_without_modifying_target() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("git-exclude-symlink");
        let external = unique_temp_dir("git-exclude-symlink-external");
        let sentinel = external.join("sentinel.txt");
        std::fs::write(&sentinel, "do not modify\n").expect("write sentinel");
        let repo = Repository::init(&root).expect("init repo");
        let exclude = git_exclude_path(&repo);
        std::fs::remove_file(&exclude).ok();
        symlink(&sentinel, &exclude).expect("link exclude to sentinel");

        let error = ensure_git_excluded(&repo).expect_err("symlink must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert_eq!(
            std::fs::read_to_string(&sentinel).expect("read sentinel"),
            "do not modify\n"
        );

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    #[cfg(unix)]
    #[test]
    fn ensure_git_excluded_rejects_external_hardlink_without_modifying_target() {
        let root = unique_temp_dir("git-exclude-hardlink");
        let external = unique_temp_dir("git-exclude-hardlink-external");
        let sentinel = external.join("sentinel.txt");
        std::fs::write(&sentinel, "do not modify\n").expect("write sentinel");
        let repo = Repository::init(&root).expect("init repo");
        let exclude = git_exclude_path(&repo);
        std::fs::remove_file(&exclude).ok();
        std::fs::hard_link(&sentinel, &exclude).expect("hard-link exclude to sentinel");

        let error = ensure_git_excluded(&repo).expect_err("hardlink must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert_eq!(
            std::fs::read_to_string(&sentinel).expect("read sentinel"),
            "do not modify\n"
        );

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    #[test]
    fn ensure_git_excluded_rejects_oversized_file() {
        let root = unique_temp_dir("git-exclude-oversized");
        let repo = Repository::init(&root).expect("init repo");
        let exclude = git_exclude_path(&repo);
        File::create(&exclude)
            .expect("create exclude")
            .set_len(MAX_GIT_EXCLUDE_BYTES + 1)
            .expect("make exclude oversized");

        let error = ensure_git_excluded(&repo).expect_err("oversized exclude must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert_eq!(
            std::fs::metadata(&exclude).expect("exclude metadata").len(),
            MAX_GIT_EXCLUDE_BYTES + 1
        );

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_git_excluded_rejects_non_regular_file() {
        let root = unique_temp_dir("git-exclude-non-regular");
        let repo = Repository::init(&root).expect("init repo");
        let exclude = git_exclude_path(&repo);
        std::fs::remove_file(&exclude).ok();
        std::fs::create_dir(&exclude).expect("replace exclude with directory");

        let error = ensure_git_excluded(&repo).expect_err("directory must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));

        drop(repo);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_worktree_starts_new_branch_from_main_when_head_is_elsewhere() {
        let root = unique_temp_dir("base-main");
        let repo = init_repo_with_tracked_file(&root);
        let sig = git2::Signature::now("acorn-test", "test@acorn").expect("sig");
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        let main_oid = initial.id();
        repo.branch("main", &initial, false)
            .expect("create main branch");
        repo.branch("feature", &initial, false)
            .expect("create feature branch");
        drop(initial);

        checkout_branch(&repo, "feature");
        std::fs::write(root.join("tracked.txt"), "feature").expect("write feature contents");
        let tree_id = {
            let mut idx = repo.index().expect("index");
            idx.add_path(Path::new("tracked.txt"))
                .expect("add feature file");
            idx.write_tree().expect("write feature tree")
        };
        let tree = repo.find_tree(tree_id).expect("feature tree");
        let parent = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("feature parent");
        repo.commit(Some("HEAD"), &sig, &sig, "feature", &tree, &[&parent])
            .expect("feature commit");
        drop(parent);
        drop(tree);
        drop(repo);

        let worktree_path = create_worktree(&root, "worker").expect("create worktree");
        let worktree_repo = Repository::open(&worktree_path).expect("open worktree repo");
        let head = worktree_repo.head().expect("worktree head");

        assert_eq!(head.shorthand().expect("branch shorthand"), "worker");
        assert_eq!(head.target(), Some(main_oid));
        assert_eq!(
            std::fs::read_to_string(worktree_path.join("tracked.txt")).unwrap(),
            "initial"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_worktree_starts_from_configured_base_branch() {
        let root = unique_temp_dir("base-configured");
        let repo = init_repo_with_tracked_file(&root);
        let sig = git2::Signature::now("acorn-test", "test@acorn").expect("sig");
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        repo.branch("main", &initial, false)
            .expect("create main branch");
        repo.branch("develop", &initial, false)
            .expect("create develop branch");
        drop(initial);

        checkout_branch(&repo, "develop");
        std::fs::write(root.join("tracked.txt"), "develop").expect("write develop contents");
        let tree_id = {
            let mut idx = repo.index().expect("index");
            idx.add_path(Path::new("tracked.txt"))
                .expect("add develop file");
            idx.write_tree().expect("write develop tree")
        };
        let tree = repo.find_tree(tree_id).expect("develop tree");
        let parent = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("develop parent");
        let develop_oid = repo
            .commit(Some("HEAD"), &sig, &sig, "develop", &tree, &[&parent])
            .expect("develop commit");
        drop(parent);
        drop(tree);
        checkout_branch(&repo, "main");
        drop(repo);

        let worktree_path = create_worktree_from_base_branch(&root, "worker", Some("develop"))
            .expect("create worktree");
        let worktree_repo = Repository::open(&worktree_path).expect("open worktree repo");
        let head = worktree_repo.head().expect("worktree head");

        assert_eq!(head.shorthand().expect("branch shorthand"), "worker");
        assert_eq!(head.target(), Some(develop_oid));
        assert_eq!(
            std::fs::read_to_string(worktree_path.join("tracked.txt")).unwrap(),
            "develop"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn configured_worktree_base_branch_must_exist() {
        let root = unique_temp_dir("base-missing");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);

        let error = validate_worktree_base_branch(&root, "missing")
            .expect_err("missing base branch must be rejected");

        assert!(error
            .to_string()
            .contains("configured worktree base branch was not found: missing"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn create_worktree_rejects_symlinked_acorn_directory() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("symlinked-acorn");
        let external = unique_temp_dir("symlinked-acorn-external");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        symlink(&external, root.join(ACORN_DIR)).expect("symlink .acorn");

        let error = create_worktree(&root, "worker").expect_err("symlink must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert!(!external.join("worktrees").join("worker").exists());
        let repo = Repository::open(&root).expect("reopen repo");
        assert!(repo.find_branch("worker", BranchType::Local).is_err());

        std::fs::remove_file(root.join(ACORN_DIR)).ok();
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    #[cfg(unix)]
    #[test]
    fn create_worktree_rejects_symlinked_worktrees_directory() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("symlinked-worktrees");
        let external = unique_temp_dir("symlinked-worktrees-external");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        std::fs::create_dir(root.join(ACORN_DIR)).expect("create .acorn");
        symlink(&external, root.join(ACORN_DIR).join("worktrees")).expect("symlink worktrees");

        let error = create_worktree(&root, "worker").expect_err("symlink must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert!(!external.join("worker").exists());
        let repo = Repository::open(&root).expect("reopen repo");
        assert!(repo.find_branch("worker", BranchType::Local).is_err());

        std::fs::remove_file(root.join(ACORN_DIR).join("worktrees")).ok();
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stage_remove_worktree_reports_an_inaccessible_checkout_as_an_error() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_temp_dir("stage-remove-denied");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "denied").expect("create worktree");
        let parent = worktree_path
            .parent()
            .expect("worktree parent")
            .to_path_buf();
        let original = std::fs::metadata(&parent).unwrap().permissions();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = stage_remove_worktree_at_path(&root, &worktree_path);

        let denied = matches!(
            std::fs::metadata(&worktree_path),
            Err(ref error) if error.kind() == std::io::ErrorKind::PermissionDenied
        );
        std::fs::set_permissions(&parent, original).unwrap();
        if denied {
            match result {
                Err(AppError::Io(error)) => {
                    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
                    assert!(error
                        .to_string()
                        .contains("failed to inspect worktree path"));
                }
                other => panic!("an inaccessible checkout must not look absent: {other:?}"),
            }
            assert!(
                worktree_path.exists(),
                "the checkout must survive a failed staging attempt"
            );
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_worktree_paths_still_reports_a_stale_registration() {
        let root = unique_temp_dir("list-stale-registration");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "stale").expect("create worktree");
        std::fs::remove_dir_all(&worktree_path).expect("delete the checkout");

        let paths = list_worktree_paths(&root).expect("a stale registration must still list");

        // Compare by file name: the checkout is gone, so neither side
        // canonicalises and the recorded path may differ in form (on macOS
        // `/var/...` vs `/private/var/...`).
        let expected = worktree_path.file_name().expect("worktree name");
        assert!(
            paths.iter().any(|path| path.file_name() == Some(expected)),
            "the registration outlives its checkout, which is what prune handles; got {paths:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn list_worktree_paths_fails_on_an_unreadable_registration() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_temp_dir("list-unreadable-registration");
        let repo = init_repo_with_tracked_file(&root);
        let registrations = repo.path().join("worktrees");
        drop(repo);
        create_worktree(&root, "blocked").expect("create worktree");
        // Block one registration, not the whole directory: `repo.worktrees()`
        // still enumerates the name, so this exercises the `find_worktree`
        // lookup that used to be skipped rather than the enumeration that
        // already propagated.
        let entry = registrations.join("blocked");
        let original = std::fs::metadata(&entry).unwrap().permissions();
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = list_worktree_paths(&root);

        let denied = matches!(
            std::fs::read_dir(&entry),
            Err(ref error) if error.kind() == std::io::ErrorKind::PermissionDenied
        );
        std::fs::set_permissions(&entry, original).unwrap();
        if denied {
            assert!(
                result.is_err(),
                "an unreadable registration must not silently drop out of the listing; got {result:?}"
            );
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn staged_remove_restore_preserves_uncommitted_files() {
        let root = unique_temp_dir("restore-uncommitted");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "feature").expect("create worktree");
        std::fs::write(worktree_path.join("tracked.txt"), "modified").expect("modify tracked file");
        std::fs::write(worktree_path.join("untracked.txt"), "new").expect("write untracked file");

        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        assert!(!worktree_path.exists(), "worktree should move out of place");

        restore_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("restore worktree");

        assert_eq!(
            std::fs::read_to_string(worktree_path.join("tracked.txt")).unwrap(),
            "modified"
        );
        assert_eq!(
            std::fs::read_to_string(worktree_path.join("untracked.txt")).unwrap(),
            "new"
        );
        assert!(is_linked_worktree_root(&worktree_path));

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn linked_worktree_detection_rejects_symlinked_git_marker() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("linked-marker-symlink");
        let external = unique_temp_dir("linked-marker-symlink-external");
        let marker = external.join("gitdir");
        std::fs::write(&marker, "gitdir: /tmp/elsewhere").expect("write marker target");
        symlink(&marker, root.join(".git")).expect("symlink git marker");

        assert!(!is_linked_worktree_root(&root));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stage_remove_rejects_symlinked_backup_root() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("remove-symlinked-backup-root");
        let external = unique_temp_dir("remove-symlinked-backup-root-external");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "feature").expect("create worktree");
        let backup_root = removed_worktree_backup_root_path(&worktree_path).expect("backup root");
        symlink(&external, &backup_root).expect("symlink backup root");

        let error = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect_err("symlinked backup root must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert!(worktree_path.is_dir());
        assert!(external.read_dir().expect("read external").next().is_none());

        std::fs::remove_file(&backup_root).ok();
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    #[cfg(unix)]
    #[test]
    fn restore_removed_worktree_rejects_symlinked_backup_entry() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("restore-symlinked-backup");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "feature").expect("create worktree");
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");
        let backup = removed_worktree_backup_root_path(&worktree_path)
            .expect("backup root")
            .join(&removed.token);
        let relocated = backup.with_extension("relocated");
        std::fs::rename(&backup, &relocated).expect("relocate backup");
        symlink(&relocated, &backup).expect("symlink backup entry");

        let error = restore_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect_err("symlinked backup entry must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert!(!worktree_path.exists());

        std::fs::remove_file(&backup).expect("remove backup symlink");
        std::fs::rename(&relocated, &backup).expect("restore real backup entry");
        restore_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("restore worktree for cleanup");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn restore_removed_worktree_rejects_a_token_from_another_worktree() {
        let root = unique_temp_dir("restore-token-binding");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let first_path = create_worktree(&root, "first-removed").expect("create first worktree");
        let second_path = create_worktree(&root, "second-removed").expect("create second worktree");
        let first = stage_remove_worktree_at_path(&root, &first_path)
            .expect("stage first removal")
            .expect("first removal token");
        let second = stage_remove_worktree_at_path(&root, &second_path)
            .expect("stage second removal")
            .expect("second removal token");

        let error = restore_removed_worktree(
            Path::new(&first.repo_path),
            Path::new(&second.worktree_path),
            &first.token,
            Path::new(&first.git_common_dir),
        )
        .expect_err("mismatched token and path must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert!(!first_path.exists());
        assert!(!second_path.exists());
        restore_removed_worktree(
            Path::new(&first.repo_path),
            Path::new(&first.worktree_path),
            &first.token,
            Path::new(&first.git_common_dir),
        )
        .expect("restore first worktree");
        restore_removed_worktree(
            Path::new(&second.repo_path),
            Path::new(&second.worktree_path),
            &second.token,
            Path::new(&second.git_common_dir),
        )
        .expect("restore second worktree");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_removed_worktree_prunes_registration() {
        let root = unique_temp_dir("discard");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "discard-me").expect("create worktree");
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        discard_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("discard worktree");

        assert!(!worktree_path.exists());
        assert!(
            !list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "discard should prune the linked worktree registration"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stage_remove_missing_locked_worktree_prunes_registration() {
        let root = unique_temp_dir("missing-locked");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "locked-missing").expect("create worktree");
        {
            let repo = Repository::open(&root).expect("open repo");
            let wt = repo.find_worktree("locked-missing").expect("find worktree");
            wt.lock(Some("claude agent locked-missing (pid 999999)"))
                .expect("lock worktree");
        }
        std::fs::remove_dir_all(&worktree_path).expect("remove worktree dir");

        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("remove missing locked worktree");

        assert!(removed.is_none());
        assert!(
            !list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "missing locked worktree registration should be pruned"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_removed_worktree_prunes_locked_registration() {
        let root = unique_temp_dir("discard-locked");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "discard-locked").expect("create worktree");
        {
            let repo = Repository::open(&root).expect("open repo");
            let wt = repo.find_worktree("discard-locked").expect("find worktree");
            wt.lock(Some("claude agent discard-locked (pid 999999)"))
                .expect("lock worktree");
        }
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        discard_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("discard locked worktree");

        assert!(
            !list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "discard should prune locked linked worktree registration"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn staged_remove_duplicate_call_preserves_registration_for_restore() {
        let root = unique_temp_dir("duplicate-stage");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "duplicate").expect("create worktree");
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        let second =
            stage_remove_worktree_at_path(&root, &worktree_path).expect("second stage remove");
        assert!(second.is_none());

        restore_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("restore worktree");

        assert!(
            list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "duplicate stage should not prune a restorable worktree"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_repo_discovers_from_subdirectory() {
        let root = unique_temp_dir("subdir");
        let repo = Repository::init(&root).expect("init repo");
        // Drop borrow before recreating Repository via discover.
        drop(repo);

        let subdir = root.join("nested").join("deeper");
        std::fs::create_dir_all(&subdir).expect("nested dirs");

        let opened = ensure_repo(&subdir).expect("discover from subdir");
        let workdir = opened.workdir().expect("workdir present");
        assert_eq!(
            workdir.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_root_for_path_returns_repo_workdir_from_subdirectory() {
        let root = unique_temp_dir("project-root-subdir");
        Repository::init(&root).expect("init repo");
        let subdir = root.join("packages").join("web");
        std::fs::create_dir_all(&subdir).expect("nested dirs");

        let resolved = project_root_for_path(&subdir).expect("project root");

        assert_eq!(
            resolved.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_root_for_path_falls_back_to_directory_when_not_git() {
        let root = unique_temp_dir("project-root-nongit");

        let resolved = project_root_for_path(&root).expect("canonical directory");

        assert_eq!(
            resolved.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_root_for_path_preserves_broken_repository_marker_error() {
        let root = unique_temp_dir("project-root-broken-marker");
        let subdir = root.join("packages").join("web");
        std::fs::create_dir_all(&subdir).expect("nested dirs");
        std::fs::write(root.join(".git"), "gitdir: missing-admin-dir\n")
            .expect("write broken git marker");

        let error = project_root_for_path(&subdir)
            .expect_err("a broken repository marker must not look like a non-Git folder");

        assert!(matches!(error, AppError::Git(_)));
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn repository_marker_probe_preserves_directory_access_errors() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_temp_dir("project-root-marker-permission");
        let original_permissions = std::fs::metadata(&root)
            .expect("read original permissions")
            .permissions();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000))
            .expect("deny directory access");
        let permission_denied = matches!(
            std::fs::symlink_metadata(root.join(".git")),
            Err(error) if error.kind() == ErrorKind::PermissionDenied
        );
        if !permission_denied {
            std::fs::set_permissions(&root, original_permissions).unwrap();
            std::fs::remove_dir_all(&root).ok();
            return;
        }

        let result = repository_marker_in_ancestry(&root);

        std::fs::set_permissions(&root, original_permissions).expect("restore directory access");
        let error = result.expect_err("marker access failure must be preserved");
        assert!(matches!(
            error,
            AppError::Io(ref error) if error.kind() == ErrorKind::PermissionDenied
        ));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_repo_errors_when_no_repo_in_ancestry() {
        let root = unique_temp_dir("norepo");
        let msg = match ensure_repo(&root) {
            Ok(_) => panic!("expected discover failure outside any repo"),
            Err(e) => e.to_string(),
        };
        assert!(
            msg.contains("could not find git repository from"),
            "unexpected error message: {msg}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_repo_walks_up_when_path_missing() {
        let root = unique_temp_dir("pruned");
        Repository::init(&root).expect("init repo");
        // Simulate a pruned linked worktree path that no longer exists, sitting
        // under the still-present repo root.
        let pruned = root.join(".acorn").join("worktrees").join("gone");
        assert!(!pruned.exists());

        let opened = ensure_repo(&pruned).expect("walk up to repo root");
        let workdir = opened.workdir().expect("workdir present");
        assert_eq!(
            workdir.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_worktree_infos_includes_name_path_and_mtime() {
        let root = unique_temp_dir("worktree-info");
        let repo = Repository::init(&root).expect("init repo");
        let readme = root.join("README.md");
        std::fs::write(&readme, "# test\n").expect("write readme");
        let mut index = repo.index().expect("repo index");
        index.add_path(Path::new("README.md")).expect("add readme");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = git2::Signature::now("Acorn Test", "acorn@example.com").expect("signature");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("commit");
        drop(tree);
        drop(repo);

        let path = create_worktree(&root, "feature-alpha").expect("create worktree");
        let infos = list_worktree_infos(&root).expect("list worktree infos");

        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "feature-alpha");
        assert_eq!(
            Path::new(&infos[0].path).canonicalize().unwrap(),
            path.canonicalize().unwrap(),
        );
        assert!(
            infos[0].modified_ms.unwrap_or_default() > 0,
            "worktree mtime should be captured"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_branch_infos_includes_local_and_remote_tracking_branches() {
        let root = unique_temp_dir("branch-info");
        let repo = init_repo_with_tracked_file(&root);
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        repo.branch("develop", &initial, false)
            .expect("create local branch");
        repo.reference(
            "refs/remotes/origin/release",
            initial.id(),
            false,
            "create remote-tracking branch",
        )
        .expect("create remote-tracking branch");
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/release",
            false,
            "set remote HEAD",
        )
        .expect("create symbolic remote HEAD");
        drop(initial);
        drop(repo);

        let infos = list_branch_infos(&root).expect("list branches");

        assert!(infos.contains(&ProjectBranchInfo {
            name: "develop".to_string(),
            is_remote: false,
        }));
        assert!(infos.contains(&ProjectBranchInfo {
            name: "origin/release".to_string(),
            is_remote: true,
        }));
        assert!(!infos.iter().any(|branch| branch.name == "origin/HEAD"));
        let first_remote = infos
            .iter()
            .position(|branch| branch.is_remote)
            .expect("remote branch");
        assert!(infos[..first_remote].iter().all(|branch| !branch.is_remote));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_allows_already_missing_path() {
        let root = unique_temp_dir("remove-missing");
        Repository::init(&root).expect("init repo");
        let missing = root.join(".acorn").join("worktrees").join("gone");

        remove_worktree_at_path(&root, &missing).expect("missing worktree removal is idempotent");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_deletes_unregistered_managed_linked_root() {
        let root = unique_temp_dir("remove-stale-linked");
        Repository::init(&root).expect("init repo");
        let stale = root.join(".acorn").join("worktrees").join("stale");
        std::fs::create_dir_all(&stale).expect("create stale worktree dir");
        std::fs::write(stale.join(".git"), "gitdir: ../../.git/worktrees/stale\n")
            .expect("write linked worktree marker");

        remove_worktree_at_path(&root, &stale).expect("remove stale managed linked root");

        assert!(
            !stale.exists(),
            "stale linked worktree dir should be removed"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_allows_unregistered_missing_path() {
        let root = unique_temp_dir("remove-missing-unmanaged");
        Repository::init(&root).expect("init repo");
        let missing = root.join("somewhere-else").join("gone");

        remove_worktree_at_path(&root, &missing).expect("missing worktree removal is idempotent");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_does_not_delete_managed_traversal_path() {
        let root = unique_temp_dir("remove-traversal");
        Repository::init(&root).expect("init repo");
        let escaped = root.join(".acorn").join("escaped");
        std::fs::create_dir_all(&escaped).expect("create escaped dir");
        std::fs::write(escaped.join(".git"), "gitdir: ../.git/worktrees/escaped\n")
            .expect("write linked marker");
        let traversal = root
            .join(".acorn")
            .join("worktrees")
            .join("..")
            .join("escaped");
        let removed = stage_remove_worktree_at_path(&root, &traversal)
            .expect("traversal path removal should be a no-op");

        assert!(removed.is_none());
        assert!(
            escaped.exists(),
            "stale fallback must not delete paths outside managed worktrees"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn remove_worktree_rejects_symlinked_managed_root() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("remove-symlinked-root");
        let external = unique_temp_dir("remove-symlinked-root-external");
        Repository::init(&root).expect("init repo");
        let rogue = external.join("worktrees").join("rogue");
        std::fs::create_dir_all(&rogue).expect("create outside worktree shape");
        std::fs::write(rogue.join(".git"), "gitdir: /outside\n").expect("write linked marker");
        symlink(&external, root.join(ACORN_DIR)).expect("symlink .acorn");
        let requested = root.join(ACORN_DIR).join("worktrees").join("rogue");

        let error = stage_remove_worktree_at_path(&root, &requested)
            .expect_err("symlinked managed root must be rejected");

        assert!(matches!(error, AppError::InvalidPath(_)));
        assert!(rogue.exists());
        assert!(rogue.join(".git").exists());

        std::fs::remove_file(root.join(ACORN_DIR)).ok();
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&external).ok();
    }

    fn ensure_options<'a>(
        create_if_missing: bool,
        fetch_ref: Option<&'a str>,
        base_branch: Option<&'a str>,
    ) -> EnsureWorktreeOptions<'a> {
        EnsureWorktreeOptions {
            create_if_missing,
            fetch_ref,
            base_branch,
        }
    }

    #[test]
    fn ensure_worktree_reuses_root_when_branch_is_already_checked_out() {
        let root = unique_temp_dir("ensure-reuse-root");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let current = current_branch(&root).expect("current branch");

        let ensured = ensure_worktree_for_branch(
            &root,
            &current,
            "pr-1-main",
            ensure_options(false, None, None),
        )
        .expect("reuse root checkout");

        assert!(!ensured.created);
        assert_eq!(ensured.branch, current);
        assert_eq!(
            Path::new(&ensured.path).canonicalize().unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(list_worktree_paths(&root).expect("list").is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_worktree_checks_out_existing_branch_in_new_directory() {
        let root = unique_temp_dir("ensure-existing-branch");
        let repo = init_repo_with_tracked_file(&root);
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        repo.branch("main", &initial, false).expect("create main");
        repo.branch("feature/pr-head", &initial, false)
            .expect("create feature branch");
        drop(initial);
        checkout_branch(&repo, "main");
        drop(repo);

        let ensured = ensure_worktree_for_branch(
            &root,
            "feature/pr-head",
            "pr-91-open-the-matching",
            ensure_options(false, None, None),
        )
        .expect("add worktree for existing branch");

        assert!(ensured.created);
        assert_eq!(ensured.branch, "feature/pr-head");
        let worktree_path = Path::new(&ensured.path);
        assert_eq!(
            worktree_path.file_name().and_then(|name| name.to_str()),
            Some("pr-91-open-the-matching")
        );
        let worktree_repo = Repository::open(worktree_path).expect("open worktree");
        assert_eq!(
            worktree_repo
                .head()
                .expect("head")
                .shorthand()
                .expect("shorthand"),
            "feature/pr-head"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_worktree_reuses_linked_checkout_for_the_same_branch() {
        let root = unique_temp_dir("ensure-reuse-linked");
        let repo = init_repo_with_tracked_file(&root);
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        repo.branch("main", &initial, false).expect("create main");
        repo.branch("feature/shared", &initial, false)
            .expect("create feature");
        drop(initial);
        checkout_branch(&repo, "main");
        drop(repo);

        let first = ensure_worktree_for_branch(
            &root,
            "feature/shared",
            "pr-3-first",
            ensure_options(false, None, None),
        )
        .expect("create first worktree");
        let second = ensure_worktree_for_branch(
            &root,
            "feature/shared",
            "pr-3-second",
            ensure_options(false, None, None),
        )
        .expect("reuse first worktree");

        assert!(first.created);
        assert!(!second.created);
        assert_eq!(
            Path::new(&first.path).canonicalize().unwrap(),
            Path::new(&second.path).canonicalize().unwrap()
        );
        assert_eq!(list_worktree_paths(&root).expect("list").len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_worktree_creates_named_branch_from_base_when_missing() {
        let root = unique_temp_dir("ensure-create-issue");
        let repo = init_repo_with_tracked_file(&root);
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        let main_oid = initial.id();
        repo.branch("main", &initial, false).expect("create main");
        drop(initial);
        checkout_branch(&repo, "main");
        drop(repo);

        let ensured = ensure_worktree_for_branch(
            &root,
            "issue-12-login-form",
            "issue-12-login-form",
            ensure_options(true, None, Some("main")),
        )
        .expect("create issue branch worktree");

        assert!(ensured.created);
        assert_eq!(ensured.branch, "issue-12-login-form");
        let worktree_repo = Repository::open(&ensured.path).expect("open worktree");
        let head = worktree_repo.head().expect("head");
        assert_eq!(head.shorthand().expect("shorthand"), "issue-12-login-form");
        assert_eq!(head.target(), Some(main_oid));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_worktree_errors_when_branch_is_missing_and_not_created() {
        let root = unique_temp_dir("ensure-missing");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);

        let error = ensure_worktree_for_branch(
            &root,
            "feature/missing",
            "pr-4-missing",
            ensure_options(false, None, None),
        )
        .expect_err("missing branch must fail");

        assert!(error
            .to_string()
            .contains("branch was not found: feature/missing"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_worktree_creates_local_branch_from_origin_tracking_ref() {
        let root = unique_temp_dir("ensure-from-origin");
        let repo = init_repo_with_tracked_file(&root);
        let initial = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("initial commit");
        repo.branch("main", &initial, false).expect("create main");
        repo.reference(
            "refs/remotes/origin/feature/from-origin",
            initial.id(),
            false,
            "remote tracking",
        )
        .expect("create origin tracking ref");
        drop(initial);
        checkout_branch(&repo, "main");
        drop(repo);

        let ensured = ensure_worktree_for_branch(
            &root,
            "feature/from-origin",
            "pr-5-from-origin",
            ensure_options(false, None, None),
        )
        .expect("create local branch from origin");

        assert!(ensured.created);
        assert_eq!(ensured.branch, "feature/from-origin");
        let worktree_repo = Repository::open(&ensured.path).expect("open worktree");
        assert_eq!(
            worktree_repo
                .head()
                .expect("head")
                .shorthand()
                .expect("shorthand"),
            "feature/from-origin"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_worktree_fetches_pull_head_into_local_branch() {
        let origin_root = unique_temp_dir("ensure-fetch-origin");
        let origin = init_repo_with_tracked_file(&origin_root);
        let oid = origin
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("origin commit")
            .id();
        origin
            .reference("refs/pull/91/head", oid, true, "pr head")
            .expect("create pull head ref");
        drop(origin);

        let work_root = unique_temp_dir("ensure-fetch-work");
        let repo = git2::build::RepoBuilder::new()
            .clone(origin_root.to_str().expect("origin path utf8"), &work_root)
            .expect("clone origin");
        drop(repo);

        let ensured = ensure_worktree_for_branch(
            &work_root,
            "feature/from-pr",
            "pr-91-from-pr",
            ensure_options(false, Some("refs/pull/91/head"), None),
        )
        .expect("fetch pull head into worktree");

        assert!(ensured.created);
        assert_eq!(ensured.branch, "feature/from-pr");
        let worktree_repo = Repository::open(&ensured.path).expect("open worktree");
        assert_eq!(
            worktree_repo
                .head()
                .expect("head")
                .shorthand()
                .expect("shorthand"),
            "feature/from-pr"
        );

        std::fs::remove_dir_all(&work_root).ok();
        std::fs::remove_dir_all(&origin_root).ok();
    }

    #[test]
    fn ensure_worktree_rejects_non_pull_fetch_refs() {
        let root = unique_temp_dir("ensure-bad-fetch-ref");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);

        let error = ensure_worktree_for_branch(
            &root,
            "feature/x",
            "pr-1",
            ensure_options(false, Some("refs/heads/main"), None),
        )
        .expect_err("only pull head refs are accepted");

        assert!(error.to_string().contains("unsupported fetch ref"));
        std::fs::remove_dir_all(&root).ok();
    }
}
