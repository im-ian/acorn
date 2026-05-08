use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub repo_path: PathBuf,
    pub name: String,
    pub created_at: DateTime<Utc>,
    /// User-defined display order. Lower values appear first.
    /// `#[serde(default)]` so older persisted entries (without a position)
    /// load cleanly and are placed at the front, then re-normalized lazily.
    #[serde(default)]
    pub position: i64,
}

impl Project {
    pub fn new(repo_path: PathBuf, name: String, position: i64) -> Self {
        Self {
            repo_path,
            name,
            created_at: Utc::now(),
            position,
        }
    }
}

#[derive(Default)]
pub struct ProjectStore {
    inner: DashMap<PathBuf, Project>,
}

impl ProjectStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn ensure(&self, repo_path: PathBuf, name: String) -> Project {
        if let Some(existing) = self.inner.get(&repo_path) {
            return existing.value().clone();
        }
        let next_position = self
            .inner
            .iter()
            .map(|r| r.value().position)
            .max()
            .unwrap_or(-1)
            + 1;
        let project = Project::new(repo_path.clone(), name, next_position);
        self.inner.insert(repo_path, project.clone());
        project
    }

    pub fn insert(&self, project: Project) -> Project {
        self.inner.insert(project.repo_path.clone(), project.clone());
        project
    }

    pub fn list(&self) -> Vec<Project> {
        let mut v: Vec<Project> = self.inner.iter().map(|r| r.value().clone()).collect();
        v.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.name.cmp(&b.name)));
        v
    }

    pub fn remove(&self, repo_path: &std::path::Path) -> Option<Project> {
        self.inner.remove(repo_path).map(|(_, v)| v)
    }

    /// Reassign positions according to the given ordered list of repo paths.
    /// Paths not present in the store are ignored. Existing projects whose
    /// repo_path is not in `order` are appended at the end, preserving their
    /// previous relative order.
    pub fn reorder(&self, order: &[PathBuf]) {
        let mut seen = std::collections::HashSet::new();
        let mut pos: i64 = 0;
        for path in order {
            if let Some(mut entry) = self.inner.get_mut(path) {
                entry.position = pos;
                pos += 1;
                seen.insert(path.clone());
            }
        }
        // Append remaining projects (not referenced in `order`) at the tail,
        // preserving their existing relative position.
        let mut remaining: Vec<PathBuf> = self
            .inner
            .iter()
            .filter(|r| !seen.contains(r.key()))
            .map(|r| (r.value().position, r.key().clone()))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(_, path)| path)
            .collect();
        remaining.sort_by_key(|path| {
            self.inner
                .get(path)
                .map(|r| r.value().position)
                .unwrap_or(i64::MAX)
        });
        for path in remaining {
            if let Some(mut entry) = self.inner.get_mut(&path) {
                entry.position = pos;
                pos += 1;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    NeedsInput,
    Failed,
    Completed,
}

/// Persisted per-session PTY startup mode. Captured when the session is
/// created (and updated whenever a future UI lets the user re-pick), so
/// changing the global `sessionStartup.mode` setting does not retroactively
/// change how existing sessions respawn after an app restart. Older
/// persisted sessions without this field load as `None`, in which case
/// the frontend falls back to the current global setting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStartupMode {
    Agent,
    Terminal,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub name: String,
    pub repo_path: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    #[serde(default)]
    pub isolated: bool,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_message: Option<String>,
    #[serde(default)]
    pub startup_mode: Option<SessionStartupMode>,
}

impl Session {
    pub fn new(
        name: String,
        repo_path: PathBuf,
        worktree_path: PathBuf,
        branch: String,
        isolated: bool,
        startup_mode: Option<SessionStartupMode>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            name,
            repo_path,
            worktree_path,
            branch,
            isolated,
            status: SessionStatus::Idle,
            created_at: now,
            updated_at: now,
            last_message: None,
            startup_mode,
        }
    }
}

#[derive(Default)]
pub struct SessionStore {
    inner: DashMap<Uuid, Session>,
}

impl SessionStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn insert(&self, session: Session) -> Session {
        self.inner.insert(session.id, session.clone());
        session
    }

    pub fn get(&self, id: &Uuid) -> AppResult<Session> {
        self.inner
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    pub fn list(&self) -> Vec<Session> {
        let mut v: Vec<Session> = self.inner.iter().map(|r| r.value().clone()).collect();
        v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        v
    }

    pub fn update_status(&self, id: &Uuid, status: SessionStatus) -> AppResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        entry.status = status;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    /// Update status without bumping `updated_at`. No-op if the status is
    /// unchanged. Used by the periodic liveness probe so polling doesn't
    /// reshuffle the sidebar's most-recent-first ordering.
    pub fn refresh_status(&self, id: &Uuid, status: SessionStatus) -> AppResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if entry.status != status {
            entry.status = status;
        }
        Ok(entry.clone())
    }

    pub fn rename(&self, id: &Uuid, name: String) -> AppResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        entry.name = name;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    pub fn remove(&self, id: &Uuid) -> AppResult<Session> {
        self.inner
            .remove(id)
            .map(|(_, v)| v)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }
}
