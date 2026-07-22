pub use acorn_agent::AgentKind as SessionAgentProvider;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;
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
pub enum SessionStatus {
    #[serde(rename = "ready", alias = "idle", alias = "completed")]
    Ready,
    #[serde(rename = "working", alias = "running")]
    Working,
    #[serde(rename = "waiting_for_input", alias = "needs_input")]
    WaitingForInput,
    #[serde(rename = "errored", alias = "failed")]
    Errored,
}

/// Runtime authority that most recently classified a session's lifecycle
/// status. This is intentionally kept outside the persisted [`Session`] row:
/// after an app restart, Acorn must re-establish whether native hooks or a
/// bounded fallback produced the current observation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatusSource {
    Hook,
    TranscriptFallback,
    ProcessFallback,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionGoalStagePolicy {
    Auto,
    Approval,
    Disabled,
}

impl Default for SessionGoalStagePolicy {
    fn default() -> Self {
        Self::Disabled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoalPolicies {
    pub plan: SessionGoalStagePolicy,
    pub implementation: SessionGoalStagePolicy,
    pub validation: SessionGoalStagePolicy,
    pub auto_fix: SessionGoalStagePolicy,
    pub self_review: SessionGoalStagePolicy,
    #[serde(alias = "draft_pr")]
    pub open_pr: SessionGoalStagePolicy,
    #[serde(default)]
    pub merge: SessionGoalStagePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoalPreset {
    pub id: String,
    pub name: String,
    pub policies: SessionGoalPolicies,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoalModelSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoalStageModels {
    #[serde(default)]
    pub plan: SessionGoalModelSelection,
    #[serde(default)]
    pub implementation: SessionGoalModelSelection,
    #[serde(default)]
    pub validation: SessionGoalModelSelection,
    #[serde(default)]
    pub auto_fix: SessionGoalModelSelection,
    #[serde(default)]
    pub self_review: SessionGoalModelSelection,
    #[serde(default, alias = "draft_pr")]
    pub open_pr: SessionGoalModelSelection,
    #[serde(default)]
    pub merge: SessionGoalModelSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoalModelConfig {
    #[serde(default = "default_true")]
    pub single_model: bool,
    #[serde(default)]
    pub default: SessionGoalModelSelection,
    #[serde(default)]
    pub stages: SessionGoalStageModels,
}

impl Default for SessionGoalModelConfig {
    fn default() -> Self {
        Self {
            single_model: true,
            default: SessionGoalModelSelection::default(),
            stages: SessionGoalStageModels::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionGoalStage {
    #[serde(alias = "interpretation")]
    Plan,
    Implementation,
    Validation,
    AutoFix,
    SelfReview,
    #[serde(alias = "draft_pr")]
    OpenPr,
    Merge,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionGoalRunState {
    /// Persisted Goal sessions created before staged execution was introduced
    /// remain readable and are never restarted implicitly.
    #[default]
    Legacy,
    Pending,
    Running,
    Waiting,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoalProgress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_stage: Option<SessionGoalStage>,
    #[serde(default)]
    pub state: SessionGoalRunState,
    /// Marks a Plan generated from a durable Goal edit. The stored Plan
    /// policy still decides whether execution pauses for approval.
    #[serde(default)]
    pub revision_review: bool,
    /// True only while the current stage still owes its policy-mandated
    /// approval boundary. A user's reply clears this before work resumes.
    #[serde(default)]
    pub approval_pending: bool,
}

impl SessionGoalProgress {
    pub fn initial() -> Self {
        Self {
            current_stage: Some(SessionGoalStage::Plan),
            state: SessionGoalRunState::Pending,
            revision_review: false,
            approval_pending: false,
        }
    }

    pub fn revised_plan() -> Self {
        Self {
            current_stage: Some(SessionGoalStage::Plan),
            state: SessionGoalRunState::Pending,
            revision_review: true,
            approval_pending: false,
        }
    }
}

fn default_goal_revision() -> u32 {
    1
}

/// Durable goal specification for a project-owned chat session. Preset
/// policies are copied into the session so later preset edits or deletion do
/// not change work that is already running.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGoal {
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_criteria: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tests: Option<String>,
    pub provider: SessionAgentProvider,
    pub preset: SessionGoalPreset,
    #[serde(default)]
    pub model_config: SessionGoalModelConfig,
    #[serde(default)]
    pub progress: SessionGoalProgress,
    #[serde(default = "default_goal_revision")]
    pub revision: u32,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<SessionGoal>,
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
    /// Whether this session has ever reported an agent lifecycle hook event.
    /// Persisted so hook ownership of the status survives an app restart: a
    /// daemon-managed PTY outlives the app, and its resting hook-set status
    /// (`ready` or `waiting_for_input`) must not be clobbered back to Working
    /// by the transcript-tail poll before the agent emits its first event to the
    /// new app instance (a resting agent may never emit one).
    #[serde(default)]
    pub hook_active: bool,
    /// Provider whose lifecycle hooks own the session status. Kept with
    /// `hook_active` so one provider's hook state does not mask a different
    /// Claude/Codex/Antigravity run in the same terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_provider: Option<SessionAgentProvider>,
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
            status: SessionStatus::Ready,
            created_at: now,
            updated_at: now,
            last_message: None,
            title_source: SessionTitleSource::Default,
            auto_title_enabled: Some(false),
            generated_title_transcript_id: None,
            kind,
            mode: SessionMode::Terminal,
            goal: None,
            owner: SessionOwner::User,
            position: None,
            daemon_session_id: None,
            agent_resume_token: None,
            hook_active: false,
            hook_provider: None,
            in_worktree: false,
            agent_provider: None,
            agent_transcript_id: None,
        }
    }
}

#[derive(Default)]
struct HookRuntimeState {
    confirmed: bool,
    revision: u64,
    lifecycle_revision: u64,
    status_source: Option<AgentStatusSource>,
    tool_started_at: Option<SystemTime>,
    turn_id: Option<String>,
    permission_waiting_at: Option<SystemTime>,
}

impl HookRuntimeState {
    fn advance_revision(&mut self) -> u64 {
        self.revision = self.revision.saturating_add(1);
        self.revision
    }

    fn advance_lifecycle_revision(&mut self) -> u64 {
        self.lifecycle_revision = self.lifecycle_revision.saturating_add(1);
        self.lifecycle_revision
    }

    fn clear_ownership_evidence(&mut self) {
        self.confirmed = false;
        self.status_source = None;
        self.tool_started_at = None;
        self.turn_id = None;
        self.permission_waiting_at = None;
    }
}

#[derive(Default)]
pub struct SessionStore {
    inner: DashMap<Uuid, Session>,
    /// Sessions that reported at least one agent lifecycle hook event
    /// (Start/Stop/NeedsInput/Error) *this run*. Runtime-only. The status
    /// poll consults hook activity to decide whether hooks own the
    /// Working/Ready/WaitingForInput classification: once a session proves
    /// its hook channel is live, the transcript-tail poll stops second-guessing
    /// turn completion (a long or tool-heavy Claude turn often leaves no
    /// `end_turn` line inside the tail window, so the tail keeps reading
    /// Working long after the turn ended) and only keeps ownership of the
    /// process-liveness edge after no agent remains.
    ///
    /// Hook activity itself also persists across restarts via the session's
    /// `hook_active` field; this ledger distinguishes "confirmed live this run"
    /// (an event actually arrived at this app instance's hook server) from
    /// "was hook-owned before the restart", which the poll's boot
    /// reconciliation needs when durable delivery has no retained event for
    /// the boundary. In that case the transcript is consulted once as a
    /// bounded compatibility signal.
    /// Runtime lifecycle state is kept behind one lock so revision checks,
    /// source transitions, and ownership evidence can be changed atomically.
    /// Methods that also touch `inner` always acquire this ledger first and a
    /// session row second.
    hook_runtime: Mutex<HashMap<Uuid, HookRuntimeState>>,
}

impl SessionStore {
    fn lock_hook_runtime(&self) -> MutexGuard<'_, HashMap<Uuid, HookRuntimeState>> {
        self.hook_runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.status = status;
        entry.updated_at = Utc::now();
        let state = runtime.entry(*id).or_default();
        state.status_source = None;
        state.advance_lifecycle_revision();
        Ok(entry.clone())
    }

    /// Apply an unattributed status without bumping `updated_at`. Explicit
    /// writes clear runtime provenance and always advance the lifecycle fence,
    /// even when the visible status is unchanged, so a stale poll cannot
    /// overwrite them or report an authority that did not produce the value.
    pub fn refresh_status(&self, id: &Uuid, status: SessionStatus) -> SessionResult<Session> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if entry.status != status {
            entry.status = status;
        }
        let state = runtime.entry(*id).or_default();
        state.status_source = None;
        state.advance_lifecycle_revision();
        Ok(entry.clone())
    }

    pub fn hook_revision(&self, id: &Uuid) -> u64 {
        self.lock_hook_runtime()
            .get(id)
            .map(|state| state.revision)
            .unwrap_or(0)
    }

    pub fn agent_status_source(&self, id: &Uuid) -> Option<AgentStatusSource> {
        self.lock_hook_runtime()
            .get(id)
            .and_then(|state| state.status_source)
    }

    /// Read the lifecycle state that poll arbitration compares as one
    /// snapshot. Holding the runtime ledger while cloning the session row
    /// prevents a reducer from pairing a newer source with an older status.
    pub fn lifecycle_snapshot(
        &self,
        id: &Uuid,
    ) -> SessionResult<(SessionStatus, Option<AgentStatusSource>, u64, u64)> {
        let runtime = self.lock_hook_runtime();
        let entry = self
            .inner
            .get(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.get(id);
        Ok((
            entry.status,
            state.and_then(|state| state.status_source),
            state.map(|state| state.revision).unwrap_or(0),
            state.map(|state| state.lifecycle_revision).unwrap_or(0),
        ))
    }

    /// Record or clear lifecycle authority without changing the session
    /// status. Reducers should prefer [`Self::refresh_status_with_source`] so
    /// their paired status/source transition is observed under one critical
    /// section.
    pub fn mark_agent_status_source(&self, id: &Uuid, source: Option<AgentStatusSource>) {
        let mut runtime = self.lock_hook_runtime();
        if !self.inner.contains_key(id) {
            return;
        }
        let state = runtime.entry(*id).or_default();
        state.status_source = source;
        state.advance_lifecycle_revision();
    }

    /// Refresh status and its runtime authority together without bumping
    /// `updated_at`.
    pub fn refresh_status_with_source(
        &self,
        id: &Uuid,
        status: SessionStatus,
        source: Option<AgentStatusSource>,
    ) -> SessionResult<Session> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        entry.status = status;
        let state = runtime.entry(*id).or_default();
        state.status_source = source;
        state.advance_lifecycle_revision();
        Ok(entry.clone())
    }

    /// Refresh status and lifecycle authority only if the complete state
    /// observed by a poll is still current. Comparing both source and hook
    /// generation rejects stale polls after a fallback transition, because
    /// fallback events deliberately do not advance the native hook revision.
    pub fn refresh_status_and_source_if_hook_revision(
        &self,
        id: &Uuid,
        expected_status: SessionStatus,
        expected_source: Option<AgentStatusSource>,
        expected_hook_revision: u64,
        status: SessionStatus,
        source: Option<AgentStatusSource>,
    ) -> SessionResult<bool> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.entry(*id).or_default();
        if entry.status != expected_status
            || state.status_source != expected_source
            || state.revision != expected_hook_revision
        {
            return Ok(false);
        }
        entry.status = status;
        state.status_source = source;
        state.advance_lifecycle_revision();
        Ok(true)
    }

    /// Apply a poll-derived status/source pair only while no lifecycle writer
    /// has run since the poll captured its snapshot. The monotonic lifecycle
    /// revision closes ABA races where fallback events return to the same
    /// visible status and source before a slow poll completes.
    pub fn refresh_status_and_source_if_lifecycle_revision(
        &self,
        id: &Uuid,
        expected_status: SessionStatus,
        expected_source: Option<AgentStatusSource>,
        expected_lifecycle_revision: u64,
        status: SessionStatus,
        source: Option<AgentStatusSource>,
    ) -> SessionResult<Option<u64>> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.entry(*id).or_default();
        if entry.status != expected_status
            || state.status_source != expected_source
            || state.lifecycle_revision != expected_lifecycle_revision
        {
            return Ok(None);
        }
        entry.status = status;
        state.status_source = source;
        Ok(Some(state.advance_lifecycle_revision()))
    }

    /// Record that `id` reported an agent lifecycle hook event, marking its
    /// hook channel live so the status poll defers turn-boundary
    /// classification to hooks (see [`Self::is_hook_confirmed_this_run`]). Also stamps
    /// the session's persisted `hook_active` flag so hook ownership survives
    /// an app restart. The persisted flag is idempotent; the runtime revision
    /// advances for every event.
    pub fn mark_hook_active(&self, id: &Uuid, provider: SessionAgentProvider) -> u64 {
        let mut runtime = self.lock_hook_runtime();
        let Some(mut entry) = self.inner.get_mut(id) else {
            return runtime.get(id).map(|state| state.revision).unwrap_or(0);
        };
        let state = runtime.entry(*id).or_default();
        let revision = state.advance_revision();
        state.advance_lifecycle_revision();
        state.confirmed = true;
        state.status_source = Some(AgentStatusSource::Hook);
        if !entry.hook_active {
            // Deliberately no `updated_at` bump — hook telemetry must
            // not reshuffle the sidebar's most-recent-first ordering.
            entry.hook_active = true;
        }
        entry.hook_provider = Some(provider);
        entry.agent_provider = Some(provider);
        revision
    }

    /// Apply a native lifecycle transition and claim hook ownership as one
    /// transaction. Reducers use this instead of publishing hook provenance
    /// before the corresponding status is visible.
    pub fn apply_native_status(
        &self,
        id: &Uuid,
        provider: SessionAgentProvider,
        status: SessionStatus,
    ) -> SessionResult<u64> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.entry(*id).or_default();
        let revision = state.advance_revision();
        state.advance_lifecycle_revision();
        state.confirmed = true;
        state.status_source = Some(AgentStatusSource::Hook);
        entry.status = status;
        entry.hook_active = true;
        entry.hook_provider = Some(provider);
        entry.agent_provider = Some(provider);
        Ok(revision)
    }

    /// Clear persisted and runtime hook ownership only when the caller's
    /// lifecycle generation is still current. The revision advances before
    /// releasing the ledger so any observation made before this clear cannot
    /// later re-apply stale status or provider metadata.
    pub fn clear_hook_ownership_if_revision(
        &self,
        id: &Uuid,
        expected_hook_revision: u64,
        expected_lifecycle_revision: u64,
    ) -> SessionResult<bool> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.entry(*id).or_default();
        if state.revision != expected_hook_revision
            || state.lifecycle_revision != expected_lifecycle_revision
        {
            return Ok(false);
        }

        state.advance_revision();
        state.advance_lifecycle_revision();
        state.clear_ownership_evidence();
        entry.hook_active = false;
        entry.hook_provider = None;
        Ok(true)
    }

    /// Reset per-turn tool evidence and bind the Codex turn id when Codex
    /// reports a new task boundary. An empty sentinel is meaningful: the
    /// user's next turn has begun, but Codex has not emitted its id yet, so
    /// any completion for the previous id is stale. Keeping that boundary in
    /// the map also distinguishes it from runtime state lost on app restart.
    pub fn begin_hook_turn(&self, id: &Uuid, turn_id: Option<&str>) {
        let mut runtime = self.lock_hook_runtime();
        let state = runtime.entry(*id).or_default();
        state.tool_started_at = None;
        state.permission_waiting_at = None;
        state.turn_id = Some(
            turn_id
                .map(str::trim)
                .filter(|turn_id| !turn_id.is_empty())
                .unwrap_or_default()
                .to_string(),
        );
    }

    pub fn hook_turn_id(&self, id: &Uuid) -> Option<String> {
        self.lock_hook_runtime()
            .get(id)
            .and_then(|state| state.turn_id.clone())
            .filter(|turn_id| !turn_id.is_empty())
    }

    /// Whether this app run has observed a Codex turn boundary, including a
    /// user submission for which Codex has not assigned a turn id yet.
    pub fn has_hook_turn_boundary(&self, id: &Uuid) -> bool {
        self.lock_hook_runtime()
            .get(id)
            .and_then(|state| state.turn_id.as_ref())
            .is_some()
    }

    /// Record the first exec tool observed in the current Codex turn. Keeping
    /// the earliest timestamp ensures a background process launched by an
    /// earlier tool still counts after later tools run in the same turn.
    pub fn mark_hook_tool_started_at(&self, id: &Uuid, started_at: SystemTime) {
        let mut runtime = self.lock_hook_runtime();
        runtime
            .entry(*id)
            .or_default()
            .tool_started_at
            .get_or_insert(started_at);
    }

    pub fn hook_tool_started_at(&self, id: &Uuid) -> Option<SystemTime> {
        self.lock_hook_runtime()
            .get(id)
            .and_then(|state| state.tool_started_at)
    }

    pub fn mark_codex_permission_waiting_at(&self, id: &Uuid, requested_at: SystemTime) {
        self.lock_hook_runtime()
            .entry(*id)
            .or_default()
            .permission_waiting_at = Some(requested_at);
    }

    pub fn codex_permission_waiting_at(&self, id: &Uuid) -> Option<SystemTime> {
        self.lock_hook_runtime()
            .get(id)
            .and_then(|state| state.permission_waiting_at)
    }

    pub fn clear_codex_permission_waiting(&self, id: &Uuid) {
        if let Some(state) = self.lock_hook_runtime().get_mut(id) {
            state.permission_waiting_at = None;
        }
    }

    /// Whether `id` has ever reported an agent lifecycle hook event — either
    /// this run or (via the persisted `hook_active` session flag) in a
    /// previous one.
    pub fn is_hook_active(&self, id: &Uuid) -> bool {
        let runtime = self.lock_hook_runtime();
        runtime.get(id).is_some_and(|state| state.confirmed)
            || self
                .inner
                .get(id)
                .map(|entry| entry.hook_active)
                .unwrap_or(false)
    }

    pub fn hook_provider(&self, id: &Uuid) -> Option<SessionAgentProvider> {
        self.inner.get(id).and_then(|entry| entry.hook_provider)
    }

    /// Whether `id` reported an agent lifecycle hook event *this run* — an
    /// event actually reached this app instance's hook server. False right
    /// after a restart even for sessions whose persisted `hook_active` flag
    /// is set; the status poll uses that gap to reconcile a turn boundary
    /// that was crossed while the app was closed.
    pub fn is_hook_confirmed_this_run(&self, id: &Uuid) -> bool {
        self.lock_hook_runtime()
            .get(id)
            .is_some_and(|state| state.confirmed)
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

    /// Refresh process-derived provider metadata only while both the native
    /// hook generation and lifecycle authority still match the poll's
    /// observation. This prevents a stale process scan from overwriting a
    /// provider claimed by a newer hook or fallback event.
    pub fn refresh_agent_state_if_hook_revision(
        &self,
        id: &Uuid,
        expected_hook_revision: u64,
        expected_source: Option<AgentStatusSource>,
        provider: Option<SessionAgentProvider>,
        transcript_id: Option<String>,
    ) -> SessionResult<bool> {
        let runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.get(id);
        let revision = state.map(|state| state.revision).unwrap_or(0);
        let source = state.and_then(|state| state.status_source);
        if revision != expected_hook_revision || source != expected_source {
            return Ok(false);
        }
        entry.agent_provider = provider;
        entry.agent_transcript_id = transcript_id;
        Ok(true)
    }

    pub fn refresh_agent_state_if_lifecycle_revision(
        &self,
        id: &Uuid,
        expected_lifecycle_revision: u64,
        expected_source: Option<AgentStatusSource>,
        provider: Option<SessionAgentProvider>,
        transcript_id: Option<String>,
    ) -> SessionResult<bool> {
        let runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let state = runtime.get(id);
        let lifecycle_revision = state.map(|state| state.lifecycle_revision).unwrap_or(0);
        let source = state.and_then(|state| state.status_source);
        if lifecycle_revision != expected_lifecycle_revision || source != expected_source {
            return Ok(false);
        }
        entry.agent_provider = provider;
        entry.agent_transcript_id = transcript_id;
        Ok(true)
    }

    /// Record provider identity from a non-authoritative owner observation
    /// before its native hook arrives. A provider-specific transcript can
    /// prove which agent owns the PTY without proving lifecycle status, so a
    /// switch clears only the previous provider's hook ownership and runtime
    /// turn evidence. The next native event establishes the new hook channel.
    pub fn prepare_agent_provider_switch(
        &self,
        id: &Uuid,
        provider: SessionAgentProvider,
    ) -> SessionResult<Session> {
        let mut runtime = self.lock_hook_runtime();
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let switches_provider = entry
            .agent_provider
            .is_some_and(|current| current != provider)
            || entry
                .hook_provider
                .is_some_and(|current| current != provider);
        entry.agent_provider = Some(provider);
        if switches_provider {
            entry.hook_provider = None;
            entry.hook_active = false;
            let state = runtime.entry(*id).or_default();
            if state.confirmed {
                state.advance_revision();
            }
            state.advance_lifecycle_revision();
            state.clear_ownership_evidence();
        }
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

    pub fn update_goal(
        &self,
        id: &Uuid,
        expected_revision: u32,
        goal: SessionGoal,
    ) -> SessionResult<Option<Session>> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if entry.goal.as_ref().map(|current| current.revision) != Some(expected_revision) {
            return Ok(None);
        }
        entry.agent_provider = Some(goal.provider);
        entry.goal = Some(goal);
        entry.updated_at = Utc::now();
        Ok(Some(entry.clone()))
    }

    pub fn update_goal_progress_if_revision(
        &self,
        id: &Uuid,
        expected_revision: u32,
        progress: SessionGoalProgress,
    ) -> SessionResult<Option<Session>> {
        let mut entry = self
            .inner
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        let Some(goal) = entry.goal.as_mut() else {
            return Ok(None);
        };
        if goal.revision != expected_revision {
            return Ok(None);
        }
        goal.progress = progress;
        entry.updated_at = Utc::now();
        Ok(Some(entry.clone()))
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
        let mut runtime = self.lock_hook_runtime();
        let removed = self
            .inner
            .remove(id)
            .map(|(_, v)| v)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        runtime.remove(id);
        Ok(removed)
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

    fn fake_goal(revision: u32) -> SessionGoal {
        SessionGoal {
            objective: "Ship project goal sessions".to_string(),
            completion_criteria: Some("Goal survives restart".to_string()),
            constraints: None,
            tests: Some("cargo test".to_string()),
            provider: SessionAgentProvider::Codex,
            preset: SessionGoalPreset {
                id: "builtin:balanced".to_string(),
                name: "Balanced".to_string(),
                policies: SessionGoalPolicies {
                    plan: SessionGoalStagePolicy::Approval,
                    implementation: SessionGoalStagePolicy::Auto,
                    validation: SessionGoalStagePolicy::Auto,
                    auto_fix: SessionGoalStagePolicy::Auto,
                    self_review: SessionGoalStagePolicy::Auto,
                    open_pr: SessionGoalStagePolicy::Disabled,
                    merge: SessionGoalStagePolicy::Disabled,
                },
            },
            model_config: SessionGoalModelConfig::default(),
            progress: SessionGoalProgress::initial(),
            revision,
        }
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
    fn hook_activity_is_tracked_and_cleared_on_remove() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));

        assert!(!store.is_hook_active(&session.id));
        assert!(!store.is_hook_confirmed_this_run(&session.id));

        store.mark_hook_active(&session.id, SessionAgentProvider::Codex);
        assert!(store.is_hook_active(&session.id));
        assert!(store.is_hook_confirmed_this_run(&session.id));
        assert_eq!(
            store.hook_provider(&session.id),
            Some(SessionAgentProvider::Codex)
        );
        assert_eq!(store.hook_revision(&session.id), 1);
        store.mark_hook_active(&session.id, SessionAgentProvider::Claude);
        assert!(store.is_hook_active(&session.id));
        assert_eq!(
            store.hook_provider(&session.id),
            Some(SessionAgentProvider::Claude)
        );
        assert_eq!(store.hook_revision(&session.id), 2);

        store.remove(&session.id).expect("session exists");
        assert!(!store.is_hook_active(&session.id));
        assert!(!store.is_hook_confirmed_this_run(&session.id));
        assert_eq!(store.hook_provider(&session.id), None);
        assert_eq!(store.hook_revision(&session.id), 0);
    }

    #[test]
    fn hook_ownership_clear_is_revision_safe_and_clears_runtime_evidence() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        let observed_at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(123_456);

        let first_revision = store.mark_hook_active(&session.id, SessionAgentProvider::Codex);
        store.begin_hook_turn(&session.id, Some("turn-1"));
        store.mark_hook_tool_started_at(&session.id, observed_at);
        store.mark_codex_permission_waiting_at(&session.id, observed_at);
        let first_lifecycle_revision = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists")
            .3;

        assert_eq!(
            store.agent_status_source(&session.id),
            Some(AgentStatusSource::Hook)
        );
        assert!(
            store
                .clear_hook_ownership_if_revision(
                    &session.id,
                    first_revision,
                    first_lifecycle_revision,
                )
                .expect("session exists")
        );
        assert!(!store.is_hook_active(&session.id));
        assert!(!store.is_hook_confirmed_this_run(&session.id));
        assert_eq!(store.hook_provider(&session.id), None);
        assert_eq!(store.agent_status_source(&session.id), None);
        assert_eq!(store.hook_turn_id(&session.id), None);
        assert_eq!(store.hook_tool_started_at(&session.id), None);
        assert_eq!(store.codex_permission_waiting_at(&session.id), None);

        let cleared_revision = store.hook_revision(&session.id);
        assert!(cleared_revision > first_revision);
        let replacement_revision =
            store.mark_hook_active(&session.id, SessionAgentProvider::Claude);
        store.begin_hook_turn(&session.id, Some("turn-2"));

        assert!(replacement_revision > cleared_revision);
        assert!(
            !store
                .clear_hook_ownership_if_revision(
                    &session.id,
                    first_revision,
                    first_lifecycle_revision,
                )
                .expect("session exists")
        );
        assert!(store.is_hook_active(&session.id));
        assert!(store.is_hook_confirmed_this_run(&session.id));
        assert_eq!(
            store.hook_provider(&session.id),
            Some(SessionAgentProvider::Claude)
        );
        assert_eq!(
            store.agent_status_source(&session.id),
            Some(AgentStatusSource::Hook)
        );
        assert_eq!(store.hook_turn_id(&session.id).as_deref(), Some("turn-2"));
        assert_eq!(store.hook_revision(&session.id), replacement_revision);
    }

    #[test]
    fn hook_tool_activity_is_scoped_to_a_turn_and_cleared_on_remove() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        let started_at =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(123_456);

        store.mark_hook_tool_started_at(&session.id, started_at);
        assert_eq!(store.hook_tool_started_at(&session.id), Some(started_at));

        store.begin_hook_turn(&session.id, Some("turn-1"));
        assert_eq!(store.hook_tool_started_at(&session.id), None);
        assert_eq!(store.hook_turn_id(&session.id).as_deref(), Some("turn-1"));

        store.begin_hook_turn(&session.id, None);
        assert_eq!(store.hook_turn_id(&session.id), None);

        store.mark_hook_tool_started_at(&session.id, started_at);
        store.remove(&session.id).expect("session exists");
        assert_eq!(store.hook_tool_started_at(&session.id), None);
        assert_eq!(store.hook_turn_id(&session.id), None);
    }

    #[test]
    fn codex_permission_boundary_is_scoped_to_a_turn_and_cleared_on_remove() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        let requested_at =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(123_456);

        store.mark_codex_permission_waiting_at(&session.id, requested_at);
        assert_eq!(
            store.codex_permission_waiting_at(&session.id),
            Some(requested_at)
        );

        store.begin_hook_turn(&session.id, Some("turn-1"));
        assert_eq!(store.codex_permission_waiting_at(&session.id), None);

        store.mark_codex_permission_waiting_at(&session.id, requested_at);
        store.clear_codex_permission_waiting(&session.id);
        assert_eq!(store.codex_permission_waiting_at(&session.id), None);

        store.mark_codex_permission_waiting_at(&session.id, requested_at);
        store.remove(&session.id).expect("session exists");
        assert_eq!(store.codex_permission_waiting_at(&session.id), None);
    }

    #[test]
    fn status_and_source_refresh_requires_the_complete_observed_state() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        store
            .refresh_status_with_source(
                &session.id,
                SessionStatus::Working,
                Some(AgentStatusSource::ProcessFallback),
            )
            .expect("session exists");
        let revision = store.hook_revision(&session.id);

        assert!(!store
            .refresh_status_and_source_if_hook_revision(
                &session.id,
                SessionStatus::Working,
                Some(AgentStatusSource::Hook),
                revision,
                SessionStatus::WaitingForInput,
                Some(AgentStatusSource::TranscriptFallback),
            )
            .expect("session exists"));
        assert_eq!(
            store.agent_status_source(&session.id),
            Some(AgentStatusSource::ProcessFallback)
        );

        assert!(store
            .refresh_status_and_source_if_hook_revision(
                &session.id,
                SessionStatus::Working,
                Some(AgentStatusSource::ProcessFallback),
                revision,
                SessionStatus::WaitingForInput,
                Some(AgentStatusSource::TranscriptFallback),
            )
            .expect("session exists"));
        assert_eq!(
            store.get(&session.id).expect("session exists").status,
            SessionStatus::WaitingForInput
        );
        assert_eq!(
            store.agent_status_source(&session.id),
            Some(AgentStatusSource::TranscriptFallback)
        );

        store.mark_hook_active(&session.id, SessionAgentProvider::Codex);
        assert!(!store
            .refresh_status_and_source_if_hook_revision(
                &session.id,
                SessionStatus::WaitingForInput,
                Some(AgentStatusSource::TranscriptFallback),
                revision,
                SessionStatus::Ready,
                None,
            )
            .expect("session exists"));
        assert_eq!(
            store.agent_status_source(&session.id),
            Some(AgentStatusSource::Hook)
        );
    }

    #[test]
    fn lifecycle_revision_rejects_an_aba_fallback_write() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        store
            .refresh_status_with_source(
                &session.id,
                SessionStatus::Working,
                Some(AgentStatusSource::TranscriptFallback),
            )
            .expect("session exists");
        let (_, source, _, lifecycle_revision) = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists");

        store
            .refresh_status_with_source(
                &session.id,
                SessionStatus::WaitingForInput,
                Some(AgentStatusSource::TranscriptFallback),
            )
            .expect("session exists");
        store
            .refresh_status_with_source(
                &session.id,
                SessionStatus::Working,
                Some(AgentStatusSource::TranscriptFallback),
            )
            .expect("session exists");

        assert_eq!(
            store
                .refresh_status_and_source_if_lifecycle_revision(
                    &session.id,
                    SessionStatus::Working,
                    source,
                    lifecycle_revision,
                    SessionStatus::Ready,
                    None,
                )
                .expect("session exists"),
            None
        );
        assert_eq!(
            store.get(&session.id).expect("session exists").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn explicit_status_writes_clear_source_and_fence_stale_polls() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        store
            .apply_native_status(
                &session.id,
                SessionAgentProvider::Codex,
                SessionStatus::Working,
            )
            .expect("session exists");
        let (status, source, _, lifecycle_revision) = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists");

        store
            .update_status(&session.id, SessionStatus::Ready)
            .expect("session exists");
        let (_, updated_source, _, updated_lifecycle_revision) = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists");
        assert_eq!(updated_source, None);
        assert!(updated_lifecycle_revision > lifecycle_revision);
        assert_eq!(
            store
                .refresh_status_and_source_if_lifecycle_revision(
                    &session.id,
                    status,
                    source,
                    lifecycle_revision,
                    SessionStatus::WaitingForInput,
                    Some(AgentStatusSource::TranscriptFallback),
                )
                .expect("session exists"),
            None
        );

        store
            .refresh_status_with_source(
                &session.id,
                SessionStatus::WaitingForInput,
                Some(AgentStatusSource::TranscriptFallback),
            )
            .expect("session exists");
        let (_, _, _, fallback_lifecycle_revision) = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists");
        store
            .refresh_status(&session.id, SessionStatus::Working)
            .expect("session exists");
        let (_, refreshed_source, _, refreshed_lifecycle_revision) = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists");
        assert_eq!(refreshed_source, None);
        assert!(refreshed_lifecycle_revision > fallback_lifecycle_revision);
    }

    #[test]
    fn conditional_agent_state_refresh_checks_revision_and_source() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        store.mark_agent_status_source(&session.id, Some(AgentStatusSource::ProcessFallback));
        let revision = store.hook_revision(&session.id);

        assert!(!store
            .refresh_agent_state_if_hook_revision(
                &session.id,
                revision,
                Some(AgentStatusSource::Hook),
                Some(SessionAgentProvider::Codex),
                Some("codex-stale".to_string()),
            )
            .expect("session exists"));
        assert_eq!(
            store
                .get(&session.id)
                .expect("session exists")
                .agent_provider,
            None
        );

        assert!(store
            .refresh_agent_state_if_hook_revision(
                &session.id,
                revision,
                Some(AgentStatusSource::ProcessFallback),
                Some(SessionAgentProvider::Codex),
                Some("codex-current".to_string()),
            )
            .expect("session exists"));
        store.mark_hook_active(&session.id, SessionAgentProvider::Claude);

        assert!(!store
            .refresh_agent_state_if_hook_revision(
                &session.id,
                revision,
                Some(AgentStatusSource::ProcessFallback),
                None,
                None,
            )
            .expect("session exists"));
        let stored = store.get(&session.id).expect("session exists");
        assert_eq!(stored.agent_provider, Some(SessionAgentProvider::Claude));
        assert_eq!(stored.agent_transcript_id.as_deref(), Some("codex-current"));
    }

    #[test]
    fn agent_status_source_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&AgentStatusSource::TranscriptFallback)
                .expect("source serializes"),
            "\"transcript_fallback\""
        );
        assert_eq!(
            serde_json::from_str::<AgentStatusSource>("\"process_fallback\"")
                .expect("source deserializes"),
            AgentStatusSource::ProcessFallback
        );
    }

    #[test]
    fn hook_activity_persists_on_session_and_survives_reload() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));

        store.mark_hook_active(&session.id, SessionAgentProvider::Claude);
        let marked = store.get(&session.id).expect("session exists");
        assert!(marked.hook_active);
        assert_eq!(marked.hook_provider, Some(SessionAgentProvider::Claude));

        // Simulate an app restart: serialize, load into a fresh store.
        let json = serde_json::to_string(&marked).expect("session serializes");
        let reloaded: Session = serde_json::from_str(&json).expect("session deserializes");
        let fresh = SessionStore::new();
        fresh.insert(reloaded);

        // Hook ownership survives the restart, but no event has been
        // confirmed against the new run's hook server yet.
        assert!(fresh.is_hook_active(&session.id));
        assert!(!fresh.is_hook_confirmed_this_run(&session.id));
        assert_eq!(
            fresh.hook_provider(&session.id),
            Some(SessionAgentProvider::Claude)
        );
    }

    #[test]
    fn sessions_persisted_before_hook_active_field_load_as_inactive() {
        let session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        let mut value = serde_json::to_value(&session).expect("session serializes");
        value
            .as_object_mut()
            .expect("session is an object")
            .remove("hook_active");
        let reloaded: Session = serde_json::from_value(value).expect("legacy session deserializes");
        assert!(!reloaded.hook_active);
        assert_eq!(reloaded.hook_provider, None);
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
    fn observed_provider_switch_clears_previous_hook_ownership_and_turn_evidence() {
        let store = SessionStore::new();
        let session = store.insert(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false));
        store.mark_hook_active(&session.id, SessionAgentProvider::Claude);
        store.begin_hook_turn(&session.id, Some("turn-1"));
        store.mark_hook_tool_started_at(&session.id, SystemTime::now());
        store.mark_codex_permission_waiting_at(&session.id, SystemTime::now());
        let hook_revision = store.hook_revision(&session.id);

        let switched = store
            .prepare_agent_provider_switch(&session.id, SessionAgentProvider::Antigravity)
            .expect("session exists");

        assert_eq!(
            switched.agent_provider,
            Some(SessionAgentProvider::Antigravity)
        );
        assert_eq!(switched.hook_provider, None);
        assert!(!switched.hook_active);
        assert!(!store.is_hook_confirmed_this_run(&session.id));
        assert_eq!(store.agent_status_source(&session.id), None);
        assert!(store.hook_revision(&session.id) > hook_revision);
        assert_eq!(store.hook_turn_id(&session.id), None);
        assert_eq!(store.hook_tool_started_at(&session.id), None);
        assert_eq!(store.codex_permission_waiting_at(&session.id), None);
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
    fn persisted_sessions_without_goal_load_as_non_goal_sessions() {
        let mut json =
            serde_json::to_value(fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false))
                .expect("session serializes");
        json.as_object_mut()
            .expect("session json is an object")
            .remove("goal");

        let restored: Session = serde_json::from_value(json).expect("session deserializes");

        assert_eq!(restored.goal, None);
    }

    #[test]
    fn goal_metadata_round_trips_with_the_session() {
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.mode = SessionMode::Chat;
        session.goal = Some(fake_goal(3));

        let json = serde_json::to_value(&session).expect("goal session serializes");
        let restored: Session = serde_json::from_value(json).expect("goal session deserializes");

        assert_eq!(restored.goal, session.goal);
    }

    #[test]
    fn previous_goal_pipeline_maps_to_plan_and_never_enables_merge() {
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.mode = SessionMode::Chat;
        let mut goal = fake_goal(3);
        goal.model_config.stages.open_pr.model = Some("legacy-pr-model".to_string());
        session.goal = Some(goal);
        let mut json = serde_json::to_value(&session).expect("goal session serializes");
        let goal = json
            .get_mut("goal")
            .and_then(serde_json::Value::as_object_mut)
            .expect("goal is an object");

        let policies = goal
            .get_mut("preset")
            .and_then(|preset| preset.get_mut("policies"))
            .and_then(serde_json::Value::as_object_mut)
            .expect("policies are an object");
        let open_pr = policies.remove("open_pr").expect("open PR policy");
        policies.insert("draft_pr".to_string(), open_pr);
        policies.insert("interpretation".to_string(), serde_json::json!("auto"));
        policies.remove("merge");

        let stages = goal
            .get_mut("model_config")
            .and_then(|config| config.get_mut("stages"))
            .and_then(serde_json::Value::as_object_mut)
            .expect("stage models are an object");
        let open_pr = stages.remove("open_pr").expect("open PR model");
        stages.insert("draft_pr".to_string(), open_pr);
        stages.insert("interpretation".to_string(), serde_json::json!({}));
        stages.remove("merge");

        goal.get_mut("progress")
            .and_then(serde_json::Value::as_object_mut)
            .expect("progress is an object")
            .insert(
                "current_stage".to_string(),
                serde_json::json!("interpretation"),
            );

        let restored: Session = serde_json::from_value(json).expect("old goal deserializes");
        let restored_goal = restored.goal.expect("goal remains present");

        assert_eq!(
            restored_goal.progress.current_stage,
            Some(SessionGoalStage::Plan)
        );
        assert_eq!(
            restored_goal.preset.policies.open_pr,
            SessionGoalStagePolicy::Disabled
        );
        assert_eq!(
            restored_goal.preset.policies.merge,
            SessionGoalStagePolicy::Disabled
        );
        assert_eq!(
            restored_goal.model_config.stages.open_pr.model.as_deref(),
            Some("legacy-pr-model")
        );
        assert_eq!(
            restored_goal.model_config.stages.merge,
            SessionGoalModelSelection::default()
        );
    }

    #[test]
    fn legacy_goal_metadata_loads_without_restarting_staged_execution() {
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.mode = SessionMode::Chat;
        session.goal = Some(fake_goal(3));
        let mut json = serde_json::to_value(&session).expect("goal session serializes");
        let goal = json
            .get_mut("goal")
            .and_then(serde_json::Value::as_object_mut)
            .expect("goal is an object");
        goal.remove("model_config");
        goal.remove("progress");

        let restored: Session = serde_json::from_value(json).expect("legacy goal deserializes");
        let restored_goal = restored.goal.expect("goal remains present");

        assert!(restored_goal.model_config.single_model);
        assert_eq!(restored_goal.progress.state, SessionGoalRunState::Legacy);
        assert_eq!(restored_goal.progress.current_stage, None);
    }

    #[test]
    fn goal_updates_require_the_current_revision() {
        let store = SessionStore::new();
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.mode = SessionMode::Chat;
        session.goal = Some(fake_goal(1));
        let session = store.insert(session);

        assert!(store
            .update_goal(&session.id, 0, fake_goal(2))
            .expect("session exists")
            .is_none());
        let updated = store
            .update_goal(&session.id, 1, fake_goal(2))
            .expect("session exists")
            .expect("revision matches");

        assert_eq!(updated.goal.as_ref().map(|goal| goal.revision), Some(2));
        assert_eq!(updated.agent_provider, Some(SessionAgentProvider::Codex));
    }

    #[test]
    fn goal_progress_updates_are_fenced_by_goal_revision() {
        let store = SessionStore::new();
        let mut session = fake_session("/tmp/acorn-repo", "/tmp/acorn-repo", false);
        session.mode = SessionMode::Chat;
        session.goal = Some(fake_goal(2));
        let session = store.insert(session);
        let progress = SessionGoalProgress {
            current_stage: Some(SessionGoalStage::Implementation),
            state: SessionGoalRunState::Running,
            revision_review: false,
            approval_pending: false,
        };

        assert!(store
            .update_goal_progress_if_revision(&session.id, 1, progress.clone())
            .expect("session exists")
            .is_none());
        let updated = store
            .update_goal_progress_if_revision(&session.id, 2, progress.clone())
            .expect("session exists")
            .expect("revision matches");

        assert_eq!(updated.goal.expect("goal").progress, progress);
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
            serde_json::to_string(&SessionAgentProvider::Claude).unwrap(),
            "\"claude\""
        );
        assert_eq!(
            serde_json::to_string(&SessionAgentProvider::Codex).unwrap(),
            "\"codex\""
        );
        assert_eq!(
            serde_json::to_string(&SessionAgentProvider::Antigravity).unwrap(),
            "\"antigravity\""
        );
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
