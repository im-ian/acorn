use git2::{BranchType, Repository, WorktreeAddOptions, WorktreePruneOptions};
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
    if let Ok(repo) = Repository::discover(path) {
        if let Some(workdir) = repo.workdir() {
            return Ok(workdir
                .canonicalize()
                .unwrap_or_else(|_| workdir.to_path_buf()));
        }
    }
    path.canonicalize().map_err(AppError::from)
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
    loop {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::InvalidPath(format!(
                        "Git metadata path must be a real directory: {}",
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

pub fn create_worktree(repo_path: &Path, name: &str) -> AppResult<PathBuf> {
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

    let base = worktree_base_commit(&repo)?;
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

fn worktree_base_commit(repo: &Repository) -> AppResult<git2::Commit<'_>> {
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

/// Returns absolute on-disk paths of linked worktrees. Used by the
/// post-PTY-exit "did claude just create a worktree?" detector — names alone
/// aren't enough because we need to point a session at the new worktree's
/// directory to respawn the child there.
///
/// Note: this only enumerates *linked* worktrees. The main repo checkout is
/// excluded; libgit2's `worktrees()` only reports `.git/worktrees/<name>`
/// entries. That matches what we want — `claude -w` always adds a linked
/// worktree, never modifies the main one.
pub fn list_worktree_paths(repo_path: &Path) -> AppResult<Vec<std::path::PathBuf>> {
    let repo = ensure_repo(repo_path)?;
    let names = repo.worktrees()?;
    let mut paths = Vec::new();
    for name in names.iter().filter_map(|name| name.ok().flatten()) {
        if let Ok(wt) = repo.find_worktree(name) {
            paths.push(wt.path().to_path_buf());
        }
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

pub fn stage_remove_worktree_at_path(
    repo_path: &Path,
    worktree_path: &Path,
) -> AppResult<Option<RemovedWorktree>> {
    if worktree_path.exists() && !is_linked_worktree_root(worktree_path) {
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
            if !worktree_path.exists() {
                if has_staged_worktree_backup(worktree_path) {
                    return Ok(None);
                }
                prune_missing_registered_worktree(&wt, worktree_path)?;
                return Ok(None);
            }
            let token = Uuid::new_v4().to_string();
            let backup = removed_worktree_backup_path(worktree_path, &token)?;
            if let Some(parent) = backup.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(worktree_path, &backup)?;
            return Ok(Some(RemovedWorktree {
                token,
                repo_path: repo_path.to_string_lossy().into_owned(),
                worktree_path: worktree_path.to_string_lossy().into_owned(),
                git_common_dir: repo.commondir().to_string_lossy().into_owned(),
            }));
        }
    }

    if is_acorn_managed_worktree_path(repo_path, worktree_path)? {
        if worktree_path.exists() && is_linked_worktree_root(worktree_path) {
            std::fs::remove_dir_all(worktree_path)?;
            return Ok(None);
        }
        if !worktree_path.exists() {
            return Ok(None);
        }
    }

    if !worktree_path.exists() {
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
    _repo_path: &Path,
    worktree_path: &Path,
    token: &str,
    _git_common_dir: &Path,
) -> AppResult<()> {
    validate_removal_token(token)?;
    let backup = removed_worktree_backup_path(worktree_path, token)?;
    if !backup.exists() {
        return Err(AppError::InvalidPath(format!(
            "removed worktree backup is not available: {}",
            backup.display()
        )));
    }
    if worktree_path.exists() {
        return Err(AppError::InvalidPath(format!(
            "worktree path already exists: {}",
            worktree_path.display()
        )));
    }
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&backup, worktree_path)?;
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
    let backup = removed_worktree_backup_path(worktree_path, token)?;
    if backup.exists() {
        std::fs::remove_dir_all(&backup)?;
    }
    remove_empty_backup_root(worktree_path);
    if worktree_path.exists() {
        return Ok(());
    }
    let repo = match Repository::open(git_common_dir) {
        Ok(repo) => repo,
        Err(_) => ensure_repo(repo_path)?,
    };
    prune_registered_worktree_at_path(&repo, worktree_path)?;
    Ok(())
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

fn removed_worktree_backup_path(worktree_path: &Path, token: &str) -> AppResult<PathBuf> {
    validate_removal_token(token)?;
    let parent = worktree_path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!(
            "worktree path has no parent directory: {}",
            worktree_path.display()
        ))
    })?;
    Ok(parent.join(DELETED_WORKTREES_DIR).join(token))
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
    let Some(parent) = worktree_path.parent() else {
        return;
    };
    let root = parent.join(DELETED_WORKTREES_DIR);
    let _ = std::fs::remove_dir(&root);
}

fn has_staged_worktree_backup(worktree_path: &Path) -> bool {
    let Some(parent) = worktree_path.parent() else {
        return false;
    };
    let root = parent.join(DELETED_WORKTREES_DIR);
    root.read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
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
    std::fs::metadata(path.join(".git"))
        .map(|m| m.is_file())
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
}
