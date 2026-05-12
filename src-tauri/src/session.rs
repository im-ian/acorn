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

/// Distinguishes ordinary terminal sessions from "control" sessions, which
/// (via the `acorn-ipc` CLI) can drive other sessions in the same project.
/// Defaults to `Regular` so existing persisted sessions without this field
/// load cleanly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    #[default]
    Regular,
    Control,
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
    pub kind: SessionKind,
    /// User-defined display order within the project group. `None` means the
    /// session has never been reordered — the frontend falls back to
    /// `updated_at DESC` for these. Once any session in a project is dragged,
    /// every session in that project gets an explicit position.
    #[serde(default)]
    pub position: Option<i64>,
    /// Identifier the `acornd` daemon uses for this session's live PTY.
    /// `None` while the session is using the legacy in-process PTY path,
    /// or while the daemon has not yet spawned a child for it. Stored so
    /// the app can route follow-up ops (write/resize/kill) to the right
    /// daemon registry entry; survives serialization so reattach after
    /// an Acorn-app restart finds the matching live session.
    ///
    /// BC: older `sessions.json` files without this field load with
    /// `daemon_session_id == None`, which is the legacy in-process
    /// behavior and the natural "ghost" indicator for the daemon-mode
    /// reconciliation path.
    #[serde(default)]
    pub daemon_session_id: Option<Uuid>,
    /// Deterministic resume token persisted across (re)spawns. For Claude
    /// Code this is the `--session-id <uuid>` value the daemon injects so
    /// the agent's JSONL chat history remains reachable after a crash.
    /// `None` for sessions whose agent has no known resume protocol.
    #[serde(default)]
    pub agent_resume_token: Option<String>,
}

impl Session {
    pub fn new(
        name: String,
        repo_path: PathBuf,
        worktree_path: PathBuf,
        branch: String,
        isolated: bool,
        kind: SessionKind,
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
            kind,
            position: None,
            daemon_session_id: None,
            agent_resume_token: None,
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

    /// Attach a daemon session id to an existing session record. Used after
    /// the app proxies a spawn through `acornd` and the daemon hands back
    /// the live PTY id. Idempotent: passing `None` detaches.
    ///
    /// `dead_code` until the daemon-routed `pty_spawn` cutover lands —
    /// retained so the BC-compat persistence schema has a setter the
    /// cutover can call without another schema migration.
    #[allow(dead_code)]
    pub fn set_daemon_session_id(
        &self,
        id: &Uuid,
        daemon_id: Option<Uuid>,
    ) -> AppResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        entry.daemon_session_id = daemon_id;
        Ok(entry.clone())
    }

    /// Persist the resume token chosen for this session's agent (e.g.
    /// Claude Code's `--session-id`). Called once at first spawn; the
    /// daemon re-injects this on every respawn.
    ///
    /// `dead_code` until the daemon-routed `pty_spawn` cutover wires
    /// resume-strategy detection through this setter.
    #[allow(dead_code)]
    pub fn set_agent_resume_token(
        &self,
        id: &Uuid,
        token: Option<String>,
    ) -> AppResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        entry.agent_resume_token = token;
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

    /// Re-point a session at a different on-disk worktree. Used when an in-PTY
    /// command (notably `claude --worktree`) creates a fresh worktree and
    /// exits — acorn adopts that worktree as the session's new home so the
    /// user lands inside it on respawn instead of being kicked back to the
    /// original cwd. Only the path moves; UUID, name, status, and metadata
    /// are preserved so terminal/listener identity is stable across the
    /// adoption.
    pub fn update_worktree_path(
        &self,
        id: &Uuid,
        worktree_path: std::path::PathBuf,
    ) -> AppResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        entry.worktree_path = worktree_path;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    pub fn remove(&self, id: &Uuid) -> AppResult<Session> {
        self.inner
            .remove(id)
            .map(|(_, v)| v)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    /// Assign explicit positions (0..N) to the sessions listed in `order`,
    /// scoped to a single project (`repo_path`). Sessions belonging to the
    /// same project but missing from `order` keep their existing position
    /// where set, otherwise get appended after the explicit ones. Sessions
    /// from other projects are untouched. Unknown ids in `order` are ignored.
    pub fn reorder(&self, repo_path: &std::path::Path, order: &[Uuid]) {
        let mut seen = std::collections::HashSet::new();
        let mut pos: i64 = 0;
        for id in order {
            if let Some(mut entry) = self.inner.get_mut(id) {
                if entry.repo_path != repo_path {
                    continue;
                }
                entry.position = Some(pos);
                pos += 1;
                seen.insert(*id);
            }
        }
        let mut remaining: Vec<(Uuid, Option<i64>, DateTime<Utc>)> = self
            .inner
            .iter()
            .filter(|r| r.value().repo_path == repo_path && !seen.contains(r.key()))
            .map(|r| (*r.key(), r.value().position, r.value().updated_at))
            .collect();
        remaining.sort_by(|a, b| {
            let ap = a.1.unwrap_or(i64::MAX);
            let bp = b.1.unwrap_or(i64::MAX);
            ap.cmp(&bp).then_with(|| b.2.cmp(&a.2))
        });
        for (id, _, _) in remaining {
            if let Some(mut entry) = self.inner.get_mut(&id) {
                entry.position = Some(pos);
                pos += 1;
            }
        }
    }
}
