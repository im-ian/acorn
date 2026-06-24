use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

fn default_true() -> bool {
    true
}

/// Errors produced by `SessionStore` lookups. Kept local so the crate does
/// not need to share `AppError` with the main `acorn` crate; the main crate
/// adapts via `From<SessionError>`.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session not found: {0}")]
    NotFound(String),
}

pub type SessionResult<T> = Result<T, SessionError>;

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
        self.inner
            .insert(project.repo_path.clone(), project.clone());
        project
    }

    pub fn list(&self) -> Vec<Project> {
        let mut v: Vec<Project> = self.inner.iter().map(|r| r.value().clone()).collect();
        v.sort_by(|a, b| {
            a.position
                .cmp(&b.position)
                .then_with(|| a.name.cmp(&b.name))
        });
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

/// High-level surface a session should render. Existing persisted sessions
/// predate this field and load as terminal sessions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    #[default]
    Terminal,
    Chat,
}

/// Ownership boundary for control-session-created worker sessions.
///
/// User-created and legacy sessions default to `User`. Sessions created through
/// `acorn-ipc new-session` are owned by the source control session so agents can
/// distinguish their own workers from user terminals or workers created by
/// another controller.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SessionOwner {
    #[default]
    User,
    Control {
        session_id: Uuid,
    },
}

impl SessionOwner {
    pub fn control(session_id: Uuid) -> Self {
        Self::Control { session_id }
    }

    pub fn is_control_owner(&self, source_session_id: Uuid) -> bool {
        matches!(self, Self::Control { session_id } if *session_id == source_session_id)
    }

    pub fn label(&self) -> String {
        match self {
            Self::User => "user".to_string(),
            Self::Control { session_id } => format!("control:{session_id}"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionTitleSource {
    Default,
    Generated,
    Manual,
}

fn default_title_source_for_existing_sessions() -> SessionTitleSource {
    SessionTitleSource::Manual
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionAgentProvider {
    Claude,
    Codex,
    Antigravity,
}

impl SessionAgentProvider {
    pub fn supports_hooks(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Antigravity)
    }

    pub fn hook_provider_env_value(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }
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
    /// Whether this session belongs to a project entry. Older persisted
    /// sessions predate this field and should keep their project-scoped
    /// behavior.
    #[serde(default = "default_true")]
    pub project_scoped: bool,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_message: Option<String>,
    #[serde(default = "default_title_source_for_existing_sessions")]
    pub title_source: SessionTitleSource,
    /// Explicit opt-in for automatic title generation. `None` means the row
    /// predates this field and callers should apply legacy compatibility rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_title_enabled: Option<bool>,
    /// Transcript id used when Acorn last generated this tab title. Manual
    /// renames clear this value; generated titles keep it so a later agent
    /// session rotation (for example Claude `/clear`) can generate a fresh
    /// title without touching user-named tabs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_title_transcript_id: Option<String>,
    #[serde(default)]
    pub kind: SessionKind,
    #[serde(default)]
    pub mode: SessionMode,
    #[serde(default)]
    pub owner: SessionOwner,
    /// User-defined display order within the project group. `None` means the
    /// session has never been reordered — the frontend falls back to
    /// `created_at DESC` for these so status/name/path updates do not reshuffle
    /// the sidebar. Once any session in a project is dragged, every session in
    /// that project gets an explicit position.
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
    /// Derived flag — `true` when `worktree_path` is the root of a linked git
    /// worktree (`.git` is a file, not a directory). Computed at list-time
    /// from the on-disk path; skipped on deserialize so persisted entries
    /// load cleanly and never go stale. Drives the worktree icon on tabs and
    /// in the sidebar, capturing not just Acorn-managed worktrees (`isolated`)
    /// but also `claude -w` adoptions and projects that were already linked
    /// worktrees when added.
    #[serde(default, skip_deserializing)]
    pub in_worktree: bool,
    /// Derived from status polling. This reflects the currently live
    /// Claude/Codex/Antigravity process under the session PTY and is not
    /// persisted in sessions.json.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub agent_provider: Option<SessionAgentProvider>,
    /// Derived from Acorn's per-session agent-state markers. This is the most
    /// recently paired transcript id and is not persisted in sessions.json.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub agent_transcript_id: Option<String>,
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
            project_scoped: true,
            status: SessionStatus::Idle,
            created_at: now,
            updated_at: now,
            last_message: None,
            title_source: SessionTitleSource::Default,
            auto_title_enabled: Some(false),
            generated_title_transcript_id: None,
            kind,
            mode: SessionMode::Terminal,
            owner: SessionOwner::User,
            position: None,
            daemon_session_id: None,
            agent_resume_token: None,
            in_worktree: false,
            agent_provider: None,
            agent_transcript_id: None,
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

    pub fn get(&self, id: &Uuid) -> SessionResult<Session> {
        self.inner
            .get(id)
            .map(|r| r.value().clone())
            .ok_or_else(|| SessionError::NotFound(id.to_string()))
    }

    pub fn list(&self) -> Vec<Session> {
        let mut v: Vec<Session> = self.inner.iter().map(|r| r.value().clone()).collect();
        v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        v
    }

    pub fn list_control_owned_descendants(&self, controller_id: Uuid) -> Vec<Session> {
        let sessions = self.list();
        let mut seen = HashSet::from([controller_id]);
        let mut frontier = vec![controller_id];
        let mut descendants = Vec::new();

        while let Some(owner_id) = frontier.pop() {
            for session in &sessions {
                if seen.contains(&session.id) || !session.owner.is_control_owner(owner_id) {
                    continue;
                }
                seen.insert(session.id);
                frontier.push(session.id);
                descendants.push(session.clone());
            }
        }

        descendants
    }

    pub fn update_status(&self, id: &Uuid, status: SessionStatus) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.status = status;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    /// Update status without bumping `updated_at`. No-op if the status is
    /// unchanged. Used by the periodic liveness probe so polling doesn't
    /// reshuffle the sidebar's most-recent-first ordering.
    pub fn refresh_status(&self, id: &Uuid, status: SessionStatus) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if entry.status != status {
            entry.status = status;
        }
        Ok(entry.clone())
    }

    /// Refresh derived live-agent metadata without bumping `updated_at`.
    /// Status polling owns these fields because they describe the current PTY
    /// process tree, not user-authored session data.
    pub fn refresh_agent_state(
        &self,
        id: &Uuid,
        provider: Option<SessionAgentProvider>,
        transcript_id: Option<String>,
    ) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.agent_provider = provider;
        entry.agent_transcript_id = transcript_id;
        Ok(entry.clone())
    }

    /// Flip the explicit auto-title opt-in. Used by the status poll to
    /// promote a plain terminal session once an agent transcript is bound
    /// to it. Does not bump `updated_at` — polling must not reshuffle the
    /// sidebar's most-recent-first ordering. No-op when unchanged.
    pub fn set_auto_title_enabled(&self, id: &Uuid, enabled: bool) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if entry.auto_title_enabled != Some(enabled) {
            entry.auto_title_enabled = Some(enabled);
        }
        Ok(entry.clone())
    }

    /// Attach a daemon session id to an existing session record. The
    /// setter exists so the daemon-routed PTY path can update the row
    /// it created in-app; it is wired up at the same time as that path
    /// — leaving the API stable today avoids a second schema migration.
    /// Idempotent: passing `None` detaches.
    #[allow(dead_code)]
    pub fn set_daemon_session_id(
        &self,
        id: &Uuid,
        daemon_id: Option<Uuid>,
    ) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.daemon_session_id = daemon_id;
        Ok(entry.clone())
    }

    /// Persist the resume token chosen for this session's agent (e.g.
    /// Claude Code's `--session-id`). Set once at first spawn; the
    /// daemon re-injects this on every respawn. Pairs with
    /// `set_daemon_session_id` — wired by the same downstream path.
    #[allow(dead_code)]
    pub fn set_agent_resume_token(
        &self,
        id: &Uuid,
        token: Option<String>,
    ) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.agent_resume_token = token;
        Ok(entry.clone())
    }

    pub fn set_kind(&self, id: &Uuid, kind: SessionKind) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.kind = kind;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    pub fn rename(&self, id: &Uuid, name: String) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.name = name;
        entry.title_source = SessionTitleSource::Manual;
        entry.generated_title_transcript_id = None;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    pub fn set_generated_title(
        &self,
        id: &Uuid,
        name: String,
        transcript_id: Option<String>,
    ) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.name = name;
        entry.title_source = SessionTitleSource::Generated;
        entry.generated_title_transcript_id =
            transcript_id.filter(|value| !value.trim().is_empty());
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
    ) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.worktree_path = worktree_path;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    /// Re-point a session at its main repo and clear `isolated` when the
    /// linked worktree has disappeared from disk (typically: agent exit
    /// pruned the worktree but the session row still references it). Keeps
    /// the session row alive so PTY/agent history stays addressable;
    /// downstream git ops resolve against the main repo instead of erroring
    /// on a missing path.
    pub fn reconcile_missing_worktree(&self, id: &Uuid) -> SessionResult<Session> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.worktree_path = entry.repo_path.clone();
        entry.isolated = false;
        entry.updated_at = Utc::now();
        Ok(entry.clone())
    }

    pub fn remove(&self, id: &Uuid) -> SessionResult<Session> {
        self.inner
            .remove(id)
            .map(|(_, v)| v)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_session(repo: &str, worktree: &str, isolated: bool) -> Session {
        Session::new(
            "test".to_string(),
            PathBuf::from(repo),
            PathBuf::from(worktree),
            "main".to_string(),
            isolated,
            SessionKind::Regular,
        )
    }

    #[test]
    fn new_sessions_start_with_default_title_source() {
        let session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);

        assert_eq!(session.title_source, SessionTitleSource::Default);
        assert_eq!(session.auto_title_enabled, Some(false));
    }

    #[test]
    fn set_auto_title_enabled_flips_flag_without_touching_updated_at() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        assert_eq!(session.auto_title_enabled, Some(false));

        let updated = store
            .set_auto_title_enabled(&session.id, true)
            .expect("session exists");

        assert_eq!(updated.auto_title_enabled, Some(true));
        assert_eq!(updated.updated_at, session.updated_at);
        assert_eq!(
            store
                .get(&session.id)
                .expect("session exists")
                .auto_title_enabled,
            Some(true)
        );
    }

    #[test]
    fn refresh_agent_state_updates_live_metadata_without_touching_updated_at() {
        let store = SessionStore::new();
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.agent_transcript_id = Some("codex-old".to_string());
        let session = store.insert(session);

        let updated = store
            .refresh_agent_state(&session.id, None, Some("codex-old".to_string()))
            .expect("session exists");

        assert_eq!(updated.agent_provider, None);
        assert_eq!(updated.agent_transcript_id.as_deref(), Some("codex-old"));
        assert_eq!(updated.updated_at, session.updated_at);
        let stored = store.get(&session.id).expect("session exists");
        assert_eq!(stored.agent_provider, None);
        assert_eq!(stored.agent_transcript_id.as_deref(), Some("codex-old"));
    }

    #[test]
    fn persisted_sessions_without_title_source_load_as_manual() {
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.title_source = SessionTitleSource::Default;
        let mut json = serde_json::to_value(&session).expect("session serializes");
        json.as_object_mut()
            .expect("session json is an object")
            .remove("title_source");

        let restored: Session = serde_json::from_value(json).expect("session deserializes");

        assert_eq!(restored.title_source, SessionTitleSource::Manual);
    }

    #[test]
    fn persisted_sessions_without_mode_load_as_terminal() {
        let mut json =
            serde_json::to_value(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false))
                .expect("session serializes");
        json.as_object_mut()
            .expect("session json is an object")
            .remove("mode");

        let restored: Session = serde_json::from_value(json).expect("session deserializes");

        assert_eq!(restored.mode, SessionMode::Terminal);
    }

    #[test]
    fn manual_rename_marks_title_source_as_manual() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        store
            .set_generated_title(
                &session.id,
                "generated title".to_string(),
                Some("transcript-1".to_string()),
            )
            .expect("session exists");

        let updated = store
            .rename(&session.id, "manual title".to_string())
            .expect("session exists");

        assert_eq!(updated.name, "manual title");
        assert_eq!(updated.title_source, SessionTitleSource::Manual);
        assert_eq!(updated.generated_title_transcript_id, None);
    }

    #[test]
    fn reconcile_missing_worktree_resets_path_and_isolation() {
        let store = SessionStore::new();
        let session = store.insert(fake_session(
            "/tmp/acorn-repo",
            "/tmp/acorn-repo/.acorn/worktrees/gone",
            true,
        ));

        let reconciled = store
            .reconcile_missing_worktree(&session.id)
            .expect("session exists");

        assert_eq!(reconciled.worktree_path, PathBuf::from("/tmp/acorn-repo"));
        assert!(!reconciled.isolated);
        assert_eq!(reconciled.id, session.id);
        assert_eq!(reconciled.name, session.name);
    }

    #[test]
    fn reconcile_missing_worktree_errors_for_unknown_session() {
        let store = SessionStore::new();
        let result = store.reconcile_missing_worktree(&Uuid::new_v4());
        assert!(matches!(result, Err(SessionError::NotFound(_))));
    }

    #[test]
    fn set_kind_promotes_regular_session() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));

        let promoted = store
            .set_kind(&session.id, SessionKind::Control)
            .expect("session exists");

        assert_eq!(promoted.kind, SessionKind::Control);
        assert_eq!(
            store.get(&session.id).expect("session persisted").kind,
            SessionKind::Control
        );
    }

    #[test]
    fn list_control_owned_descendants_follows_nested_ownership() {
        let store = SessionStore::new();
        let controller = store.insert({
            let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
            session.kind = SessionKind::Control;
            session
        });
        let worker = store.insert({
            let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
            session.name = "worker".to_string();
            session.owner = SessionOwner::control(controller.id);
            session
        });
        let nested = store.insert({
            let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
            session.name = "nested".to_string();
            session.owner = SessionOwner::control(worker.id);
            session
        });
        let user_owned = store.insert({
            let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
            session.name = "user".to_string();
            session
        });

        let descendants = store.list_control_owned_descendants(controller.id);
        let ids: HashSet<_> = descendants.into_iter().map(|session| session.id).collect();

        assert_eq!(ids, HashSet::from([worker.id, nested.id]));
        assert!(!ids.contains(&controller.id));
        assert!(!ids.contains(&user_owned.id));
    }

    #[test]
    fn list_control_owned_descendants_handles_cycles() {
        let store = SessionStore::new();
        let controller = store.insert({
            let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
            session.kind = SessionKind::Control;
            session
        });
        let worker = store.insert({
            let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
            session.owner = SessionOwner::control(controller.id);
            session
        });
        let mut controller_cycle = controller.clone();
        controller_cycle.owner = SessionOwner::control(worker.id);
        store.insert(controller_cycle);

        let descendants = store.list_control_owned_descendants(controller.id);

        assert_eq!(descendants.len(), 1);
        assert_eq!(descendants[0].id, worker.id);
    }

    #[test]
    fn set_generated_title_does_not_reorder_session() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        let original_updated_at = session.updated_at;

        let updated = store
            .set_generated_title(
                &session.id,
                "generated title".to_string(),
                Some("transcript-1".to_string()),
            )
            .expect("session exists");

        assert_eq!(updated.name, "generated title");
        assert_eq!(updated.title_source, SessionTitleSource::Generated);
        assert_eq!(
            updated.generated_title_transcript_id.as_deref(),
            Some("transcript-1")
        );
        assert_eq!(updated.updated_at, original_updated_at);
    }

    #[test]
    fn session_agent_provider_reports_hook_env_metadata() {
        assert!(SessionAgentProvider::Claude.supports_hooks());
        assert!(SessionAgentProvider::Codex.supports_hooks());
        assert!(SessionAgentProvider::Antigravity.supports_hooks());
        assert_eq!(
            SessionAgentProvider::Claude.hook_provider_env_value(),
            "claude"
        );
        assert_eq!(
            SessionAgentProvider::Codex.hook_provider_env_value(),
            "codex"
        );
        assert_eq!(
            SessionAgentProvider::Antigravity.hook_provider_env_value(),
            "antigravity"
        );
    }
}
