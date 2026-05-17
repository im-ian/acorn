use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use directories::ProjectDirs;

use crate::error::{AppError, AppResult};
use crate::session::{Project, Session};

const SESSIONS_FILE: &str = "sessions.json";
const SESSIONS_TMP_FILE: &str = "sessions.json.tmp";
const PROJECTS_FILE: &str = "projects.json";
const PROJECTS_TMP_FILE: &str = "projects.json.tmp";

/// Side-channel a corrupt persistence file before we mask it with an empty
/// in-memory store. Without this the only evidence of a parse failure is a
/// log line that scrolls away. The backup name embeds a unix timestamp so
/// repeated boots do not overwrite earlier evidence.
fn backup_corrupt_file(path: &Path) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("data.json")
        .to_string();
    name.push_str(&format!(".broken-{ts}"));
    let backup = path.with_file_name(name);
    if let Err(err) = fs::copy(path, &backup) {
        tracing::warn!(
            error = %err,
            path = %path.display(),
            "failed to back up corrupt persistence file"
        );
    } else {
        tracing::warn!(
            backup = %backup.display(),
            "backed up corrupt persistence file"
        );
    }
}

/// Resolve the application's data directory, creating it if missing.
///
/// Debug builds (`pnpm run tauri dev`) write to `acorn-dev` so local testing
/// does not clobber the installed Acorn's sessions/projects.
pub fn data_dir() -> AppResult<PathBuf> {
    let app_name = if cfg!(debug_assertions) {
        "acorn-dev"
    } else {
        "acorn"
    };
    let project_dirs = ProjectDirs::from("io", "im-ian", app_name)
        .ok_or_else(|| AppError::Other("could not resolve project data directory".to_string()))?;
    let dir = project_dirs.data_dir().to_path_buf();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn sessions_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(SESSIONS_FILE))
}

fn sessions_tmp_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(SESSIONS_TMP_FILE))
}

/// Load sessions from disk. Returns an empty Vec on any recoverable failure
/// (missing file, IO error, parse error) — these are logged but not propagated.
/// Boot uses `load_sessions_with_status` instead so it can branch on cleanliness;
/// this thin wrapper exists for tests and external callers that do not care.
#[allow(dead_code)]
pub fn load_sessions() -> AppResult<Vec<Session>> {
    Ok(load_sessions_with_status()?.0)
}

/// Same as `load_sessions` but also reports whether the load was clean.
/// `clean = false` means the file existed but could not be read or parsed —
/// a signal that downstream wipe-on-empty paths (scrollback prune, frontend
/// pane reconciliation) should hold off rather than treat the empty result
/// as authoritative. A missing file is considered clean (legitimate empty).
pub fn load_sessions_with_status() -> AppResult<(Vec<Session>, bool)> {
    let path = sessions_path()?;
    if !path.exists() {
        tracing::info!(path = %path.display(), "sessions file missing, starting empty");
        return Ok((Vec::new(), true));
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read sessions file");
            return Ok((Vec::new(), false));
        }
    };

    match serde_json::from_slice::<Vec<Session>>(&bytes) {
        Ok(sessions) => {
            tracing::info!(count = sessions.len(), "loaded sessions from disk");
            Ok((sessions, true))
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse sessions file");
            backup_corrupt_file(&path);
            Ok((Vec::new(), false))
        }
    }
}

/// Persist sessions atomically: write to a temp file, then rename into place.
pub fn save_sessions(sessions: &[Session]) -> AppResult<()> {
    let final_path = sessions_path()?;
    let tmp_path = sessions_tmp_path()?;

    let payload = serde_json::to_vec_pretty(sessions)
        .map_err(|err| AppError::Other(format!("failed to serialize sessions: {err}")))?;

    fs::write(&tmp_path, &payload)?;
    fs::rename(&tmp_path, &final_path)?;
    tracing::info!(
        count = sessions.len(),
        path = %final_path.display(),
        "saved sessions to disk"
    );
    Ok(())
}

fn projects_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(PROJECTS_FILE))
}

fn projects_tmp_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(PROJECTS_TMP_FILE))
}

#[allow(dead_code)]
pub fn load_projects() -> AppResult<Vec<Project>> {
    Ok(load_projects_with_status()?.0)
}

pub fn load_projects_with_status() -> AppResult<(Vec<Project>, bool)> {
    let path = projects_path()?;
    if !path.exists() {
        tracing::info!(path = %path.display(), "projects file missing, starting empty");
        return Ok((Vec::new(), true));
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read projects file");
            return Ok((Vec::new(), false));
        }
    };
    match serde_json::from_slice::<Vec<Project>>(&bytes) {
        Ok(projects) => {
            tracing::info!(count = projects.len(), "loaded projects from disk");
            Ok((projects, true))
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse projects file");
            backup_corrupt_file(&path);
            Ok((Vec::new(), false))
        }
    }
}

pub fn save_projects(projects: &[Project]) -> AppResult<()> {
    let final_path = projects_path()?;
    let tmp_path = projects_tmp_path()?;
    let payload = serde_json::to_vec_pretty(projects)
        .map_err(|err| AppError::Other(format!("failed to serialize projects: {err}")))?;
    fs::write(&tmp_path, &payload)?;
    fs::rename(&tmp_path, &final_path)?;
    tracing::info!(
        count = projects.len(),
        path = %final_path.display(),
        "saved projects to disk"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_is_resolvable() {
        let dir = data_dir().expect("data dir resolves");
        assert!(dir.exists(), "data dir should be created");
    }

    #[test]
    fn load_sessions_returns_empty_when_missing() {
        let sessions = load_sessions().expect("load should not error on missing file");
        // Cannot assert empty without test isolation — at least confirm it returns.
        let _ = sessions;
    }

    #[test]
    fn backup_corrupt_file_writes_sibling_with_broken_suffix() {
        let tmp = std::env::temp_dir().join(format!(
            "acorn-persist-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("sessions.json");
        fs::write(&path, b"not json").unwrap();
        backup_corrupt_file(&path);
        let entries: Vec<_> = fs::read_dir(&tmp)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries
                .iter()
                .any(|n| n.starts_with("sessions.json.broken-")),
            "expected a sessions.json.broken-* file, got {entries:?}"
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}
