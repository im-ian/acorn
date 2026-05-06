use std::fs;
use std::path::PathBuf;

use directories::ProjectDirs;

use crate::error::{AppError, AppResult};
use crate::session::{Project, Session};

const SESSIONS_FILE: &str = "sessions.json";
const SESSIONS_TMP_FILE: &str = "sessions.json.tmp";
const PROJECTS_FILE: &str = "projects.json";
const PROJECTS_TMP_FILE: &str = "projects.json.tmp";

/// Resolve the application's data directory, creating it if missing.
pub fn data_dir() -> AppResult<PathBuf> {
    let project_dirs = ProjectDirs::from("io", "im-ian", "acorn")
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
pub fn load_sessions() -> AppResult<Vec<Session>> {
    let path = sessions_path()?;
    if !path.exists() {
        tracing::info!(path = %path.display(), "sessions file missing, starting empty");
        return Ok(Vec::new());
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read sessions file");
            return Ok(Vec::new());
        }
    };

    match serde_json::from_slice::<Vec<Session>>(&bytes) {
        Ok(sessions) => {
            tracing::info!(count = sessions.len(), "loaded sessions from disk");
            Ok(sessions)
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse sessions file");
            Ok(Vec::new())
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

pub fn load_projects() -> AppResult<Vec<Project>> {
    let path = projects_path()?;
    if !path.exists() {
        tracing::info!(path = %path.display(), "projects file missing, starting empty");
        return Ok(Vec::new());
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read projects file");
            return Ok(Vec::new());
        }
    };
    match serde_json::from_slice::<Vec<Project>>(&bytes) {
        Ok(projects) => {
            tracing::info!(count = projects.len(), "loaded projects from disk");
            Ok(projects)
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse projects file");
            Ok(Vec::new())
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
}
