use std::collections::VecDeque;
use std::fmt;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use acorn_session::{SessionAgentProvider, SessionStatus, SessionStore};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

pub const AGENT_HOOK_STATUS_EVENT: &str = "acorn:agent-hook-status";

const HOOK_PATH: &str = "/agent-hook";
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const READ_TIMEOUT: Duration = Duration::from_secs(2);

type HookEventHandler =
    Arc<dyn Fn(AgentHookEvent) -> AgentHookHandlerOutcome + Send + Sync + 'static>;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AgentHookEvent {
    pub session_id: Uuid,
    pub provider: SessionAgentProvider,
    pub event: AgentHookEventKind,
    pub message: Option<String>,
    pub source: Option<String>,
    #[serde(default)]
    pub lifecycle_id: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default, alias = "turn_id")]
    pub provider_turn_id: Option<String>,
    #[serde(default)]
    pub provider_tool_id: Option<String>,
    #[serde(default)]
    pub provider_version: Option<String>,
    #[serde(default)]
    pub native_hooks_enabled: Option<bool>,
    #[serde(default)]
    pub ownership: AgentHookOwnership,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentHookOwnership {
    #[default]
    Owner,
    Child,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentHookEventKind {
    Start,
    Stop,
    NeedsInput,
    Error,
}

impl AgentHookEventKind {
    pub fn session_status(self) -> SessionStatus {
        match self {
            Self::Start => SessionStatus::Working,
            Self::NeedsInput => SessionStatus::WaitingForInput,
            Self::Stop => SessionStatus::Ready,
            Self::Error => SessionStatus::Errored,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentHookApplyOutcome {
    Applied(SessionStatus),
    Ignored {
        status: SessionStatus,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentHookApplyError {
    Unavailable(String),
    Conflict(String),
}

impl fmt::Display for AgentHookApplyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(reason) | Self::Conflict(reason) => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for AgentHookApplyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHookHandlerOutcome {
    Applied,
    Ignored,
    Unavailable,
    Conflict,
}

impl From<Result<AgentHookApplyOutcome, AgentHookApplyError>> for AgentHookHandlerOutcome {
    fn from(result: Result<AgentHookApplyOutcome, AgentHookApplyError>) -> Self {
        match result {
            Ok(AgentHookApplyOutcome::Applied(_)) => Self::Applied,
            Ok(AgentHookApplyOutcome::Ignored { .. }) => Self::Ignored,
            Err(AgentHookApplyError::Unavailable(_)) => Self::Unavailable,
            Err(AgentHookApplyError::Conflict(_)) => Self::Conflict,
        }
    }
}

pub struct AgentHookReducer {
    sessions: Arc<SessionStore>,
    lanes: DashMap<Uuid, Arc<Mutex<HookLane>>>,
}

impl AgentHookReducer {
    pub fn new(sessions: Arc<SessionStore>) -> Self {
        Self {
            sessions,
            lanes: DashMap::new(),
        }
    }

    pub fn apply(
        &self,
        event: AgentHookEvent,
    ) -> Result<AgentHookApplyOutcome, AgentHookApplyError> {
        // Lane creation is the only growth point of this map, so prune dead
        // entries here: a session removed mid-run stops receiving events and
        // would otherwise leave its lane resident for the app lifetime
        // (`SessionStore::remove` cannot reach this map).
        if !self.lanes.contains_key(&event.session_id) {
            self.lanes.retain(|id, _| self.sessions.get(id).is_ok());
        }
        let lane = self
            .lanes
            .entry(event.session_id)
            .or_insert_with(|| Arc::new(Mutex::new(HookLane::default())))
            .clone();
        let mut lane = lane.lock();
        let session = match self.sessions.get(&event.session_id) {
            Ok(session) => session,
            Err(_) => {
                // An event for a removed session must not re-grow the map.
                self.lanes.remove(&event.session_id);
                return Err(AgentHookApplyError::Unavailable(format!(
                    "session not found: {}",
                    event.session_id
                )));
            }
        };
        if event.provider != SessionAgentProvider::Codex {
            validate_agent_hook_session(&session, &event, false)?;
            let transcript_provider_switch = event.source.as_deref() == Some("transcript")
                && event_can_switch_provider(&event)
                && session.status != SessionStatus::Working
                && (session
                    .agent_provider
                    .is_some_and(|provider| provider != event.provider)
                    || session
                        .hook_provider
                        .is_some_and(|provider| provider != event.provider));
            if transcript_provider_switch {
                self.sessions
                    .prepare_agent_provider_switch(&event.session_id, event.provider)
                    .map_err(|err| AgentHookApplyError::Conflict(err.to_string()))?;
            }
            let status = apply_validated_agent_hook_event(
                &self.sessions,
                event,
                CodexStoreEffects::default(),
            )?;
            lane.codex.retire_current();
            return Ok(AgentHookApplyOutcome::Applied(status));
        }

        let Some(signal) = CodexSignal::from_event(&event)? else {
            if lane.codex.current.is_some() {
                return Ok(AgentHookApplyOutcome::Ignored {
                    status: session.status,
                    reason: "unclassified event after lifecycle attachment",
                });
            }
            validate_agent_hook_session(&session, &event, false)?;
            let status = apply_agent_hook_event(&self.sessions, event)
                .map_err(AgentHookApplyError::Conflict)?;
            return Ok(AgentHookApplyOutcome::Applied(status));
        };
        let allows_provisional_provider_claim =
            signal == CodexSignal::NativePrompt && lane.codex.allows_native_owner_claim(&event);
        validate_agent_hook_session(&session, &event, allows_provisional_provider_claim)?;
        let current_status = session.status;

        if event.ownership == AgentHookOwnership::Child && event.lifecycle_id.is_none() {
            return Ok(AgentHookApplyOutcome::Ignored {
                status: current_status,
                reason: "unscoped child agent event",
            });
        }

        let Some(lifecycle_id) = normalized_id(event.lifecycle_id.as_deref()) else {
            if lane.codex.current.is_some() {
                return Ok(AgentHookApplyOutcome::Ignored {
                    status: current_status,
                    reason: "missing lifecycle id after lifecycle attachment",
                });
            }
            let effects = unsequenced_codex_effects(signal, &event);
            let status = apply_validated_agent_hook_event(&self.sessions, event, effects)?;
            return Ok(AgentHookApplyOutcome::Applied(status));
        };

        let mut candidate = lane.codex.clone();
        let reduction = candidate.reduce(lifecycle_id, signal, &event);
        let effects = match reduction {
            CodexReduction::Apply(effects) => effects,
            CodexReduction::IgnoreAndCommit(reason) => {
                lane.codex = candidate;
                return Ok(AgentHookApplyOutcome::Ignored {
                    status: current_status,
                    reason,
                });
            }
            CodexReduction::Ignore(reason) => {
                return Ok(AgentHookApplyOutcome::Ignored {
                    status: current_status,
                    reason,
                });
            }
        };
        let status = apply_validated_agent_hook_event(&self.sessions, event, effects)?;
        lane.codex = candidate;
        Ok(AgentHookApplyOutcome::Applied(status))
    }
}

fn unsequenced_codex_effects(signal: CodexSignal, event: &AgentHookEvent) -> CodexStoreEffects {
    let provider_turn_id = normalized_id(event.provider_turn_id.as_deref()).map(str::to_string);
    match signal {
        CodexSignal::NativePrompt | CodexSignal::JsonlUser | CodexSignal::JsonlTask => {
            CodexStoreEffects {
                begin_turn: true,
                provider_turn_id,
                clear_permission_waiting: true,
                ..Default::default()
            }
        }
        CodexSignal::NativeToolStart | CodexSignal::JsonlTool => CodexStoreEffects {
            mark_tool_started: true,
            clear_permission_waiting: true,
            ..Default::default()
        },
        CodexSignal::NativePermission | CodexSignal::JsonlApproval => CodexStoreEffects {
            mark_permission_waiting: true,
            ..Default::default()
        },
        CodexSignal::NativeStop | CodexSignal::LegacyCompletion => CodexStoreEffects {
            clear_permission_waiting: true,
            ..Default::default()
        },
    }
}

#[derive(Default)]
struct HookLane {
    codex: CodexLane,
}

#[derive(Clone, Default)]
struct CodexLane {
    current: Option<CodexInvocation>,
    retired_lifecycle_ids: VecDeque<String>,
    retired_provider_sessions: VecDeque<ScopedCodexSession>,
    recent_child_turns: VecDeque<ScopedCodexTurn>,
    quarantine_idless_fallbacks: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct ScopedCodexSession {
    lifecycle_id: String,
    provider_session_id: String,
}

#[derive(Clone, PartialEq, Eq)]
struct ScopedCodexTurn {
    lifecycle_id: String,
    provider_session_id: Option<String>,
    provider_turn_id: String,
}

#[derive(Clone)]
struct CodexInvocation {
    lifecycle_id: String,
    provider_session_id: Option<String>,
    turn: Option<CodexTurn>,
    finished_turns: VecDeque<FinishedCodexTurn>,
}

#[derive(Clone)]
struct CodexTurn {
    provider_turn_id: Option<String>,
    phase: CodexTurnPhase,
    native_prompt_seen: bool,
    jsonl_user_seen: bool,
    jsonl_task_seen: bool,
    native_tool_ids: VecDeque<String>,
    unpaired_native_tool_id: Option<String>,
    pending_permission_tool_id: Option<String>,
    native_permission_receipts: VecDeque<PermissionReceipt>,
    fallback_permission_receipts: VecDeque<PermissionReceipt>,
}

#[derive(Clone)]
struct PermissionReceipt {
    provider_tool_id: Option<String>,
    resumed_tool_id: Option<String>,
    resumed: bool,
}

#[derive(Clone)]
struct FinishedCodexTurn {
    provider_turn_id: Option<String>,
    consume_jsonl_user: bool,
    consume_jsonl_task: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CodexTurnPhase {
    Working,
    AwaitingPermission,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CodexSignal {
    NativePrompt,
    NativeStop,
    NativePermission,
    NativeToolStart,
    JsonlUser,
    JsonlTask,
    JsonlTool,
    JsonlApproval,
    LegacyCompletion,
}

impl CodexSignal {
    fn from_event(event: &AgentHookEvent) -> Result<Option<Self>, AgentHookApplyError> {
        let Some(source) = event.source.as_deref() else {
            return Ok(None);
        };
        let signal = match source {
            "native_prompt" if event.event == AgentHookEventKind::Start => Self::NativePrompt,
            "native_stop" if event.event == AgentHookEventKind::NeedsInput => Self::NativeStop,
            "native_permission" if event.event == AgentHookEventKind::NeedsInput => {
                Self::NativePermission
            }
            "native_tool_start" if event.event == AgentHookEventKind::Start => {
                Self::NativeToolStart
            }
            "jsonl_user" if event.event == AgentHookEventKind::Start => Self::JsonlUser,
            "jsonl_task" if event.event == AgentHookEventKind::Start => Self::JsonlTask,
            "jsonl_tool" if event.event == AgentHookEventKind::Start => Self::JsonlTool,
            "jsonl_approval" if event.event == AgentHookEventKind::NeedsInput => {
                Self::JsonlApproval
            }
            "legacy_completion" if event.event == AgentHookEventKind::NeedsInput => {
                Self::LegacyCompletion
            }
            source
                if source.starts_with("native_")
                    || source.starts_with("jsonl_")
                    || source == "legacy_completion" =>
            {
                return Err(AgentHookApplyError::Conflict(format!(
                    "invalid Codex source/event combination: {source}/{:?}",
                    event.event
                )));
            }
            _ => return Ok(None),
        };
        Ok(Some(signal))
    }

    fn is_fallback(self) -> bool {
        matches!(
            self,
            Self::JsonlUser
                | Self::JsonlTask
                | Self::JsonlTool
                | Self::JsonlApproval
                | Self::LegacyCompletion
        )
    }

    fn is_turn_boundary(self) -> bool {
        matches!(self, Self::NativePrompt | Self::JsonlUser | Self::JsonlTask)
    }

    fn can_replace_lifecycle(self) -> bool {
        matches!(self, Self::NativePrompt | Self::JsonlUser | Self::JsonlTask)
    }
}

enum CodexReduction {
    Apply(CodexStoreEffects),
    Ignore(&'static str),
    IgnoreAndCommit(&'static str),
}

#[derive(Default)]
struct CodexStoreEffects {
    begin_turn: bool,
    provider_turn_id: Option<String>,
    mark_tool_started: bool,
    mark_permission_waiting: bool,
    clear_permission_waiting: bool,
    status_override: Option<SessionStatus>,
}

impl CodexLane {
    fn retire_current(&mut self) {
        let Some(current) = self.current.take() else {
            return;
        };
        let lifecycle_id = current.lifecycle_id;
        if let Some(provider_session_id) = current.provider_session_id {
            push_scoped_session_bounded(
                &mut self.retired_provider_sessions,
                &lifecycle_id,
                &provider_session_id,
                16,
            );
        }
        push_bounded(&mut self.retired_lifecycle_ids, lifecycle_id, 8);
        self.quarantine_idless_fallbacks = false;
    }

    fn allows_native_owner_claim(&self, event: &AgentHookEvent) -> bool {
        if event.ownership != AgentHookOwnership::Owner {
            return false;
        }
        let Some(lifecycle_id) = normalized_id(event.lifecycle_id.as_deref()) else {
            return false;
        };
        let Some(invocation) = self.current.as_ref() else {
            return false;
        };
        if invocation.lifecycle_id != lifecycle_id
            || provider_ids_conflict(
                invocation.provider_session_id.as_deref(),
                normalized_id(event.provider_session_id.as_deref()),
            )
        {
            return false;
        }
        invocation.turn.as_ref().is_some_and(|turn| {
            !turn.native_prompt_seen
                && !provider_ids_conflict(
                    turn.provider_turn_id.as_deref(),
                    normalized_id(event.provider_turn_id.as_deref()),
                )
        })
    }

    fn reduce(
        &mut self,
        lifecycle_id: &str,
        signal: CodexSignal,
        event: &AgentHookEvent,
    ) -> CodexReduction {
        let provider_session_id = normalized_id(event.provider_session_id.as_deref());
        let provider_turn_id = normalized_id(event.provider_turn_id.as_deref());
        if event.ownership == AgentHookOwnership::Child {
            if let Some(provider_turn_id) = provider_turn_id {
                push_scoped_turn_bounded(
                    &mut self.recent_child_turns,
                    lifecycle_id,
                    provider_session_id,
                    provider_turn_id,
                    32,
                );
            }
            return CodexReduction::IgnoreAndCommit("child agent event");
        }

        if signal.is_fallback()
            && provider_turn_id.is_some_and(|provider_turn_id| {
                self.recent_child_turns.iter().any(|child| {
                    child.lifecycle_id == lifecycle_id
                        && child.provider_turn_id == provider_turn_id
                        && !provider_ids_conflict(
                            child.provider_session_id.as_deref(),
                            provider_session_id,
                        )
                })
            })
        {
            return CodexReduction::Ignore("fallback belongs to a child turn");
        }

        if self
            .retired_lifecycle_ids
            .iter()
            .any(|retired| retired == lifecycle_id)
        {
            return CodexReduction::Ignore("retired lifecycle event");
        }

        let replace = self
            .current
            .as_ref()
            .is_some_and(|current| current.lifecycle_id != lifecycle_id);
        if replace {
            if !signal.can_replace_lifecycle() {
                return CodexReduction::Ignore("event belongs to an unknown lifecycle");
            }
            if let Some(current) = self.current.take() {
                push_bounded(&mut self.retired_lifecycle_ids, current.lifecycle_id, 8);
            }
            self.quarantine_idless_fallbacks = false;
        }

        if provider_session_id.is_some_and(|provider_session_id| {
            self.retired_provider_sessions.iter().any(|retired| {
                retired.lifecycle_id == lifecycle_id
                    && retired.provider_session_id == provider_session_id
            })
        }) {
            return CodexReduction::Ignore("retired provider session event");
        }

        let rotates_provider_session = self.current.as_ref().is_some_and(|current| {
            provider_ids_conflict(current.provider_session_id.as_deref(), provider_session_id)
        });
        if rotates_provider_session {
            let preserves_fallback_turn = signal == CodexSignal::LegacyCompletion
                && self.current.as_ref().is_some_and(|current| {
                    current.matches_fallback_owner_completion(provider_turn_id)
                });
            if signal != CodexSignal::NativePrompt && !preserves_fallback_turn {
                return CodexReduction::Ignore("provider session id mismatch");
            }
            if let Some(mut current) = self.current.take() {
                if let Some(retired_provider_session_id) = current.provider_session_id.take() {
                    push_scoped_session_bounded(
                        &mut self.retired_provider_sessions,
                        lifecycle_id,
                        &retired_provider_session_id,
                        16,
                    );
                }
                if preserves_fallback_turn {
                    self.current = Some(CodexInvocation {
                        lifecycle_id: current.lifecycle_id,
                        provider_session_id: provider_session_id.map(str::to_string),
                        turn: current.turn.take(),
                        finished_turns: VecDeque::new(),
                    });
                }
            }
            if signal == CodexSignal::NativePrompt {
                // Recorder boundaries carry no provider/turn identity in current
                // Codex builds. After `/new`, an idless line cannot be attributed
                // to the retired or current provider session, so fail closed and
                // let native owner hooks drive the remainder of this lifecycle.
                self.quarantine_idless_fallbacks = true;
            }
        }

        if self.quarantine_idless_fallbacks
            && matches!(signal, CodexSignal::JsonlUser | CodexSignal::JsonlTask)
            && provider_session_id.is_none()
        {
            return CodexReduction::Ignore(
                "fallback without provider session after provider rotation",
            );
        }

        if self.current.is_none()
            && signal == CodexSignal::NativeStop
            && provider_session_id.is_none()
        {
            return CodexReduction::Ignore(
                "restart completion is missing provider session ownership",
            );
        }
        let invocation = self.current.get_or_insert_with(|| CodexInvocation {
            lifecycle_id: lifecycle_id.to_string(),
            provider_session_id: provider_session_id.map(str::to_string),
            turn: None,
            finished_turns: VecDeque::new(),
        });
        if invocation.provider_session_id.is_none() {
            invocation.provider_session_id = provider_session_id.map(str::to_string);
        }
        invocation.reduce(
            signal,
            provider_turn_id,
            normalized_id(event.provider_tool_id.as_deref()),
        )
    }
}

impl CodexInvocation {
    fn reduce(
        &mut self,
        signal: CodexSignal,
        provider_turn_id: Option<&str>,
        provider_tool_id: Option<&str>,
    ) -> CodexReduction {
        if matches!(signal, CodexSignal::JsonlUser | CodexSignal::JsonlTask)
            && self.consume_finished_counterpart(provider_turn_id, signal == CodexSignal::JsonlUser)
        {
            return CodexReduction::IgnoreAndCommit("late JSONL counterpart for a finished turn");
        }

        if let Some(provider_turn_id) = provider_turn_id {
            if self.can_reopen_latest_finished(signal, provider_turn_id) {
                self.reopen_latest_finished(provider_turn_id);
            } else if self.is_finished(provider_turn_id) {
                return CodexReduction::Ignore("event belongs to a finished turn");
            }
        }

        let current_turn_id = self
            .turn
            .as_ref()
            .and_then(|turn| turn.provider_turn_id.as_deref());
        if signal.is_fallback()
            && !signal.is_turn_boundary()
            && current_turn_id.is_some()
            && provider_turn_id.is_none()
        {
            return CodexReduction::Ignore("idless fallback cannot override a known turn");
        }

        match signal {
            CodexSignal::NativePrompt => self.start_or_merge_native_prompt(provider_turn_id),
            CodexSignal::NativeStop => self.finish_turn(provider_turn_id, true),
            CodexSignal::LegacyCompletion => self.finish_turn(provider_turn_id, false),
            CodexSignal::NativePermission => {
                self.await_permission(provider_turn_id, provider_tool_id, false)
            }
            CodexSignal::JsonlApproval => {
                self.await_permission(provider_turn_id, provider_tool_id, true)
            }
            CodexSignal::NativeToolStart => {
                self.resume_from_tool(provider_turn_id, false, provider_tool_id)
            }
            CodexSignal::JsonlTool => {
                if self.has_native_tool_id(provider_turn_id, provider_tool_id)
                    && !self.duplicate_native_tool_resumes_permission(
                        provider_turn_id,
                        provider_tool_id,
                    )
                {
                    CodexReduction::Ignore("fallback tool duplicates a native tool")
                } else {
                    self.resume_from_tool(provider_turn_id, true, provider_tool_id)
                }
            }
            CodexSignal::JsonlUser => self.observe_jsonl_start(provider_turn_id, true),
            CodexSignal::JsonlTask => self.observe_jsonl_start(provider_turn_id, false),
        }
    }

    fn start_or_merge_native_prompt(&mut self, provider_turn_id: Option<&str>) -> CodexReduction {
        if self.turn.as_ref().is_some_and(|turn| {
            provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
        }) {
            let previous = self.turn.take().expect("conflicting turn checked");
            self.record_finished_turn(previous);
            self.turn = Some(new_codex_turn(provider_turn_id, true));
            return begin_turn_effects(provider_turn_id);
        }

        if let Some(turn) = self.turn.as_mut() {
            if turn.native_prompt_seen {
                return CodexReduction::Ignore("duplicate native prompt");
            }
            attach_turn_id(turn, provider_turn_id);
            turn.native_prompt_seen = true;
            if turn.phase == CodexTurnPhase::AwaitingPermission {
                return CodexReduction::IgnoreAndCommit("late prompt for permission-waiting turn");
            }
            return CodexReduction::Apply(CodexStoreEffects {
                clear_permission_waiting: true,
                ..Default::default()
            });
        }

        self.turn = Some(new_codex_turn(provider_turn_id, true));
        begin_turn_effects(provider_turn_id)
    }

    fn finish_turn(
        &mut self,
        provider_turn_id: Option<&str>,
        trusted_native: bool,
    ) -> CodexReduction {
        let bootstrapped = self.turn.is_none();
        if self.turn.is_none() {
            if !trusted_native || provider_turn_id.is_none() {
                return CodexReduction::Ignore("completion without an active turn");
            }
            self.turn = Some(new_codex_turn(provider_turn_id, false));
        }
        if self.turn.as_ref().is_some_and(|turn| {
            provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
                || (turn.provider_turn_id.is_some() && provider_turn_id.is_none())
        }) {
            return CodexReduction::Ignore("completion belongs to another turn");
        }

        let mut turn = self.turn.take().expect("active turn checked");
        attach_turn_id(&mut turn, provider_turn_id);
        self.record_finished_turn(turn);
        CodexReduction::Apply(CodexStoreEffects {
            begin_turn: bootstrapped,
            provider_turn_id: bootstrapped
                .then(|| provider_turn_id.map(str::to_string))
                .flatten(),
            clear_permission_waiting: true,
            ..Default::default()
        })
    }

    fn await_permission(
        &mut self,
        provider_turn_id: Option<&str>,
        provider_tool_id: Option<&str>,
        fallback: bool,
    ) -> CodexReduction {
        if self.turn.as_ref().is_some_and(|turn| {
            provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
                || (fallback && turn.provider_turn_id.is_some() && provider_turn_id.is_none())
        }) {
            return CodexReduction::Ignore("permission belongs to another turn");
        }
        let begin_turn = self.turn.is_none();
        if begin_turn {
            if fallback {
                return CodexReduction::Ignore("fallback permission without an active turn");
            }
            self.turn = Some(new_codex_turn(provider_turn_id, false));
        }
        let turn = self.turn.as_mut().expect("turn established");
        attach_turn_id(turn, provider_turn_id);

        let inferred_tool_id = if !fallback && provider_tool_id.is_none() {
            turn.unpaired_native_tool_id.take()
        } else {
            if !fallback
                && provider_tool_id.is_some_and(|provider_tool_id| {
                    turn.unpaired_native_tool_id.as_deref() == Some(provider_tool_id)
                })
            {
                turn.unpaired_native_tool_id = None;
            }
            None
        };
        let provider_tool_id = provider_tool_id.or(inferred_tool_id.as_deref());

        if fallback {
            if let Some(receipt) = take_matching_permission_receipt(
                &mut turn.native_permission_receipts,
                provider_tool_id,
            ) {
                if !receipt.resumed {
                    let matched_tool_id = provider_tool_id
                        .map(str::to_string)
                        .or(receipt.provider_tool_id)
                        .or(receipt.resumed_tool_id);
                    turn.pending_permission_tool_id = matched_tool_id.clone();
                    push_permission_receipt(
                        &mut turn.fallback_permission_receipts,
                        matched_tool_id.as_deref(),
                    );
                }
                return CodexReduction::IgnoreAndCommit(
                    "fallback approval duplicates a native permission",
                );
            }
            push_permission_receipt(&mut turn.fallback_permission_receipts, provider_tool_id);
        } else if let Some(receipt) = take_matching_permission_receipt(
            &mut turn.fallback_permission_receipts,
            provider_tool_id,
        ) {
            if receipt.resumed && turn.phase == CodexTurnPhase::Working {
                return CodexReduction::Apply(CodexStoreEffects {
                    clear_permission_waiting: true,
                    status_override: Some(SessionStatus::Working),
                    ..Default::default()
                });
            }
            let matched_tool_id = provider_tool_id
                .map(str::to_string)
                .or(receipt.provider_tool_id)
                .or(receipt.resumed_tool_id);
            turn.pending_permission_tool_id = matched_tool_id.clone();
            push_permission_receipt(
                &mut turn.native_permission_receipts,
                matched_tool_id.as_deref(),
            );
        } else {
            push_permission_receipt(&mut turn.native_permission_receipts, provider_tool_id);
        }

        turn.pending_permission_tool_id = provider_tool_id
            .map(str::to_string)
            .or_else(|| turn.pending_permission_tool_id.take());
        turn.phase = CodexTurnPhase::AwaitingPermission;
        CodexReduction::Apply(CodexStoreEffects {
            begin_turn,
            provider_turn_id: begin_turn
                .then(|| provider_turn_id.map(str::to_string))
                .flatten(),
            mark_permission_waiting: true,
            ..Default::default()
        })
    }

    fn resume_from_tool(
        &mut self,
        provider_turn_id: Option<&str>,
        fallback: bool,
        native_tool_id: Option<&str>,
    ) -> CodexReduction {
        if self.turn.as_ref().is_some_and(|turn| {
            provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
                || (fallback && turn.provider_turn_id.is_some() && provider_turn_id.is_none())
        }) {
            return CodexReduction::Ignore("tool event belongs to another turn");
        }
        let begin_turn = self.turn.is_none();
        if begin_turn {
            if fallback {
                return CodexReduction::Ignore("fallback tool event without an active turn");
            }
            self.turn = Some(new_codex_turn(provider_turn_id, false));
        }
        let turn = self.turn.as_mut().expect("turn established");
        attach_turn_id(turn, provider_turn_id);
        turn.phase = CodexTurnPhase::Working;
        turn.pending_permission_tool_id = None;
        mark_permission_receipts_resumed(&mut turn.native_permission_receipts, native_tool_id);
        mark_permission_receipts_resumed(&mut turn.fallback_permission_receipts, native_tool_id);
        if !fallback {
            turn.unpaired_native_tool_id = native_tool_id.map(str::to_string);
            if let Some(tool_id) = native_tool_id {
                push_bounded(&mut turn.native_tool_ids, tool_id.to_string(), 16);
            }
        } else if native_tool_id.is_some_and(|native_tool_id| {
            turn.unpaired_native_tool_id.as_deref() == Some(native_tool_id)
        }) {
            turn.unpaired_native_tool_id = None;
        }
        CodexReduction::Apply(CodexStoreEffects {
            begin_turn,
            provider_turn_id: begin_turn
                .then(|| provider_turn_id.map(str::to_string))
                .flatten(),
            mark_tool_started: true,
            clear_permission_waiting: true,
            ..Default::default()
        })
    }

    fn observe_jsonl_start(
        &mut self,
        provider_turn_id: Option<&str>,
        user_signal: bool,
    ) -> CodexReduction {
        if self.turn.is_none() {
            if !user_signal && !self.finished_turns.is_empty() {
                return CodexReduction::Ignore(
                    "JSONL task cannot replace a finished owner without a user boundary",
                );
            }
            let mut turn = new_codex_turn(provider_turn_id, false);
            if user_signal {
                turn.jsonl_user_seen = true;
            } else {
                turn.jsonl_task_seen = true;
            }
            self.turn = Some(turn);
            return begin_turn_effects(provider_turn_id);
        }

        // The recorder writes UserTurn before Codex invokes UserPromptSubmit.
        // Remembering both directions on the active turn avoids leaving an
        // unused native receipt that would swallow the next fallback-only
        // turn when the next native callback is missed.
        let repeated_idless_boundary = user_signal
            && provider_turn_id.is_none()
            && self.turn.as_ref().is_some_and(|turn| turn.jsonl_user_seen);
        if repeated_idless_boundary {
            let previous = self.turn.take().expect("active turn checked");
            self.record_finished_turn(previous);
            let mut turn = new_codex_turn(None, false);
            turn.jsonl_user_seen = true;
            self.turn = Some(turn);
            return begin_turn_effects(None);
        }

        if self.turn.as_ref().is_some_and(|turn| {
            provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
        }) {
            if !user_signal {
                return CodexReduction::Ignore("JSONL task cannot replace an active owner turn");
            }
            let previous = self.turn.take().expect("conflicting turn checked");
            self.record_finished_turn(previous);
            let mut turn = new_codex_turn(provider_turn_id, false);
            turn.jsonl_user_seen = true;
            self.turn = Some(turn);
            return begin_turn_effects(provider_turn_id);
        }

        let turn = self.turn.as_mut().expect("turn exists");
        attach_turn_id(turn, provider_turn_id);
        if user_signal {
            turn.jsonl_user_seen = true;
        } else {
            turn.jsonl_task_seen = true;
        }
        if turn.phase == CodexTurnPhase::AwaitingPermission {
            return CodexReduction::IgnoreAndCommit("lagging JSONL start during permission wait");
        }
        CodexReduction::Apply(CodexStoreEffects::default())
    }

    fn consume_finished_counterpart(
        &mut self,
        provider_turn_id: Option<&str>,
        user_signal: bool,
    ) -> bool {
        let index = match provider_turn_id {
            Some(provider_turn_id) => self.finished_turns.iter().position(|finished| {
                finished.provider_turn_id.as_deref() == Some(provider_turn_id)
                    && if user_signal {
                        finished.consume_jsonl_user
                    } else {
                        finished.consume_jsonl_task
                    }
            }),
            None => self.finished_turns.iter().position(|finished| {
                if user_signal {
                    finished.consume_jsonl_user
                } else {
                    finished.consume_jsonl_task
                }
            }),
        };
        let Some(index) = index else {
            return false;
        };
        let finished = self
            .finished_turns
            .get_mut(index)
            .expect("finished turn index came from the same queue");
        if user_signal {
            finished.consume_jsonl_user = false;
        } else {
            finished.consume_jsonl_task = false;
        }
        true
    }

    fn can_reopen_latest_finished(&self, signal: CodexSignal, provider_turn_id: &str) -> bool {
        self.turn.is_none()
            && matches!(
                signal,
                CodexSignal::NativePermission | CodexSignal::NativeToolStart
            )
            && self
                .finished_turns
                .back()
                .and_then(|finished| finished.provider_turn_id.as_deref())
                == Some(provider_turn_id)
    }

    fn reopen_latest_finished(&mut self, provider_turn_id: &str) {
        let finished = self
            .finished_turns
            .pop_back()
            .expect("latest finished turn checked");
        self.finished_turns
            .retain(|candidate| candidate.provider_turn_id.as_deref() != Some(provider_turn_id));
        let mut turn = new_codex_turn(Some(provider_turn_id), true);
        turn.jsonl_user_seen = !finished.consume_jsonl_user;
        turn.jsonl_task_seen = !finished.consume_jsonl_task;
        self.turn = Some(turn);
    }

    fn record_finished_turn(&mut self, turn: CodexTurn) {
        if self.finished_turns.len() == 16 {
            self.finished_turns.pop_front();
        }
        self.finished_turns.push_back(FinishedCodexTurn {
            provider_turn_id: turn.provider_turn_id,
            consume_jsonl_user: !turn.jsonl_user_seen,
            consume_jsonl_task: !turn.jsonl_task_seen,
        });
    }

    fn is_finished(&self, provider_turn_id: &str) -> bool {
        self.finished_turns
            .iter()
            .any(|finished| finished.provider_turn_id.as_deref() == Some(provider_turn_id))
    }

    fn has_native_tool_id(
        &self,
        provider_turn_id: Option<&str>,
        provider_tool_id: Option<&str>,
    ) -> bool {
        let Some(provider_tool_id) = provider_tool_id else {
            return false;
        };
        self.turn.as_ref().is_some_and(|turn| {
            !provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
                && turn
                    .native_tool_ids
                    .iter()
                    .any(|native| native == provider_tool_id)
        })
    }

    fn matches_fallback_owner_completion(&self, provider_turn_id: Option<&str>) -> bool {
        let Some(provider_turn_id) = provider_turn_id else {
            return false;
        };
        self.turn.as_ref().is_some_and(|turn| {
            !turn.native_prompt_seen
                && turn.jsonl_user_seen
                && turn.provider_turn_id.as_deref() == Some(provider_turn_id)
        })
    }

    fn duplicate_native_tool_resumes_permission(
        &self,
        provider_turn_id: Option<&str>,
        provider_tool_id: Option<&str>,
    ) -> bool {
        let Some(provider_tool_id) = provider_tool_id else {
            return false;
        };
        self.turn.as_ref().is_some_and(|turn| {
            turn.phase == CodexTurnPhase::AwaitingPermission
                && !provider_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
                && turn
                    .pending_permission_tool_id
                    .as_deref()
                    .is_none_or(|pending_tool_id| pending_tool_id == provider_tool_id)
        })
    }
}

fn take_matching_permission_receipt(
    receipts: &mut VecDeque<PermissionReceipt>,
    provider_tool_id: Option<&str>,
) -> Option<PermissionReceipt> {
    let index = receipts.iter().position(|receipt| match provider_tool_id {
        Some(provider_tool_id) => {
            receipt.provider_tool_id.as_deref() == Some(provider_tool_id)
                || receipt.resumed_tool_id.as_deref() == Some(provider_tool_id)
        }
        // PermissionRequest currently has no tool_use_id. Before a tool
        // resumes, the pending opposite-source receipt is the best available
        // correlation even when the JSONL side carried an id. A resumed
        // receipt never matches an idless future request.
        None => !receipt.resumed,
    })?;
    receipts.remove(index)
}

fn push_permission_receipt(
    receipts: &mut VecDeque<PermissionReceipt>,
    provider_tool_id: Option<&str>,
) {
    if receipts
        .iter()
        .any(|receipt| !receipt.resumed && receipt.provider_tool_id.as_deref() == provider_tool_id)
    {
        return;
    }
    if receipts.len() == 16 {
        receipts.pop_front();
    }
    receipts.push_back(PermissionReceipt {
        provider_tool_id: provider_tool_id.map(str::to_string),
        resumed_tool_id: None,
        resumed: false,
    });
}

fn mark_permission_receipts_resumed(
    receipts: &mut VecDeque<PermissionReceipt>,
    provider_tool_id: Option<&str>,
) {
    let Some(provider_tool_id) = provider_tool_id else {
        receipts.clear();
        return;
    };
    // Correlate only an anonymous receipt or one already carrying the same
    // tool id. A known different id (notably request_user_input) belongs to a
    // prior request and must not claim the next tool's fallback approval.
    receipts.retain(|receipt| {
        receipt
            .provider_tool_id
            .as_deref()
            .is_none_or(|receipt_id| receipt_id == provider_tool_id)
    });
    for receipt in receipts.iter_mut() {
        receipt.resumed = true;
        receipt.resumed_tool_id = Some(provider_tool_id.to_string());
    }
}

fn begin_turn_effects(provider_turn_id: Option<&str>) -> CodexReduction {
    CodexReduction::Apply(CodexStoreEffects {
        begin_turn: true,
        provider_turn_id: provider_turn_id.map(str::to_string),
        clear_permission_waiting: true,
        ..Default::default()
    })
}

fn new_codex_turn(provider_turn_id: Option<&str>, native_prompt_seen: bool) -> CodexTurn {
    CodexTurn {
        provider_turn_id: provider_turn_id.map(str::to_string),
        phase: CodexTurnPhase::Working,
        native_prompt_seen,
        jsonl_user_seen: false,
        jsonl_task_seen: false,
        native_tool_ids: VecDeque::new(),
        unpaired_native_tool_id: None,
        pending_permission_tool_id: None,
        native_permission_receipts: VecDeque::new(),
        fallback_permission_receipts: VecDeque::new(),
    }
}

fn attach_turn_id(turn: &mut CodexTurn, provider_turn_id: Option<&str>) {
    if turn.provider_turn_id.is_none() {
        turn.provider_turn_id = provider_turn_id.map(str::to_string);
    }
}

fn normalized_id(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn provider_ids_conflict(current: Option<&str>, incoming: Option<&str>) -> bool {
    matches!((current, incoming), (Some(current), Some(incoming)) if current != incoming)
}

fn push_bounded(values: &mut VecDeque<String>, value: String, capacity: usize) {
    if values.iter().any(|existing| existing == &value) {
        return;
    }
    if values.len() == capacity {
        values.pop_front();
    }
    values.push_back(value);
}

fn push_scoped_turn_bounded(
    values: &mut VecDeque<ScopedCodexTurn>,
    lifecycle_id: &str,
    provider_session_id: Option<&str>,
    provider_turn_id: &str,
    capacity: usize,
) {
    let value = ScopedCodexTurn {
        lifecycle_id: lifecycle_id.to_string(),
        provider_session_id: provider_session_id.map(str::to_string),
        provider_turn_id: provider_turn_id.to_string(),
    };
    if values.iter().any(|existing| existing == &value) {
        return;
    }
    if values.len() == capacity {
        values.pop_front();
    }
    values.push_back(value);
}

fn push_scoped_session_bounded(
    values: &mut VecDeque<ScopedCodexSession>,
    lifecycle_id: &str,
    provider_session_id: &str,
    capacity: usize,
) {
    let value = ScopedCodexSession {
        lifecycle_id: lifecycle_id.to_string(),
        provider_session_id: provider_session_id.to_string(),
    };
    if values.iter().any(|existing| existing == &value) {
        return;
    }
    if values.len() == capacity {
        values.pop_front();
    }
    values.push_back(value);
}

pub fn apply_agent_hook_event(
    sessions: &SessionStore,
    event: AgentHookEvent,
) -> Result<SessionStatus, String> {
    let session = sessions
        .get(&event.session_id)
        .map_err(|_| format!("session not found: {}", event.session_id))?;
    // A terminal can carry stale live-provider metadata from a resting agent.
    // Accept a provider switch only from a resting session; while the owner is
    // Working, mismatched provider events are nested agent activity.
    if let Some(provider) = session.agent_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session = event.event == AgentHookEventKind::Start
                && session.status != SessionStatus::Working;
            if !provider_switch_from_resting_session {
                return Err(format!(
                    "provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                ));
            }
        }
    }
    if let Some(provider) = session.hook_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session = event.event == AgentHookEventKind::Start
                && session.status != SessionStatus::Working;
            if !provider_switch_from_resting_session {
                return Err(format!(
                    "hook provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                ));
            }
        }
    }

    // The TUI recorder is an asynchronous compatibility preview and can lag
    // behind native UserPromptSubmit or Stop. PTY writes and native hooks own
    // the real transition, so a delayed preview must never overwrite them.
    if event.provider == SessionAgentProvider::Codex && event.source.as_deref() == Some("preview") {
        return Ok(session.status);
    }

    let is_codex = event.provider == SessionAgentProvider::Codex;
    let is_codex_native_source =
        is_codex && matches!(event.source.as_deref(), Some("turn" | "tool" | "hook"));
    let scoped_codex_turn_id = is_codex_native_source
        .then_some(event.provider_turn_id.as_deref())
        .flatten()
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty());
    let is_codex_user_boundary = is_codex
        && event.event == AgentHookEventKind::Start
        && event.source.as_deref() == Some("turn");

    // UserPromptSubmit is the authoritative owner boundary. The asynchronous
    // TUI preview only makes Working visible sooner: allowing a delayed
    // preview to clear this id could erase a native hook that already arrived.
    if is_codex_user_boundary {
        sessions.begin_hook_turn(&event.session_id, scoped_codex_turn_id);
    } else if let Some(turn_id) = scoped_codex_turn_id {
        let current_turn_id = sessions.hook_turn_id(&event.session_id);
        let has_turn_boundary = sessions.has_hook_turn_boundary(&event.session_id);
        match current_turn_id.as_deref() {
            Some(current_turn_id) if current_turn_id != turn_id => {
                return Err(format!(
                    "stale Codex turn event for {}: current {}, got {}",
                    event.session_id, current_turn_id, turn_id
                ));
            }
            None if !has_turn_boundary
                || (event.event == AgentHookEventKind::Start
                    && event.source.as_deref() == Some("tool")) =>
            {
                // Runtime turn ownership is intentionally not persisted. The
                // first trusted scoped event after an app restart reattaches
                // the still-running turn; a PreToolUse may arrive before Stop.
                // A tool start may also fill a pending id-less user boundary.
                sessions.begin_hook_turn(&event.session_id, Some(turn_id));
            }
            _ => {}
        }
    }

    if is_codex
        && event.event == AgentHookEventKind::NeedsInput
        && event.source.as_deref() == Some("legacy")
        && sessions.has_hook_turn_boundary(&event.session_id)
    {
        return Err(format!(
            "legacy Codex completion cannot override a native turn for {}",
            event.session_id
        ));
    }

    if is_codex_native_source
        && event.event == AgentHookEventKind::NeedsInput
        && scoped_codex_turn_id.is_none()
        && sessions.has_hook_turn_boundary(&event.session_id)
    {
        return Err(format!(
            "unscoped Codex completion cannot override a native turn for {}",
            event.session_id
        ));
    }

    let scoped_codex_completion = (is_codex_native_source
        && event.event == AgentHookEventKind::NeedsInput)
        .then_some(scoped_codex_turn_id)
        .flatten();
    if let Some(turn_id) = scoped_codex_completion {
        let current_turn_id = sessions.hook_turn_id(&event.session_id);
        if current_turn_id.as_deref() != Some(turn_id) {
            return Err(format!(
                "stale Codex turn completion for {}: current {:?}, got {}",
                event.session_id, current_turn_id, turn_id
            ));
        }
    }

    // Mark native hook channels live so the transcript-tail status poll
    // defers turn-boundary classification to them instead of clobbering a
    // just-set resting status (Ready/WaitingForInput) back to Working on its
    // next tick. Transcript-derived wrapper observations are only a low-latency
    // preview of the same data the poll reads. Treating those as an
    // authoritative hook would make a missed line, owner rotation, or watcher
    // restart permanently hide the fresher transcript classification.
    // See `poll_defers_to_hook` in `commands`.
    let is_authoritative_hook = event.source.as_deref() != Some("transcript");
    let hook_revision =
        is_authoritative_hook.then(|| sessions.mark_hook_active(&event.session_id, event.provider));

    // The Codex JSONL watcher tags task and exec starts separately. This
    // runtime-only turn evidence lets the process poll distinguish a real
    // background command from helpers that live for the whole Codex session.
    // Generic native hook events intentionally do not reset this marker: they
    // arrive through a separate channel and can race the ordered JSONL tail.
    if event.provider == SessionAgentProvider::Codex
        && event.event == AgentHookEventKind::Start
        && event.source.as_deref() == Some("tool")
    {
        sessions.mark_hook_tool_started_at(&event.session_id, SystemTime::now());
    }

    let status = event.event.session_status();
    if let (Some(turn_id), Some(revision)) = (scoped_codex_completion, hook_revision) {
        if sessions.hook_turn_id(&event.session_id).as_deref() != Some(turn_id) {
            return Err(format!(
                "stale Codex turn completion for {}: owner changed before apply",
                event.session_id
            ));
        }
        let applied = sessions
            .refresh_status_if_hook_revision(&event.session_id, session.status, revision, status)
            .map_err(|err| err.to_string())?;
        if !applied {
            return Err(format!(
                "stale Codex turn completion for {}: superseded before apply",
                event.session_id
            ));
        }
    } else {
        sessions
            .refresh_status(&event.session_id, status)
            .map_err(|err| err.to_string())?;
    }
    Ok(status)
}

fn validate_agent_hook_session(
    session: &acorn_session::Session,
    event: &AgentHookEvent,
    allow_working_provider_switch: bool,
) -> Result<(), AgentHookApplyError> {
    if let Some(provider) = session.agent_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session = event_can_switch_provider(event)
                && (session.status != SessionStatus::Working || allow_working_provider_switch);
            if !provider_switch_from_resting_session {
                return Err(AgentHookApplyError::Conflict(format!(
                    "provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                )));
            }
        }
    }
    if let Some(provider) = session.hook_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session = event_can_switch_provider(event)
                && (session.status != SessionStatus::Working || allow_working_provider_switch);
            if !provider_switch_from_resting_session {
                return Err(AgentHookApplyError::Conflict(format!(
                    "hook provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                )));
            }
        }
    }

    Ok(())
}

fn event_can_switch_provider(event: &AgentHookEvent) -> bool {
    if event.event != AgentHookEventKind::Start {
        return false;
    }
    if event.provider != SessionAgentProvider::Codex {
        return true;
    }
    matches!(
        event.source.as_deref(),
        Some("turn" | "native_prompt" | "jsonl_user" | "jsonl_task")
    )
}

fn apply_validated_agent_hook_event(
    sessions: &SessionStore,
    event: AgentHookEvent,
    effects: CodexStoreEffects,
) -> Result<SessionStatus, AgentHookApplyError> {
    let is_codex_fallback = event.provider == SessionAgentProvider::Codex
        && matches!(
            event.source.as_deref(),
            Some(
                "jsonl_user" | "jsonl_task" | "jsonl_tool" | "jsonl_approval" | "legacy_completion"
            )
        );
    let is_transcript_observation = event.source.as_deref() == Some("transcript");
    if !is_codex_fallback && !is_transcript_observation {
        // Advance the hook generation before touching turn evidence or status.
        // Pollers use this revision to reject a write based on an older
        // snapshot while a native hook event is being applied.
        sessions.mark_hook_active(&event.session_id, event.provider);
    }

    if event.provider == SessionAgentProvider::Codex {
        if effects.begin_turn {
            sessions.begin_hook_turn(&event.session_id, effects.provider_turn_id.as_deref());
        }
        if effects.clear_permission_waiting {
            sessions.clear_codex_permission_waiting(&event.session_id);
        }
        if effects.mark_permission_waiting {
            sessions.mark_codex_permission_waiting_at(&event.session_id, SystemTime::now());
        }
        if effects.mark_tool_started {
            sessions.mark_hook_tool_started_at(&event.session_id, SystemTime::now());
        }
    }

    let status = effects
        .status_override
        .unwrap_or_else(|| event.event.session_status());
    sessions
        .refresh_status(&event.session_id, status)
        .map_err(|err| AgentHookApplyError::Conflict(err.to_string()))?;
    Ok(status)
}

pub struct AgentHookServer {
    hook_url: String,
    token: String,
    running: Arc<AtomicBool>,
    listener_thread: Option<std::thread::JoinHandle<()>>,
}

impl AgentHookServer {
    #[cfg(test)]
    pub fn start() -> io::Result<Self> {
        Self::start_with_handler(|_| {})
    }

    #[cfg(test)]
    pub fn start_with_handler<F>(handler: F) -> io::Result<Self>
    where
        F: Fn(AgentHookEvent) + Send + Sync + 'static,
    {
        Self::start_with_outcome_handler(move |event| {
            handler(event);
            AgentHookHandlerOutcome::Applied
        })
    }

    pub fn start_with_outcome_handler<F>(handler: F) -> io::Result<Self>
    where
        F: Fn(AgentHookEvent) -> AgentHookHandlerOutcome + Send + Sync + 'static,
    {
        Self::start_with_token_and_handler(
            uuid::Uuid::new_v4().simple().to_string(),
            Arc::new(handler),
        )
    }

    pub fn hook_url(&self) -> &str {
        &self.hook_url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn start_with_token_and_handler(token: String, handler: HookEventHandler) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let hook_url = format!("http://{addr}{HOOK_PATH}");

        // Connections are parsed concurrently, but the application callback
        // applies state, persists the complete session list, and emits a UI
        // notification as one logical pipeline. Keep those side effects from
        // overlapping and writing snapshots out of order.
        let pipeline_lock = Arc::new(Mutex::new(()));
        let handler: HookEventHandler = Arc::new(move |event| {
            let _pipeline_guard = pipeline_lock.lock();
            handler(event)
        });

        let running = Arc::new(AtomicBool::new(true));
        let running_for_thread = running.clone();
        let token_for_thread = token.clone();
        let listener_thread = std::thread::Builder::new()
            .name("acorn-agent-hooks".to_string())
            .spawn(move || run_listener(listener, token_for_thread, handler, running_for_thread))?;

        Ok(Self {
            hook_url,
            token,
            running,
            listener_thread: Some(listener_thread),
        })
    }
}

impl Drop for AgentHookServer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(listener_thread) = self.listener_thread.take() {
            if listener_thread.join().is_err() {
                tracing::warn!("agent hook listener thread panicked during shutdown");
            }
        }
    }
}

fn run_listener(
    listener: TcpListener,
    token: String,
    handler: HookEventHandler,
    running: Arc<AtomicBool>,
) {
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                dispatch_connection(
                    stream,
                    token.clone(),
                    handler.clone(),
                    |stream, token, handler| {
                        std::thread::Builder::new()
                            .name("acorn-agent-hook-conn".to_string())
                            .spawn(move || {
                                if let Err(err) = handle_connection(stream, &token, &handler) {
                                    tracing::warn!(error = %err, "agent hook connection failed");
                                }
                            })
                            .map(|_| ())
                    },
                );
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(err) => {
                tracing::warn!(error = %err, "agent hook accept failed");
                std::thread::sleep(ACCEPT_POLL_INTERVAL);
            }
        }
    }
}

fn dispatch_connection<F>(
    stream: TcpStream,
    token: String,
    handler: HookEventHandler,
    spawn_worker: F,
) where
    F: FnOnce(TcpStream, String, HookEventHandler) -> io::Result<()>,
{
    let fallback_stream = stream.try_clone();
    if let Err(spawn_error) = spawn_worker(stream, token.clone(), handler.clone()) {
        tracing::warn!(
            error = %spawn_error,
            "agent hook worker thread failed to start; handling request inline"
        );
        match fallback_stream {
            Ok(stream) => {
                if let Err(err) = handle_connection(stream, &token, &handler) {
                    tracing::warn!(error = %err, "inline agent hook connection failed");
                }
            }
            Err(clone_error) => {
                tracing::warn!(
                    error = %clone_error,
                    "agent hook connection could not be retained for inline fallback"
                );
            }
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    handler: &HookEventHandler,
) -> io::Result<()> {
    // Accepted sockets can inherit the listener's nonblocking mode. Restore
    // blocking reads so a temporarily empty receive buffer is not mistaken
    // for the end of an HTTP request.
    stream.set_nonblocking(false)?;
    if let Ok(addr) = stream.peer_addr() {
        if !addr.ip().is_loopback() {
            let status = HttpStatus::Forbidden;
            return write_response(&mut stream, status.code(), status.reason());
        }
    }
    stream.set_read_timeout(Some(READ_TIMEOUT))?;

    let mut request = Vec::new();
    let status = match read_request(&mut stream, &mut request) {
        Ok(()) => validate_request(&request, token, handler),
        Err(ReadRequestError::TooLarge) => HttpStatus::PayloadTooLarge,
        Err(ReadRequestError::Io(err)) => return Err(err),
    };

    write_response(&mut stream, status.code(), status.reason())
}

enum ReadRequestError {
    TooLarge,
    Io(io::Error),
}

fn read_request(stream: &mut TcpStream, request: &mut Vec<u8>) -> Result<(), ReadRequestError> {
    let mut buf = [0_u8; 1024];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                request.extend_from_slice(&buf[..n]);
                if request.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
                    return Err(ReadRequestError::TooLarge);
                }
                if request_complete(request)? {
                    return Ok(());
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(());
            }
            Err(err) => return Err(ReadRequestError::Io(err)),
        }
    }
}

fn request_complete(request: &[u8]) -> Result<bool, ReadRequestError> {
    let Some(header_end) = find_header_end(request) else {
        if request.len() > MAX_HEADER_BYTES {
            return Err(ReadRequestError::TooLarge);
        }
        return Ok(false);
    };
    if header_end.saturating_add(4) > MAX_HEADER_BYTES {
        return Err(ReadRequestError::TooLarge);
    }
    let head = String::from_utf8_lossy(&request[..header_end]);
    let content_length = header_value(&head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err(ReadRequestError::TooLarge);
    }
    Ok(request.len() >= header_end + 4 + content_length)
}

fn validate_request(request: &[u8], token: &str, handler: &HookEventHandler) -> HttpStatus {
    let Some(header_end) = find_header_end(request) else {
        return HttpStatus::BadRequest;
    };
    let Ok(head) = std::str::from_utf8(&request[..header_end]) else {
        return HttpStatus::BadRequest;
    };
    let mut lines = head.split("\r\n");
    let Some(request_line) = lines.next() else {
        return HttpStatus::BadRequest;
    };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    if path != HOOK_PATH {
        return HttpStatus::NotFound;
    }
    if method != "POST" {
        return HttpStatus::MethodNotAllowed;
    }
    match header_value(head, "x-acorn-agent-hook-token") {
        Some(value) if value == token => {}
        _ => return HttpStatus::Unauthorized,
    }
    let body_start = header_end + 4;
    let content_length = header_value(head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let body_end = body_start.saturating_add(content_length);
    let body = request.get(body_start..body_end).unwrap_or_default();
    let event = match parse_agent_hook_request(head, body) {
        Ok(Some(event)) => event,
        Ok(None) => return HttpStatus::Accepted,
        Err(err) => {
            tracing::warn!(error = %err, "agent hook payload rejected");
            return HttpStatus::BadRequest;
        }
    };
    match handler(event) {
        AgentHookHandlerOutcome::Applied => HttpStatus::NoContent,
        AgentHookHandlerOutcome::Ignored => HttpStatus::Accepted,
        AgentHookHandlerOutcome::Unavailable => HttpStatus::ServiceUnavailable,
        AgentHookHandlerOutcome::Conflict => HttpStatus::Conflict,
    }
}

/// Transport metadata line at the head of a spooled hook event file — the
/// headers the original POST carried. An empty object means the body is a
/// self-describing normalized envelope (Antigravity, legacy Codex shape)
/// that parses through the generic header-less branch.
#[derive(Debug, Default, Deserialize)]
struct SpooledTransportMeta {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    lifecycle_id: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    native_hooks_enabled: Option<String>,
}

/// Drain the notify scripts' spool directory: events POSTed while no app
/// instance was listening land there instead of being dropped. Files are
/// named `<unix-ts>-<pid>.json` and replay in numeric (timestamp, pid)
/// order. Ordering within one second is best-effort — pid order is not
/// arrival order — so a mis-ordered same-second pair can leave a stale
/// status until the session's next live event corrects it; the pre-spool
/// behavior was losing both events outright. Every file is consumed
/// regardless of outcome so a malformed or permanently rejected event can
/// never wedge the replay.
pub fn replay_spooled_hook_events<F>(spool_dir: &std::path::Path, handler: F) -> usize
where
    F: Fn(AgentHookEvent) -> AgentHookHandlerOutcome,
{
    let Ok(entries) = std::fs::read_dir(spool_dir) else {
        return 0;
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort_by_key(|path| spool_replay_order_key(path));
    let mut replayed = 0;
    for path in files {
        match parse_spooled_hook_event(&path) {
            Ok(Some(event)) => {
                handler(event);
                replayed += 1;
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "spooled agent hook event rejected",
                );
            }
        }
        let _ = std::fs::remove_file(&path);
    }
    replayed
}

/// Numeric sort key for `<unix-ts>-<pid>.json` spool names: a string sort
/// would order `"21000"` before `"3000"` on a same-second tie. Unparseable
/// names sort last, tie-broken by the full path for determinism.
fn spool_replay_order_key(path: &std::path::Path) -> (u64, u64, std::path::PathBuf) {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let (ts, pid) = stem.split_once('-').unwrap_or((stem, ""));
    (
        ts.parse::<u64>().unwrap_or(u64::MAX),
        pid.parse::<u64>().unwrap_or(u64::MAX),
        path.to_path_buf(),
    )
}

fn parse_spooled_hook_event(path: &std::path::Path) -> Result<Option<AgentHookEvent>, String> {
    let metadata = std::fs::metadata(path).map_err(|err| err.to_string())?;
    if metadata.len() > MAX_BODY_BYTES as u64 {
        return Err("spooled event exceeds size limit".to_string());
    }
    let raw = std::fs::read(path).map_err(|err| err.to_string())?;
    let meta_end = raw
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "missing transport metadata line".to_string())?;
    let meta: SpooledTransportMeta =
        serde_json::from_slice(&raw[..meta_end]).map_err(|err| err.to_string())?;
    let head = synthetic_request_head(&meta)?;
    parse_agent_hook_request(&head, &raw[meta_end + 1..])
}

/// Rebuild the HTTP request head the spooled POST would have carried so a
/// replayed event travels the exact same parse path as a live one.
fn synthetic_request_head(meta: &SpooledTransportMeta) -> Result<String, String> {
    let mut head = String::from("POST /agent-hook HTTP/1.1");
    for (name, value) in [
        ("x-acorn-agent-hook-provider", &meta.provider),
        ("x-acorn-agent-hook-session-id", &meta.session_id),
        ("x-acorn-agent-hook-source", &meta.source),
        ("x-acorn-codex-lifecycle-id", &meta.lifecycle_id),
        ("x-acorn-codex-version", &meta.version),
        (
            "x-acorn-codex-native-hooks-enabled",
            &meta.native_hooks_enabled,
        ),
    ] {
        if let Some(value) = value {
            if value.chars().any(char::is_control) {
                return Err(format!("control characters in spooled {name}"));
            }
            head.push_str("\r\n");
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
        }
    }
    Ok(head)
}

fn parse_agent_hook_request(head: &str, body: &[u8]) -> Result<Option<AgentHookEvent>, String> {
    match header_value(head, "x-acorn-agent-hook-provider") {
        Some("codex") => parse_raw_codex_hook_request(head, body),
        Some("claude") => parse_raw_claude_hook_request(head, body),
        Some(provider) => Err(format!("unsupported raw hook provider: {provider}")),
        None => serde_json::from_slice::<AgentHookEvent>(body)
            .map(Some)
            .map_err(|err| err.to_string()),
    }
}

/// Normalize a raw Claude Code hook payload forwarded by
/// `acorn-claude-notify`. Structured top-level field parsing prevents
/// escaped content from impersonating ownership or lifecycle fields.
fn parse_raw_claude_hook_request(
    head: &str,
    body: &[u8],
) -> Result<Option<AgentHookEvent>, String> {
    let session_id = header_value(head, "x-acorn-agent-hook-session-id")
        .ok_or_else(|| "missing Acorn session id".to_string())?
        .parse::<Uuid>()
        .map_err(|_| "invalid Acorn session id".to_string())?;
    let raw_source = header_value(head, "x-acorn-agent-hook-source")
        .ok_or_else(|| "missing Claude hook source".to_string())?;
    if raw_source != "native" {
        return Err(format!("unsupported Claude hook source: {raw_source}"));
    }
    let payload = serde_json::from_slice::<Value>(body).map_err(|err| err.to_string())?;

    // Claude includes a non-empty agent_id only when this configured hook
    // fires inside a subagent. Child prompts, attention requests, and Stop
    // events do not own the parent Acorn terminal and must not transition
    // its aggregate status. A top-level `claude --agent` still carries
    // agent_type without agent_id and stays an owner.
    if payload
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
    {
        return Ok(None);
    }

    let hook_event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Claude hook payload has no hook_event_name".to_string())?;
    let event = match hook_event_name {
        "SessionStart" | "UserPromptSubmit" => AgentHookEventKind::Start,
        // Claude can emit Stop while background tasks or session crons are
        // still able to wake the parent turn. Those sessions stay Working;
        // only a Stop with no pending background work is actually awaiting
        // the user's next prompt.
        "Stop" if claude_stop_has_pending_background_work(&payload) => return Ok(None),
        "Stop" => AgentHookEventKind::NeedsInput,
        "Notification" | "PermissionRequest" => AgentHookEventKind::NeedsInput,
        "Error" => AgentHookEventKind::Error,
        // The settings file registers exactly the events above; anything
        // else is a future Claude addition we have no mapping for yet.
        _ => return Ok(None),
    };

    // Claude's conversation UUID binds the session's durable transcript
    // marker without cwd and mtime ambiguity.
    let provider_session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .and_then(|value| normalized_id(Some(value)))
        .filter(|value| value.len() <= 512)
        .map(str::to_string);

    Ok(Some(AgentHookEvent {
        session_id,
        provider: SessionAgentProvider::Claude,
        event,
        message: None,
        source: Some("native".to_string()),
        lifecycle_id: None,
        provider_session_id,
        provider_turn_id: None,
        provider_tool_id: None,
        provider_version: None,
        native_hooks_enabled: None,
        ownership: AgentHookOwnership::Owner,
    }))
}

fn claude_stop_has_pending_background_work(payload: &Value) -> bool {
    ["background_tasks", "session_crons"].iter().any(|key| {
        payload
            .get(*key)
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    })
}

fn parse_raw_codex_hook_request(head: &str, body: &[u8]) -> Result<Option<AgentHookEvent>, String> {
    let session_id = header_value(head, "x-acorn-agent-hook-session-id")
        .ok_or_else(|| "missing Acorn session id".to_string())?
        .parse::<Uuid>()
        .map_err(|_| "invalid Acorn session id".to_string())?;
    let raw_source = header_value(head, "x-acorn-agent-hook-source")
        .ok_or_else(|| "missing Codex hook source".to_string())?;
    let lifecycle_id = header_value(head, "x-acorn-codex-lifecycle-id")
        .and_then(|value| normalized_id(Some(value)))
        .map(str::to_string);
    let provider_version = header_value(head, "x-acorn-codex-version")
        .and_then(|value| normalized_id(Some(value)))
        .map(str::to_string);
    let native_hooks_enabled = match header_value(head, "x-acorn-codex-native-hooks-enabled") {
        None => None,
        Some("1" | "true") => Some(true),
        Some("0" | "false") => Some(false),
        Some(_) => return Err("invalid Codex native-hooks capability header".to_string()),
    };
    let payload = serde_json::from_slice::<Value>(body).map_err(|err| err.to_string())?;
    let provider_session_id = codex_payload_string(
        &payload,
        &[
            "/session_id",
            "/thread-id",
            "/thread_id",
            "/msg/thread_id",
            "/payload/thread_id",
            "/payload/msg/thread_id",
        ],
    );
    let provider_turn_id = codex_payload_string(
        &payload,
        &[
            "/turn_id",
            "/turn-id",
            "/msg/turn_id",
            "/payload/turn_id",
            "/payload/msg/turn_id",
        ],
    );
    let semantic_tool_id = codex_payload_string(
        &payload,
        &[
            "/tool_use_id",
            "/call_id",
            "/msg/tool_use_id",
            "/msg/call_id",
            "/payload/tool_use_id",
            "/payload/call_id",
            "/payload/msg/tool_use_id",
            "/payload/msg/call_id",
        ],
    );
    let accepts_generic_approval_id = matches!(raw_source, "jsonl_approval" | "native_permission")
        || ((raw_source == "native" || raw_source.starts_with("native_"))
            && payload.get("hook_event_name").and_then(Value::as_str) == Some("PermissionRequest"));
    let provider_tool_id = semantic_tool_id.or_else(|| {
        accepts_generic_approval_id.then(|| {
            codex_payload_string(
                &payload,
                &[
                    "/approval_id",
                    "/msg/approval_id",
                    "/payload/approval_id",
                    "/payload/msg/approval_id",
                    "/id",
                    "/msg/id",
                    "/payload/id",
                    "/payload/msg/id",
                ],
            )
        })?
    });

    let (event, source, ownership) = if raw_source == "native" || raw_source.starts_with("native_")
    {
        let hook_event_name = payload
            .get("hook_event_name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex hook payload has no hook_event_name".to_string())?;
        let expected_name = match raw_source {
            "native" => None,
            "native_prompt" => Some("UserPromptSubmit"),
            "native_tool_start" => Some("PreToolUse"),
            "native_permission" => Some("PermissionRequest"),
            "native_stop" => Some("Stop"),
            _ => return Err(format!("unsupported Codex hook source: {raw_source}")),
        };
        if let Some(expected_name) = expected_name {
            if hook_event_name != expected_name {
                return Err(format!(
                    "Codex hook source expected {expected_name}, received {hook_event_name}"
                ));
            }
        }
        if provider_turn_id.is_none() {
            return Err("Codex hook payload has no bounded non-empty turn_id".to_string());
        }
        let ownership = parse_codex_ownership(&payload)?;
        let requests_user_input =
            payload.get("tool_name").and_then(Value::as_str) == Some("request_user_input");
        let (event, source) = match hook_event_name {
            "UserPromptSubmit" => (AgentHookEventKind::Start, "native_prompt"),
            "PreToolUse" if requests_user_input => {
                (AgentHookEventKind::NeedsInput, "native_permission")
            }
            "PreToolUse" => (AgentHookEventKind::Start, "native_tool_start"),
            "PermissionRequest" => (AgentHookEventKind::NeedsInput, "native_permission"),
            "Stop" => (AgentHookEventKind::NeedsInput, "native_stop"),
            other => return Err(format!("unsupported Codex hook event: {other}")),
        };
        (event, source, ownership)
    } else {
        let event = match raw_source {
            "jsonl_user" | "jsonl_task" | "jsonl_tool" => AgentHookEventKind::Start,
            "jsonl_approval" => AgentHookEventKind::NeedsInput,
            "legacy_completion" => {
                let event_type = payload.get("type").and_then(Value::as_str);
                if !matches!(
                    event_type,
                    Some("agent-turn-complete" | "task_complete" | "turn_complete")
                ) {
                    return Err("unexpected legacy Codex completion payload".to_string());
                }
                AgentHookEventKind::NeedsInput
            }
            _ => return Err(format!("unsupported Codex hook source: {raw_source}")),
        };
        (event, raw_source, AgentHookOwnership::Owner)
    };

    Ok(Some(AgentHookEvent {
        session_id,
        provider: SessionAgentProvider::Codex,
        event,
        message: None,
        source: Some(source.to_string()),
        lifecycle_id,
        provider_session_id,
        provider_turn_id,
        provider_tool_id,
        provider_version,
        native_hooks_enabled,
        ownership,
    }))
}

fn parse_codex_ownership(payload: &Value) -> Result<AgentHookOwnership, String> {
    match (payload.get("agent_id"), payload.get("agent_type")) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => Ok(AgentHookOwnership::Owner),
        (Some(Value::String(_)), Some(Value::String(_))) => Ok(AgentHookOwnership::Child),
        _ => Err("Codex hook payload has malformed or incomplete agent ownership".to_string()),
    }
}

fn codex_payload_string(payload: &Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        payload
            .pointer(pointer)
            .and_then(Value::as_str)
            .and_then(|value| normalized_id(Some(value)))
            .filter(|value| value.len() <= 512)
            .map(str::to_string)
    })
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    for line in head.split("\r\n").skip(1) {
        let (raw_name, raw_value) = line.split_once(':')?;
        if raw_name.eq_ignore_ascii_case(name) {
            return Some(raw_value.trim());
        }
    }
    None
}

enum HttpStatus {
    Accepted,
    NoContent,
    BadRequest,
    Conflict,
    ServiceUnavailable,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    PayloadTooLarge,
}

impl HttpStatus {
    fn code(&self) -> u16 {
        match self {
            Self::Accepted => 202,
            Self::NoContent => 204,
            Self::BadRequest => 400,
            Self::Conflict => 409,
            Self::ServiceUnavailable => 503,
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::PayloadTooLarge => 413,
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::Accepted => "Accepted",
            Self::NoContent => "No Content",
            Self::BadRequest => "Bad Request",
            Self::Conflict => "Conflict",
            Self::ServiceUnavailable => "Service Unavailable",
            Self::Unauthorized => "Unauthorized",
            Self::Forbidden => "Forbidden",
            Self::NotFound => "Not Found",
            Self::MethodNotAllowed => "Method Not Allowed",
            Self::PayloadTooLarge => "Payload Too Large",
        }
    }
}

fn write_response(stream: &mut TcpStream, code: u16, reason: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        apply_agent_hook_event, dispatch_connection, handle_connection, AgentHookApplyOutcome,
        AgentHookEvent, AgentHookEventKind, AgentHookHandlerOutcome, AgentHookOwnership,
        AgentHookReducer, AgentHookServer, HookEventHandler, MAX_HEADER_BYTES,
    };
    use acorn_session::{
        AgentStatusSource, Session, SessionAgentProvider, SessionKind, SessionStatus,
    };
    use std::io::{self, Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use uuid::Uuid;

    #[test]
    fn hook_server_exposes_local_url_and_token() {
        let hooks = AgentHookServer::start().expect("hook server starts");

        assert!(hooks.hook_url().starts_with("http://127.0.0.1:"));
        assert!(hooks.hook_url().ends_with("/agent-hook"));
        assert!(!hooks.token().is_empty());
    }

    #[test]
    fn hook_server_serializes_handler_side_effects() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let hooks = Arc::new(
            AgentHookServer::start_with_handler(move |_| {
                entered_tx.send(()).expect("report handler entry");
                release_rx
                    .lock()
                    .expect("lock release receiver")
                    .recv_timeout(Duration::from_secs(2))
                    .expect("release handler");
            })
            .expect("hook server starts"),
        );
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );

        let first_hooks = hooks.clone();
        let first_body = body.clone();
        let first = std::thread::spawn(move || {
            let token = first_hooks.token().to_string();
            post(&first_hooks, &token, &first_body)
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first handler enters");

        let second_hooks = hooks.clone();
        let second = std::thread::spawn(move || {
            let token = second_hooks.token().to_string();
            post(&second_hooks, &token, &body)
        });
        let handlers_overlapped = entered_rx.recv_timeout(Duration::from_millis(500)).is_ok();

        release_tx.send(()).expect("release first handler");
        if handlers_overlapped {
            release_tx.send(()).expect("release second handler");
        } else {
            entered_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("second handler enters after first exits");
            release_tx.send(()).expect("release second handler");
        }

        assert!(first
            .join()
            .expect("first client")
            .starts_with("HTTP/1.1 204 No Content"));
        assert!(second
            .join()
            .expect("second client")
            .starts_with("HTTP/1.1 204 No Content"));
        assert!(
            !handlers_overlapped,
            "concurrent hook callbacks can reorder apply, persist, and emit"
        );
    }

    #[test]
    fn hook_server_drop_releases_the_listener_before_returning() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let addr = addr_from_url(hooks.hook_url());
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );
        assert!(post(&hooks, hooks.token(), &body).starts_with("HTTP/1.1 204 No Content"));

        std::thread::sleep(Duration::from_millis(20));
        drop(hooks);

        assert!(
            TcpStream::connect(addr).is_err(),
            "hook listener remained reachable after server drop"
        );
    }

    #[test]
    fn hook_connection_waits_for_bytes_on_an_inherited_nonblocking_socket() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "test-token".to_string();
        let (tx, rx) = mpsc::channel();
        let handler: HookEventHandler = Arc::new(move |event| {
            tx.send(event).expect("send event");
            AgentHookHandlerOutcome::Applied
        });
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"start\"}}"
        );

        let client = std::thread::spawn(move || -> std::io::Result<String> {
            let mut stream = TcpStream::connect(addr)?;
            std::thread::sleep(Duration::from_millis(50));
            write!(
                stream,
                "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: test-token\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )?;
            let mut response = String::new();
            stream.read_to_string(&mut response)?;
            Ok(response)
        });

        let (stream, _) = listener.accept().expect("accept hook");
        stream
            .set_nonblocking(true)
            .expect("simulate inherited listener mode");
        handle_connection(stream, &token, &handler).expect("handle request");

        let response = client
            .join()
            .expect("client thread")
            .expect("request remains connected");
        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected delayed-request response: {response:?}"
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("event delivered")
                .session_id,
            session_id
        );
    }

    #[test]
    fn hook_connection_falls_back_inline_when_worker_spawn_fails() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "test-token".to_string();
        let (tx, rx) = mpsc::channel();
        let handler: HookEventHandler = Arc::new(move |event| {
            tx.send(event).expect("send event");
            AgentHookHandlerOutcome::Applied
        });
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"start\"}}"
        );

        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).expect("connect hook");
            write!(
                stream,
                "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: test-token\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .expect("write request");
            let mut response = String::new();
            stream.read_to_string(&mut response).expect("read response");
            response
        });

        let (stream, _) = listener.accept().expect("accept hook");
        dispatch_connection(stream, token, handler, |_, _, _| {
            Err(io::Error::other("forced worker spawn failure"))
        });

        assert!(client
            .join()
            .expect("client thread")
            .starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("event delivered")
                .session_id,
            session_id
        );
    }

    #[test]
    fn hook_server_rejects_invalid_token_and_accepts_valid_token() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );

        let invalid = post(&hooks, "invalid", &body);
        assert!(invalid.starts_with("HTTP/1.1 401 Unauthorized"));

        let valid = post(&hooks, hooks.token(), &body);
        assert!(valid.starts_with("HTTP/1.1 204 No Content"));
    }

    #[test]
    fn hook_server_parses_valid_event_and_invokes_handler() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"needs_input\",\"message\":\"ready\",\"source\":\"hook\"}}"
        );

        let response = post(&hooks, hooks.token(), &body);
        assert!(response.starts_with("HTTP/1.1 204 No Content"));

        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("event delivered");
        assert_eq!(event.session_id, session_id);
        assert_eq!(event.provider, SessionAgentProvider::Codex);
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.message.as_deref(), Some("ready"));
    }

    #[test]
    fn raw_codex_native_payloads_are_normalized_in_rust() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";

        for (hook_event_name, expected_event, expected_source) in [
            (
                "UserPromptSubmit",
                AgentHookEventKind::Start,
                "native_prompt",
            ),
            ("PreToolUse", AgentHookEventKind::Start, "native_tool_start"),
            (
                "PermissionRequest",
                AgentHookEventKind::NeedsInput,
                "native_permission",
            ),
        ] {
            let body = serde_json::json!({
                "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
                "turn_id": turn_id,
                "hook_event_name": hook_event_name,
            })
            .to_string();
            let response = post_raw_codex_hook(&hooks, session_id, &body);
            assert!(
                response.starts_with("HTTP/1.1 204 No Content"),
                "unexpected {hook_event_name} response: {response:?}"
            );
            let event = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("native event delivered");
            assert_eq!(event.session_id, session_id);
            assert_eq!(event.event, expected_event);
            assert_eq!(event.source.as_deref(), Some(expected_source));
            assert_eq!(event.provider_turn_id.as_deref(), Some(turn_id));
        }

        let stop = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": turn_id,
            "hook_event_name": "Stop",
        })
        .to_string();
        let response = post_raw_codex_hook(&hooks, session_id, &stop);
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("Stop delivered");
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.source.as_deref(), Some("native_stop"));
        assert_eq!(event.provider_turn_id.as_deref(), Some(turn_id));
    }

    #[test]
    fn raw_codex_native_payloads_preserve_child_ownership_and_reject_malformed_owners() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        let child = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
            "hook_event_name": "PermissionRequest",
            "agent_id": "019f6322-41e5-7882-a99a-d186dff6739c",
            "agent_type": "worker",
        });
        let response = post_raw_codex_hook(&hooks, session_id, &child.to_string());
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        let child = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("child event reaches the reducer-facing handler");
        assert_eq!(child.ownership, super::AgentHookOwnership::Child);

        for malformed_owner in [
            serde_json::json!({
                "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
                "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
                "hook_event_name": "UserPromptSubmit",
                "agent_id": null,
            }),
            serde_json::json!({
                "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
                "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
                "hook_event_name": "PreToolUse",
                "agent_id": null,
                "agent_type": "worker",
            }),
        ] {
            let response = post_raw_codex_hook(&hooks, session_id, &malformed_owner.to_string());
            assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
            assert!(
                rx.try_recv().is_err(),
                "malformed ownership reached the owner handler"
            );
        }

        let invalid_turn = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "not-a-turn-id",
            "hook_event_name": "Stop",
        })
        .to_string();
        let response = post_raw_codex_hook(&hooks, session_id, &invalid_turn);
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("opaque turn id is delivered")
                .provider_turn_id
                .as_deref(),
            Some("not-a-turn-id")
        );
    }

    #[test]
    fn raw_claude_native_payloads_are_normalized_in_rust() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let claude_uuid = "019e4818-7c15-4e60-9b3b-898a1c7803d6";

        for (hook_event_name, expected_event) in [
            ("SessionStart", AgentHookEventKind::Start),
            ("UserPromptSubmit", AgentHookEventKind::Start),
            ("Notification", AgentHookEventKind::NeedsInput),
            ("PermissionRequest", AgentHookEventKind::NeedsInput),
            ("Error", AgentHookEventKind::Error),
        ] {
            let body = serde_json::json!({
                "session_id": claude_uuid,
                "transcript_path": format!("/home/user/.claude/projects/repo/{claude_uuid}.jsonl"),
                "hook_event_name": hook_event_name,
            })
            .to_string();
            let response = post_raw_claude_hook(&hooks, session_id, &body);
            assert!(
                response.starts_with("HTTP/1.1 204 No Content"),
                "unexpected {hook_event_name} response: {response:?}"
            );
            let event = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("native event delivered");
            assert_eq!(event.session_id, session_id);
            assert_eq!(event.provider, SessionAgentProvider::Claude);
            assert_eq!(event.event, expected_event, "{hook_event_name}");
            assert_eq!(event.source.as_deref(), Some("native"));
            assert_eq!(event.provider_session_id.as_deref(), Some(claude_uuid));
            assert_eq!(event.ownership, super::AgentHookOwnership::Owner);
        }

        let stop = serde_json::json!({
            "session_id": claude_uuid,
            "hook_event_name": "Stop",
            "background_tasks": [],
            "session_crons": [],
        })
        .to_string();
        let response = post_raw_claude_hook(&hooks, session_id, &stop);
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("Stop delivered");
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
    }

    #[test]
    fn raw_claude_stop_with_background_work_emits_no_transition() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        for payload in [
            serde_json::json!({
                "hook_event_name": "Stop",
                "background_tasks": [{"id": "agent-1", "type": "agent", "status": "running"}],
                "session_crons": [],
            }),
            serde_json::json!({
                "hook_event_name": "Stop",
                "background_tasks": [],
                "session_crons": [{"id": "cron-1", "schedule": "in 1m", "recurring": false}],
            }),
        ] {
            let response = post_raw_claude_hook(&hooks, session_id, &payload.to_string());
            assert!(
                response.starts_with("HTTP/1.1 202 Accepted"),
                "a Stop with pending background work is a pause, got {response:?}"
            );
            assert!(
                rx.try_recv().is_err(),
                "a background pause must not reach the reducer"
            );
        }

        // Decoy text inside a string field must not suppress the real wait.
        let decoy = serde_json::json!({
            "hook_event_name": "Stop",
            "background_tasks": [],
            "session_crons": [],
            "last_assistant_message": "decoy: \"background_tasks\":[{\"status\":\"running\"}]",
        });
        let response = post_raw_claude_hook(&hooks, session_id, &decoy.to_string());
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("clean Stop delivered")
                .event,
            AgentHookEventKind::NeedsInput
        );
    }

    #[test]
    fn raw_claude_subagent_events_cannot_transition_the_parent_session() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        for hook_event_name in [
            "UserPromptSubmit",
            "Notification",
            "PermissionRequest",
            "Stop",
        ] {
            let payload = serde_json::json!({
                "hook_event_name": hook_event_name,
                "agent_id": "019f6338-6250-7303-88a6-a7add31dba1d",
                "agent_type": "Explore",
                "background_tasks": [],
                "session_crons": [],
            });
            let response = post_raw_claude_hook(&hooks, session_id, &payload.to_string());
            assert!(
                response.starts_with("HTTP/1.1 202 Accepted"),
                "a child {hook_event_name} must not transition its parent session"
            );
            assert!(rx.try_recv().is_err());
        }

        // A top-level `claude --agent` carries agent_type without agent_id.
        let top_level_agent = serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "agent_type": "reviewer",
        });
        let response = post_raw_claude_hook(&hooks, session_id, &top_level_agent.to_string());
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("owner event delivered")
                .event,
            AgentHookEventKind::NeedsInput
        );

        // Empty and null agent_id are owner shapes, not children.
        for agent_id in [serde_json::json!(""), serde_json::Value::Null] {
            let payload = serde_json::json!({
                "hook_event_name": "UserPromptSubmit",
                "agent_id": agent_id,
            });
            let response = post_raw_claude_hook(&hooks, session_id, &payload.to_string());
            assert!(response.starts_with("HTTP/1.1 204 No Content"));
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(1))
                    .expect("owner event delivered")
                    .event,
                AgentHookEventKind::Start
            );
        }

        // Escaped decoy text must not read as a child id.
        let decoy = serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "message": "literal decoys: {\"agent_id\":\"not-a-real-field\",\"hook_event_name\":\"Stop\"}",
        });
        let response = post_raw_claude_hook(&hooks, session_id, &decoy.to_string());
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("decoy-carrying owner event delivered")
                .event,
            AgentHookEventKind::NeedsInput
        );
    }

    #[test]
    fn raw_claude_unknown_or_malformed_events_fail_safe() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        // Events without a mapping (future Claude additions) are dropped,
        // not errors — the registered settings only name the known five.
        for hook_event_name in ["SubagentStop", "PostToolUse", "SessionEnd"] {
            let payload = serde_json::json!({"hook_event_name": hook_event_name});
            let response = post_raw_claude_hook(&hooks, session_id, &payload.to_string());
            assert!(
                response.starts_with("HTTP/1.1 202 Accepted"),
                "unmapped {hook_event_name} must be dropped, got {response:?}"
            );
            assert!(rx.try_recv().is_err());
        }

        let missing_name = serde_json::json!({"session_id": "x"});
        let response = post_raw_claude_hook(&hooks, session_id, &missing_name.to_string());
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));

        let response = post_raw_claude_hook(&hooks, session_id, "not-json");
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn reducer_prunes_lanes_for_removed_sessions() {
        fn claude_start(session_id: Uuid) -> AgentHookEvent {
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Claude,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("native".to_string()),
                lifecycle_id: None,
                provider_session_id: None,
                provider_turn_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: AgentHookOwnership::Owner,
            }
        }
        fn new_session(name: &str) -> Session {
            Session::new(
                name.to_string(),
                "/tmp/repo".into(),
                "/tmp/repo".into(),
                "main".to_string(),
                false,
                SessionKind::Regular,
            )
        }

        let sessions = acorn_session::SessionStore::new();
        let removed = new_session("removed");
        let removed_id = removed.id;
        sessions.insert(removed);
        let reducer = AgentHookReducer::new(sessions.clone());

        reducer
            .apply(claude_start(removed_id))
            .expect("first event creates the lane");
        assert_eq!(reducer.lanes.len(), 1);

        sessions.remove(&removed_id).expect("session removed");

        // A new session's first event prunes lanes left by removed sessions.
        let kept = new_session("kept");
        let kept_id = kept.id;
        sessions.insert(kept);
        reducer
            .apply(claude_start(kept_id))
            .expect("event for the live session applies");
        assert_eq!(
            reducer.lanes.len(),
            1,
            "the dead lane must be pruned when a new lane is created"
        );
        assert!(reducer.lanes.contains_key(&kept_id));

        // A late event for the removed session is rejected without
        // re-growing the map.
        assert!(matches!(
            reducer.apply(claude_start(removed_id)),
            Err(super::AgentHookApplyError::Unavailable(_))
        ));
        assert!(!reducer.lanes.contains_key(&removed_id));
        assert_eq!(reducer.lanes.len(), 1);
    }

    #[test]
    fn replay_spooled_hook_events_drains_in_order_and_consumes_files() {
        let dir = std::env::temp_dir().join(format!("acorn-spool-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let session_id = Uuid::new_v4();
        let claude_uuid = "019e4818-7c15-4e60-9b3b-898a1c7803d6";

        let meta =
            format!(r#"{{"provider":"claude","session_id":"{session_id}","source":"native"}}"#);
        let start_body = serde_json::json!({
            "session_id": claude_uuid,
            "hook_event_name": "UserPromptSubmit",
        });
        let stop_body = serde_json::json!({
            "session_id": claude_uuid,
            "hook_event_name": "Stop",
            "background_tasks": [],
            "session_crons": [],
        });
        std::fs::write(
            dir.join("1700000001-100.json"),
            format!("{meta}\n{start_body}"),
        )
        .unwrap();
        std::fs::write(
            dir.join("1700000002-101.json"),
            format!("{meta}\n{stop_body}"),
        )
        .unwrap();
        // A subagent event is classified away, not replayed — but consumed.
        let child_body = serde_json::json!({
            "session_id": claude_uuid,
            "hook_event_name": "Stop",
            "agent_id": "019f6338-6250-7303-88a6-a7add31dba1d",
        });
        std::fs::write(
            dir.join("1700000003-102.json"),
            format!("{meta}\n{child_body}"),
        )
        .unwrap();
        // Malformed metadata is rejected and consumed.
        std::fs::write(dir.join("1700000004-103.json"), "not-json\n{}").unwrap();
        // Header-injection through metadata values fails closed and is consumed.
        std::fs::write(
            dir.join("1700000005-104.json"),
            format!(
                "{}\n{}",
                r#"{"provider":"claude","session_id":"x\r\nx-acorn-agent-hook-provider: codex","source":"native"}"#,
                start_body
            ),
        )
        .unwrap();
        // A header-less envelope parses through the generic branch.
        let envelope = serde_json::json!({
            "session_id": session_id,
            "provider": "antigravity",
            "event": "needs_input",
            "source": "transcript",
        });
        std::fs::write(dir.join("1700000006-105.json"), format!("{{}}\n{envelope}")).unwrap();
        // In-flight tmp files are not picked up.
        std::fs::write(dir.join(".tmp-106"), "partial").unwrap();

        let seen = Mutex::new(Vec::new());
        let replayed = super::replay_spooled_hook_events(&dir, |event| {
            seen.lock().unwrap().push(event);
            AgentHookHandlerOutcome::Applied
        });

        assert_eq!(replayed, 3);
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen[0].event, AgentHookEventKind::Start);
        assert_eq!(seen[0].provider, SessionAgentProvider::Claude);
        assert_eq!(seen[0].session_id, session_id);
        assert_eq!(seen[0].provider_session_id.as_deref(), Some(claude_uuid));
        assert_eq!(seen[0].source.as_deref(), Some("native"));
        assert_eq!(seen[1].event, AgentHookEventKind::NeedsInput);
        assert_eq!(seen[2].provider, SessionAgentProvider::Antigravity);
        assert_eq!(seen[2].source.as_deref(), Some("transcript"));
        let leftover: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json"))
            .collect();
        assert!(
            leftover.is_empty(),
            "all spooled events must be consumed: {leftover:?}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replay_spool_order_is_numeric_not_lexicographic() {
        let dir =
            std::env::temp_dir().join(format!("acorn-spool-order-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let session_id = Uuid::new_v4();
        let claude_uuid = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        let meta =
            format!(r#"{{"provider":"claude","session_id":"{session_id}","source":"native"}}"#);
        let start_body = serde_json::json!({
            "session_id": claude_uuid,
            "hook_event_name": "UserPromptSubmit",
        });
        let stop_body = serde_json::json!({
            "session_id": claude_uuid,
            "hook_event_name": "Stop",
            "background_tasks": [],
            "session_crons": [],
        });
        // Same second; pid 9 wrote first, pid 100 second. A string sort
        // would replay "…-100.json" before "…-9.json" and end on Start.
        std::fs::write(
            dir.join("1700000001-9.json"),
            format!("{meta}\n{start_body}"),
        )
        .unwrap();
        std::fs::write(
            dir.join("1700000001-100.json"),
            format!("{meta}\n{stop_body}"),
        )
        .unwrap();

        let seen = Mutex::new(Vec::new());
        let replayed = super::replay_spooled_hook_events(&dir, |event| {
            seen.lock().unwrap().push(event.event);
            AgentHookHandlerOutcome::Applied
        });

        assert_eq!(replayed, 2);
        assert_eq!(
            seen.into_inner().unwrap(),
            vec![AgentHookEventKind::Start, AgentHookEventKind::NeedsInput],
            "same-second ties must break on numeric pid order",
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replay_spooled_codex_meta_reconstructs_transport_headers() {
        let dir =
            std::env::temp_dir().join(format!("acorn-spool-codex-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let session_id = Uuid::new_v4();
        let meta = format!(
            r#"{{"provider":"codex","session_id":"{session_id}","source":"native","lifecycle_id":"123_456","version":"0.144.4","native_hooks_enabled":"1"}}"#
        );
        let body = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
            "hook_event_name": "UserPromptSubmit",
        });
        std::fs::write(dir.join("1700000001-100.json"), format!("{meta}\n{body}")).unwrap();

        let seen = Mutex::new(Vec::new());
        let replayed = super::replay_spooled_hook_events(&dir, |event| {
            seen.lock().unwrap().push(event);
            AgentHookHandlerOutcome::Applied
        });

        assert_eq!(replayed, 1);
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen[0].session_id, session_id);
        assert_eq!(seen[0].provider, SessionAgentProvider::Codex);
        assert_eq!(seen[0].event, AgentHookEventKind::Start);
        assert_eq!(seen[0].source.as_deref(), Some("native_prompt"));
        assert_eq!(seen[0].lifecycle_id.as_deref(), Some("123_456"));
        assert_eq!(
            seen[0].provider_turn_id.as_deref(),
            Some("019f6338-6250-7303-88a6-a7add31dba1d")
        );
        assert_eq!(seen[0].native_hooks_enabled, Some(true));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hook_server_reports_when_an_owner_event_cannot_be_applied() {
        let hooks =
            AgentHookServer::start_with_outcome_handler(|_| AgentHookHandlerOutcome::Conflict)
                .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let body = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
            "hook_event_name": "UserPromptSubmit",
            "agent_id": null,
            "agent_type": null,
        })
        .to_string();

        let response = post_raw_codex_hook(&hooks, session_id, &body);
        assert!(response.starts_with("HTTP/1.1 409 Conflict"));
    }

    #[test]
    fn hook_server_accepts_large_documented_codex_payloads() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
            "hook_event_name": "UserPromptSubmit",
            "agent_id": null,
            "agent_type": null,
            "prompt": "x".repeat(32 * 1024),
        })
        .to_string();

        let response = post_raw_codex_hook(&hooks, Uuid::new_v4(), &body);
        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected large-payload response: {response:?}"
        );
    }

    #[test]
    fn hook_server_rejects_headers_over_the_documented_limit() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );
        let padding = "x".repeat(MAX_HEADER_BYTES);
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Padding: {padding}\r\nX-Acorn-Agent-Hook-Token: {}\r\nContent-Length: {}\r\n\r\n{body}",
            hooks.token(),
            body.len()
        )
        .expect("write oversized header");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");

        assert!(
            response.starts_with("HTTP/1.1 413 Payload Too Large"),
            "oversized completed header bypassed the limit: {response:?}"
        );
    }

    #[test]
    fn hook_event_kind_maps_to_session_status() {
        assert_eq!(
            AgentHookEventKind::Start.session_status(),
            acorn_session::SessionStatus::Working
        );
        assert_eq!(
            AgentHookEventKind::NeedsInput.session_status(),
            acorn_session::SessionStatus::WaitingForInput
        );
        assert_eq!(
            AgentHookEventKind::Stop.session_status(),
            acorn_session::SessionStatus::Ready
        );
        assert_eq!(
            AgentHookEventKind::Error.session_status(),
            acorn_session::SessionStatus::Errored
        );
    }

    #[test]
    fn apply_agent_hook_event_updates_known_session_status() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let status = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("hook".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("event applies");

        assert_eq!(status, SessionStatus::WaitingForInput);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
        assert_eq!(
            sessions.hook_provider(&session_id),
            Some(SessionAgentProvider::Codex)
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").agent_provider,
            Some(SessionAgentProvider::Codex)
        );
    }

    #[test]
    fn transcript_observations_do_not_disable_authoritative_status_polling() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Antigravity".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Antigravity);
        let session_id = session.id;
        sessions.insert(session);

        let status = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Antigravity,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("transcript".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("transcript observation applies");

        assert_eq!(status, SessionStatus::WaitingForInput);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
        assert!(
            !sessions.is_hook_active(&session_id),
            "a transcript-derived event must not make the poll defer to itself"
        );
        assert_eq!(sessions.hook_provider(&session_id), None);
    }

    #[test]
    fn apply_agent_hook_event_accepts_provider_switch_from_resting_session() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Ready;
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let status = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Claude,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("hook".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("resting provider switch applies");

        let stored = sessions.get(&session_id).expect("session");
        assert_eq!(status, SessionStatus::Working);
        assert_eq!(stored.status, SessionStatus::Working);
        assert_eq!(stored.agent_provider, Some(SessionAgentProvider::Claude));
        assert_eq!(
            sessions.hook_provider(&session_id),
            Some(SessionAgentProvider::Claude)
        );
    }

    #[test]
    fn apply_agent_hook_event_rejects_nested_provider_while_owner_is_working() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Working;
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let err = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Claude,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("hook".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect_err("nested provider event is rejected");

        assert!(err.contains("provider mismatch"));
        let stored = sessions.get(&session_id).expect("session");
        assert_eq!(stored.status, SessionStatus::Working);
        assert_eq!(stored.agent_provider, Some(SessionAgentProvider::Codex));
    }

    #[test]
    fn codex_hook_sources_scope_tool_activity_to_the_current_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let apply = |source: &str, event| {
            apply_agent_hook_event(
                &sessions,
                AgentHookEvent {
                    session_id,
                    provider: SessionAgentProvider::Codex,
                    event,
                    message: None,
                    source: Some(source.to_string()),
                    provider_turn_id: None,
                    lifecycle_id: None,
                    provider_session_id: None,
                    provider_tool_id: None,
                    provider_version: None,
                    native_hooks_enabled: None,
                    ownership: Default::default(),
                },
            )
            .expect("event applies")
        };

        apply("turn", AgentHookEventKind::Start);
        assert_eq!(sessions.hook_tool_started_at(&session_id), None);

        apply("tool", AgentHookEventKind::Start);
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        apply("hook", AgentHookEventKind::Stop);
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        apply("turn", AgentHookEventKind::Start);
        assert_eq!(sessions.hook_tool_started_at(&session_id), None);
    }

    #[test]
    fn codex_tui_preview_is_not_an_authoritative_hook_event() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        session.hook_active = true;
        session.status = SessionStatus::Working;
        let session_id = session.id;
        sessions.insert(session);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("preview".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("the ordered TUI preview applies");

        assert_eq!(sessions.hook_revision(&session_id), 0);
        assert!(!sessions.is_hook_confirmed_this_run(&session_id));
        assert!(!sessions.has_hook_turn_boundary(&session_id));
        assert_eq!(sessions.hook_turn_id(&session_id), None);

        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";
        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("turn".to_string()),
                provider_turn_id: Some(turn_id.to_string()),
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("the native prompt establishes the turn");
        let native_revision = sessions.hook_revision(&session_id);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("preview".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("a delayed preview remains harmless");
        assert_eq!(sessions.hook_revision(&session_id), native_revision);
        assert_eq!(sessions.hook_turn_id(&session_id).as_deref(), Some(turn_id));

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("hook".to_string()),
                provider_turn_id: Some(turn_id.to_string()),
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("the native stop completes the turn");
        let stop_revision = sessions.hook_revision(&session_id);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("preview".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("a preview delayed past Stop remains harmless");
        assert_eq!(sessions.hook_revision(&session_id), stop_revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn delayed_codex_completion_cannot_overwrite_a_newer_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let apply_json = |json: String| {
            let event = serde_json::from_str::<AgentHookEvent>(&json).expect("valid hook event");
            apply_agent_hook_event(&sessions, event)
        };
        let event = |kind: &str, source: &str, turn_id: Option<&str>| {
            let turn_id = turn_id
                .map(|id| format!(r#","turn_id":"{id}""#))
                .unwrap_or_default();
            format!(
                r#"{{"session_id":"{session_id}","provider":"codex","event":"{kind}","source":"{source}"{turn_id}}}"#
            )
        };

        apply_json(event("start", "turn", Some("turn-1"))).expect("first turn starts");
        apply_json(event("start", "turn", Some("turn-2"))).expect("second turn starts");
        let revision_after_start = sessions.hook_revision(&session_id);

        let error = apply_json(event("needs_input", "hook", Some("turn-1")))
            .expect_err("a delayed completion from the previous turn is stale");
        assert!(
            error.contains("stale Codex turn"),
            "unexpected error: {error}"
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
        assert_eq!(sessions.hook_revision(&session_id), revision_after_start);

        apply_json(event("needs_input", "hook", Some("turn-2")))
            .expect("the current turn may complete");
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn codex_user_turn_without_an_id_invalidates_the_previous_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let apply = |kind: &str, turn_id: Option<&str>| {
            let turn_id = turn_id
                .map(|id| format!(r#","turn_id":"{id}""#))
                .unwrap_or_default();
            let json = format!(
                r#"{{"session_id":"{session_id}","provider":"codex","event":"{kind}","source":"turn"{turn_id}}}"#
            );
            let event = serde_json::from_str::<AgentHookEvent>(&json).expect("valid hook event");
            apply_agent_hook_event(&sessions, event)
        };

        apply("start", Some("turn-1")).expect("first turn starts");
        apply("start", None).expect("new user turn starts before Codex assigns its id");

        let error = apply("needs_input", Some("turn-1"))
            .expect_err("the previous completion must not win the new-turn race");
        assert!(
            error.contains("stale Codex turn"),
            "unexpected error: {error}"
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn first_native_codex_completion_after_restart_bootstraps_the_turn_id() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        session.hook_active = true;
        session.status = SessionStatus::Working;
        let session_id = session.id;
        sessions.insert(session);

        assert_eq!(sessions.hook_revision(&session_id), 0);
        assert_eq!(sessions.hook_turn_id(&session_id), None);

        let event = AgentHookEvent {
            session_id,
            provider: SessionAgentProvider::Codex,
            event: AgentHookEventKind::NeedsInput,
            message: None,
            source: Some("hook".to_string()),
            provider_turn_id: Some("019f6338-6250-7303-88a6-a7add31dba1d".to_string()),
            lifecycle_id: None,
            provider_session_id: None,
            provider_tool_id: None,
            provider_version: None,
            native_hooks_enabled: None,
            ownership: Default::default(),
        };
        apply_agent_hook_event(&sessions, event)
            .expect("the first native event after restart establishes the current turn");

        assert_eq!(
            sessions.hook_turn_id(&session_id).as_deref(),
            Some("019f6338-6250-7303-88a6-a7add31dba1d")
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn first_native_codex_tool_after_restart_binds_the_later_completion() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        session.hook_active = true;
        session.status = SessionStatus::Working;
        let session_id = session.id;
        sessions.insert(session);

        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";
        let apply = |event: AgentHookEventKind, source: &str, turn_id: &str| {
            apply_agent_hook_event(
                &sessions,
                AgentHookEvent {
                    session_id,
                    provider: SessionAgentProvider::Codex,
                    event,
                    message: None,
                    source: Some(source.to_string()),
                    provider_turn_id: Some(turn_id.to_string()),
                    lifecycle_id: None,
                    provider_session_id: None,
                    provider_tool_id: None,
                    provider_version: None,
                    native_hooks_enabled: None,
                    ownership: Default::default(),
                },
            )
        };

        apply(AgentHookEventKind::Start, "tool", turn_id)
            .expect("the first native tool after restart establishes the current turn");
        assert_eq!(sessions.hook_turn_id(&session_id).as_deref(), Some(turn_id));

        let stale_turn = "019f6338-6250-7303-88a6-a7add31dba1e";
        let revision = sessions.hook_revision(&session_id);
        apply(AgentHookEventKind::NeedsInput, "hook", stale_turn)
            .expect_err("a later completion from another turn remains stale");
        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );

        apply(AgentHookEventKind::NeedsInput, "hook", turn_id)
            .expect("the completion for the restart-bound turn applies");
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn legacy_codex_completion_cannot_override_a_bound_native_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("turn".to_string()),
                provider_turn_id: Some("019f6338-6250-7303-88a6-a7add31dba1d".to_string()),
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("native turn starts");

        let error = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("legacy".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect_err("an unscoped legacy callback must not end a native turn");

        assert!(error.contains("legacy Codex completion"), "{error}");
        let revision = sessions.hook_revision(&session_id);
        let error = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("hook".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect_err("an unscoped hook callback must not bypass native turn ownership");
        assert!(error.contains("unscoped Codex completion"), "{error}");
        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn transcript_codex_completion_can_finish_a_bound_native_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("turn".to_string()),
                provider_turn_id: Some("019f6338-6250-7303-88a6-a7add31dba1d".to_string()),
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("native turn starts");

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("transcript".to_string()),
                provider_turn_id: None,
                lifecycle_id: None,
                provider_session_id: None,
                provider_tool_id: None,
                provider_version: None,
                native_hooks_enabled: None,
                ownership: Default::default(),
            },
        )
        .expect("transcript fallback completes the turn when Stop is unavailable");

        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_ignores_delayed_completion_from_t1_after_t2_starts() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_prompt", Some("t1")),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        apply_codex(&reducer, session_id, "native_stop", Some("t1"));
        apply_codex(&reducer, session_id, "native_prompt", Some("t2"));

        assert!(matches!(
            apply_codex(&reducer, session_id, "legacy_completion", Some("t1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_records_child_turn_and_ignores_its_matching_fallback() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("owner-turn"));
        let owner_revision = sessions.hook_revision(&session_id);

        let mut child = codex_event(session_id, "native_permission", Some("child-turn"));
        child.ownership = AgentHookOwnership::Child;
        assert!(matches!(
            reducer.apply(child).expect("child is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_approval", Some("child-turn")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(sessions.hook_revision(&session_id), owner_revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_rejects_idless_non_start_fallback_for_a_known_turn() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));

        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_approval", None),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_duplicate_native_prompt_cannot_clear_permission_wait() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_permission", Some("turn-1"));

        assert!(matches!(
            apply_codex(&reducer, session_id, "native_prompt", Some("turn-1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_matches_fallback_before_native_without_swallowing_next_fallback_turn() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "jsonl_user", None);
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_tool_start", Some("turn-1"));
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_user", None),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(sessions.hook_tool_started_at(&session_id), None);
    }

    #[test]
    fn reducer_fallback_does_not_claim_authoritative_hook_revision() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        assert_eq!(sessions.hook_revision(&session_id), 0);
        apply_codex(&reducer, session_id, "jsonl_user", Some("turn-1"));
        assert_eq!(sessions.hook_revision(&session_id), 0);
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        assert_eq!(sessions.hook_revision(&session_id), 1);
    }

    #[test]
    fn reducer_tracks_the_applied_status_source_across_native_and_fallback_events() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();

        assert!(matches!(
            apply_codex(&reducer, session_id, "native_prompt", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(
            sessions.agent_status_source(&session_id),
            Some(AgentStatusSource::Hook)
        );

        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_approval", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert_eq!(
            sessions.agent_status_source(&session_id),
            Some(AgentStatusSource::TranscriptFallback)
        );

        assert!(matches!(
            apply_codex(&reducer, session_id, "native_tool_start", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(
            sessions.agent_status_source(&session_id),
            Some(AgentStatusSource::Hook)
        );
    }

    #[test]
    fn reducer_native_tool_ignores_late_matching_fallback_approval() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_permission", Some("turn-1"));
        let mut native_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        native_tool.provider_tool_id = Some("tool-1".to_string());
        assert!(matches!(
            reducer.apply(native_tool).expect("native tool applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));

        let mut late_approval = codex_event(session_id, "jsonl_approval", Some("turn-1"));
        late_approval.provider_tool_id = Some("tool-1".to_string());
        assert!(matches!(
            reducer
                .apply(late_approval)
                .expect("approval is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_retired_lifecycle_cannot_overwrite_current_run() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        let mut next_run = codex_event(session_id, "native_prompt", Some("turn-2"));
        next_run.lifecycle_id = Some("lifecycle-2".to_string());
        reducer.apply(next_run).expect("next lifecycle starts");

        assert!(matches!(
            apply_codex(&reducer, session_id, "native_stop", Some("turn-1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_bootstraps_first_native_stop_after_restart_but_not_fallback() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        assert!(matches!(
            apply_codex(&reducer, session_id, "legacy_completion", Some("turn-1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_stop", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert_eq!(
            sessions.hook_turn_id(&session_id).as_deref(),
            Some("turn-1")
        );
    }

    #[test]
    fn reducer_ignores_unclassified_legacy_event_after_lifecycle_attachment() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        let revision = sessions.hook_revision(&session_id);

        let mut legacy = codex_event(session_id, "hook", None);
        legacy.event = AgentHookEventKind::NeedsInput;
        legacy.lifecycle_id = None;
        assert!(matches!(
            reducer.apply(legacy).expect("legacy event is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_transcript_observation_is_non_authoritative_for_any_provider() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Antigravity".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Antigravity);
        let session_id = session.id;
        sessions.insert(session);
        let reducer = AgentHookReducer::new(sessions.clone());

        assert!(matches!(
            reducer
                .apply(AgentHookEvent {
                    session_id,
                    provider: SessionAgentProvider::Antigravity,
                    event: AgentHookEventKind::NeedsInput,
                    message: None,
                    source: Some("transcript".to_string()),
                    lifecycle_id: None,
                    provider_session_id: None,
                    provider_turn_id: None,
                    provider_tool_id: None,
                    provider_version: None,
                    native_hooks_enabled: None,
                    ownership: AgentHookOwnership::Owner,
                })
                .expect("transcript event applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert_eq!(sessions.hook_revision(&session_id), 0);
        assert!(!sessions.is_hook_confirmed_this_run(&session_id));
        assert_eq!(sessions.hook_provider(&session_id), None);
    }

    #[test]
    fn antigravity_transcript_fallback_yields_to_confirmed_native_events() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Antigravity".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Antigravity);
        let session_id = session.id;
        sessions.insert(session);
        let reducer = AgentHookReducer::new(sessions.clone());

        let event = |event, source: &str| AgentHookEvent {
            session_id,
            provider: SessionAgentProvider::Antigravity,
            event,
            message: None,
            source: Some(source.to_string()),
            lifecycle_id: None,
            provider_session_id: None,
            provider_turn_id: None,
            provider_tool_id: None,
            provider_version: None,
            native_hooks_enabled: None,
            ownership: AgentHookOwnership::Owner,
        };

        assert!(matches!(
            reducer
                .apply(event(AgentHookEventKind::NeedsInput, "hook"))
                .expect("native event applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert!(sessions.is_hook_confirmed_this_run(&session_id));
        assert_eq!(
            sessions.agent_status_source(&session_id),
            Some(AgentStatusSource::Hook)
        );

        assert!(matches!(
            reducer
                .apply(event(AgentHookEventKind::Start, "transcript"))
                .expect("delayed transcript event is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
        assert_eq!(
            sessions.agent_status_source(&session_id),
            Some(AgentStatusSource::Hook)
        );

        let boot_sessions = acorn_session::SessionStore::new();
        let mut persisted = Session::new(
            "Antigravity".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        persisted.status = SessionStatus::WaitingForInput;
        persisted.agent_provider = Some(SessionAgentProvider::Antigravity);
        persisted.hook_active = true;
        persisted.hook_provider = Some(SessionAgentProvider::Antigravity);
        let boot_session_id = persisted.id;
        boot_sessions.insert(persisted);
        let boot_reducer = AgentHookReducer::new(boot_sessions.clone());
        let boot_fallback = AgentHookEvent {
            session_id: boot_session_id,
            provider: SessionAgentProvider::Antigravity,
            event: AgentHookEventKind::Start,
            message: None,
            source: Some("transcript".to_string()),
            lifecycle_id: None,
            provider_session_id: None,
            provider_turn_id: None,
            provider_tool_id: None,
            provider_version: None,
            native_hooks_enabled: None,
            ownership: AgentHookOwnership::Owner,
        };

        assert!(!boot_sessions.is_hook_confirmed_this_run(&boot_session_id));
        assert!(matches!(
            boot_reducer
                .apply(boot_fallback)
                .expect("unconfirmed boot fallback applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert!(!boot_sessions.is_hook_confirmed_this_run(&boot_session_id));
        assert_eq!(
            boot_sessions.agent_status_source(&boot_session_id),
            Some(AgentStatusSource::TranscriptFallback)
        );
    }

    #[test]
    fn reducer_transcript_provider_switch_allows_the_matching_native_claim() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Ready;
        session.agent_provider = Some(SessionAgentProvider::Claude);
        session.hook_provider = Some(SessionAgentProvider::Claude);
        session.hook_active = true;
        let session_id = session.id;
        sessions.insert(session);
        let reducer = AgentHookReducer::new(sessions.clone());

        let event = |source: &str| AgentHookEvent {
            session_id,
            provider: SessionAgentProvider::Antigravity,
            event: AgentHookEventKind::Start,
            message: None,
            source: Some(source.to_string()),
            lifecycle_id: None,
            provider_session_id: None,
            provider_turn_id: None,
            provider_tool_id: None,
            provider_version: None,
            native_hooks_enabled: None,
            ownership: AgentHookOwnership::Owner,
        };

        assert!(matches!(
            reducer
                .apply(event("transcript"))
                .expect("transcript provider switch applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        let observed = sessions.get(&session_id).expect("session");
        assert_eq!(
            observed.agent_provider,
            Some(SessionAgentProvider::Antigravity)
        );
        assert_eq!(observed.hook_provider, None);
        assert!(!observed.hook_active);
        assert_eq!(sessions.hook_revision(&session_id), 0);

        assert!(matches!(
            reducer
                .apply(event("hook"))
                .expect("matching native provider claims the session"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(
            sessions.hook_provider(&session_id),
            Some(SessionAgentProvider::Antigravity)
        );
        assert_eq!(sessions.hook_revision(&session_id), 1);
    }

    #[test]
    fn reducer_provider_switch_retires_the_previous_codex_lifecycle() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("codex-turn-1"));
        apply_codex(&reducer, session_id, "native_stop", Some("codex-turn-1"));

        let other_provider_event = |source: &str, event: AgentHookEventKind| AgentHookEvent {
            session_id,
            provider: SessionAgentProvider::Antigravity,
            event,
            message: None,
            source: Some(source.to_string()),
            lifecycle_id: None,
            provider_session_id: None,
            provider_turn_id: None,
            provider_tool_id: None,
            provider_version: None,
            native_hooks_enabled: None,
            ownership: AgentHookOwnership::Owner,
        };
        reducer
            .apply(other_provider_event(
                "transcript",
                AgentHookEventKind::Start,
            ))
            .expect("transcript provider switch applies");
        reducer
            .apply(other_provider_event("hook", AgentHookEventKind::NeedsInput))
            .expect("new provider wait applies");

        let mut delayed_codex = codex_event(session_id, "native_prompt", Some("delayed-turn"));
        delayed_codex.lifecycle_id = Some("lifecycle-1".to_string());
        assert!(matches!(
            reducer
                .apply(delayed_codex)
                .expect("old Codex lifecycle is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );

        let mut new_codex = codex_event(session_id, "native_prompt", Some("codex-turn-2"));
        new_codex.lifecycle_id = Some("lifecycle-2".to_string());
        assert!(matches!(
            reducer
                .apply(new_codex)
                .expect("new Codex lifecycle can claim the resting session"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
    }

    #[test]
    fn reducer_native_prompt_claims_a_matching_cross_provider_fallback_boundary() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Ready;
        session.agent_provider = Some(SessionAgentProvider::Claude);
        session.hook_provider = Some(SessionAgentProvider::Claude);
        session.hook_active = true;
        let session_id = session.id;
        sessions.insert(session);
        let reducer = AgentHookReducer::new(sessions.clone());

        let mut fallback = codex_event(session_id, "jsonl_user", None);
        fallback.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer.apply(fallback).expect("fallback boundary applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").agent_provider,
            Some(SessionAgentProvider::Claude)
        );

        let mut prompt = codex_event(session_id, "native_prompt", Some("turn-1"));
        prompt.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer
                .apply(prompt)
                .expect("native prompt claims boundary"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        let stored = sessions.get(&session_id).expect("session");
        assert_eq!(stored.agent_provider, Some(SessionAgentProvider::Codex));
        assert_eq!(stored.hook_provider, Some(SessionAgentProvider::Codex));

        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Ready;
        session.agent_provider = Some(SessionAgentProvider::Claude);
        session.hook_provider = Some(SessionAgentProvider::Claude);
        let session_id = session.id;
        sessions.insert(session);
        let reducer = AgentHookReducer::new(sessions);
        reducer
            .apply(codex_event(session_id, "jsonl_user", None))
            .expect("fallback boundary applies");
        let mut unrelated = codex_event(session_id, "native_prompt", Some("turn-1"));
        unrelated.lifecycle_id = Some("unrelated-lifecycle".to_string());
        assert!(matches!(
            reducer.apply(unrelated),
            Err(super::AgentHookApplyError::Conflict(_))
        ));
    }

    #[test]
    fn reducer_matches_idless_finished_counterparts_in_fifo_order() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_stop", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-2"));

        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_user", None),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );

        apply_codex(&reducer, session_id, "native_stop", Some("turn-2"));
        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_user", None),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );

        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_user", None),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
    }

    #[test]
    fn reducer_rotates_provider_session_on_new_owner_prompt() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_stop", Some("turn-1"));

        let mut new_session = codex_event(session_id, "native_prompt", Some("turn-2"));
        new_session.provider_session_id = Some("provider-session-2".to_string());
        assert!(matches!(
            reducer
                .apply(new_session)
                .expect("new session prompt applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));

        assert!(matches!(
            apply_codex(&reducer, session_id, "native_stop", Some("turn-1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );

        for provider_turn_id in [None, Some("retired-turn-without-session")] {
            let mut ambiguous = codex_event(session_id, "jsonl_user", provider_turn_id);
            ambiguous.provider_session_id = None;
            ambiguous.native_hooks_enabled = Some(true);
            assert!(matches!(
                reducer
                    .apply(ambiguous)
                    .expect("idless recorder line is classified"),
                AgentHookApplyOutcome::Ignored { .. }
            ));
        }

        let mut new_stop = codex_event(session_id, "native_stop", Some("turn-2"));
        new_stop.provider_session_id = Some("provider-session-2".to_string());
        assert!(matches!(
            reducer.apply(new_stop).expect("new session stop applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
    }

    #[test]
    fn reducer_rotates_provider_session_from_matching_fallback_completion() {
        for native_hooks_enabled in [None, Some(false), Some(true)] {
            let (sessions, session_id, reducer) = codex_reducer_fixture();
            let fallback_event = |source: &str,
                                  provider_session_id: Option<&str>,
                                  provider_turn_id: Option<&str>| {
                let mut event = codex_event(session_id, source, provider_turn_id);
                event.provider_session_id = provider_session_id.map(str::to_string);
                event.native_hooks_enabled = native_hooks_enabled;
                event
            };

            reducer
                .apply(fallback_event("jsonl_user", None, None))
                .expect("first fallback user applies");
            reducer
                .apply(fallback_event("jsonl_task", None, Some("turn-1")))
                .expect("first fallback task applies");
            assert!(matches!(
                reducer
                    .apply(fallback_event(
                        "legacy_completion",
                        Some("provider-session-1"),
                        Some("turn-1"),
                    ))
                    .expect("first fallback completion applies"),
                AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
            ));

            reducer
                .apply(fallback_event("jsonl_user", None, None))
                .expect("new-session fallback user applies");
            reducer
                .apply(fallback_event("jsonl_task", None, Some("turn-2")))
                .expect("new-session fallback task applies");
            assert!(matches!(
                reducer
                    .apply(fallback_event(
                        "legacy_completion",
                        Some("provider-session-2"),
                        Some("wrong-turn"),
                    ))
                    .expect("mismatched completion is classified"),
                AgentHookApplyOutcome::Ignored { .. }
            ));
            assert_eq!(
                sessions.get(&session_id).expect("session").status,
                SessionStatus::Working
            );
            assert!(matches!(
                reducer
                    .apply(fallback_event(
                        "legacy_completion",
                        Some("provider-session-2"),
                        Some("turn-2"),
                    ))
                    .expect("new-session fallback completion applies"),
                AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
            ));
            assert_eq!(
                sessions.get(&session_id).expect("session").status,
                SessionStatus::WaitingForInput
            );

            assert!(matches!(
                reducer
                    .apply(fallback_event(
                        "legacy_completion",
                        Some("provider-session-1"),
                        Some("turn-1"),
                    ))
                    .expect("retired completion is classified"),
                AgentHookApplyOutcome::Ignored { .. }
            ));
            assert!(matches!(
                reducer
                    .apply(fallback_event("jsonl_user", None, None))
                    .expect("next idless fallback user applies"),
                AgentHookApplyOutcome::Applied(SessionStatus::Working)
            ));
        }
    }

    #[test]
    fn reducer_fallback_approval_recovers_a_missed_permission_hook() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        let mut native_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        native_tool.provider_tool_id = Some("tool-1".to_string());
        reducer.apply(native_tool).expect("tool start applies");

        let mut fallback = codex_event(session_id, "jsonl_approval", Some("turn-1"));
        fallback.provider_tool_id = Some("tool-1".to_string());
        assert!(matches!(
            reducer.apply(fallback).expect("fallback approval applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_matching_jsonl_tool_resumes_after_native_permission() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));

        let mut pre_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        pre_tool.provider_tool_id = Some("tool-1".to_string());
        reducer.apply(pre_tool).expect("pre-tool hook applies");
        apply_codex(&reducer, session_id, "native_permission", Some("turn-1"));
        assert!(sessions.codex_permission_waiting_at(&session_id).is_some());

        let mut tool_start = codex_event(session_id, "jsonl_tool", Some("turn-1"));
        tool_start.provider_tool_id = Some("tool-1".to_string());
        assert!(matches!(
            reducer
                .apply(tool_start)
                .expect("matching fallback tool applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
        assert_eq!(sessions.codex_permission_waiting_at(&session_id), None);
    }

    #[test]
    fn reducer_matching_jsonl_tool_resumes_when_fallback_permission_arrives_first() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));

        let mut pre_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        pre_tool.provider_tool_id = Some("tool-1".to_string());
        reducer.apply(pre_tool).expect("pre-tool hook applies");

        let mut fallback_permission = codex_event(session_id, "jsonl_approval", Some("turn-1"));
        fallback_permission.provider_tool_id = Some("tool-1".to_string());
        reducer
            .apply(fallback_permission)
            .expect("fallback permission applies");
        apply_codex(&reducer, session_id, "native_permission", Some("turn-1"));

        let mut tool_start = codex_event(session_id, "jsonl_tool", Some("turn-1"));
        tool_start.provider_tool_id = Some("tool-1".to_string());
        assert!(matches!(
            reducer
                .apply(tool_start)
                .expect("matching fallback tool applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(sessions.codex_permission_waiting_at(&session_id), None);
    }

    #[test]
    fn reducer_delayed_duplicate_tool_cannot_clear_other_input_request() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));

        let mut old_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        old_tool.provider_tool_id = Some("tool-a".to_string());
        reducer.apply(old_tool).expect("old tool starts");

        let mut user_input = codex_event(session_id, "native_permission", Some("turn-1"));
        user_input.provider_tool_id = Some("input-b".to_string());
        reducer.apply(user_input).expect("input request waits");

        let mut delayed_tool = codex_event(session_id, "jsonl_tool", Some("turn-1"));
        delayed_tool.provider_tool_id = Some("tool-a".to_string());
        assert!(matches!(
            reducer
                .apply(delayed_tool)
                .expect("delayed duplicate tool is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
        assert!(sessions.codex_permission_waiting_at(&session_id).is_some());
    }

    #[test]
    fn reducer_permission_receipts_do_not_cross_tool_requests() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_permission", Some("turn-1"));
        let mut first_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        first_tool.provider_tool_id = Some("tool-a".to_string());
        reducer.apply(first_tool).expect("first tool resumes");

        let mut second_approval = codex_event(session_id, "jsonl_approval", Some("turn-1"));
        second_approval.provider_tool_id = Some("tool-b".to_string());
        assert!(matches!(
            reducer
                .apply(second_approval)
                .expect("second approval fallback applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));

        let mut late_first_approval = codex_event(session_id, "jsonl_approval", Some("turn-1"));
        late_first_approval.provider_tool_id = Some("tool-a".to_string());
        assert!(matches!(
            reducer
                .apply(late_first_approval)
                .expect("late first approval is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_request_user_input_receipt_cannot_claim_the_next_tool_permission() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        let mut user_input = codex_event(session_id, "native_permission", Some("turn-1"));
        user_input.provider_tool_id = Some("input-a".to_string());
        reducer.apply(user_input).expect("request_user_input waits");

        let mut next_tool = codex_event(session_id, "native_tool_start", Some("turn-1"));
        next_tool.provider_tool_id = Some("tool-b".to_string());
        reducer.apply(next_tool).expect("next tool starts");

        let mut missed_permission = codex_event(session_id, "jsonl_approval", Some("turn-1"));
        missed_permission.provider_tool_id = Some("tool-b".to_string());
        assert!(matches!(
            reducer
                .apply(missed_permission)
                .expect("fallback permission applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_permission_receipts_handle_fallback_before_native() {
        let (_sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_approval", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_permission", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_tool_start", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
    }

    #[test]
    fn reducer_reopens_only_the_latest_finished_turn_for_trusted_activity() {
        let (_sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_stop", Some("turn-1"));
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_tool_start", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        apply_codex(&reducer, session_id, "native_stop", Some("turn-1"));
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_permission", Some("turn-1")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));

        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_stop", Some("turn-1"));
        apply_codex(&reducer, session_id, "native_prompt", Some("turn-2"));
        apply_codex(&reducer, session_id, "native_stop", Some("turn-2"));
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_tool_start", Some("turn-1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_child_fallback_cannot_replace_or_bind_the_owner_turn() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("owner-turn"));
        let mut child_task = codex_event(session_id, "jsonl_task", Some("child-turn"));
        child_task.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer
                .apply(child_task)
                .expect("child fallback is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        let mut child_native = codex_event(session_id, "native_permission", Some("child-turn"));
        child_native.native_hooks_enabled = Some(true);
        child_native.ownership = AgentHookOwnership::Child;
        reducer
            .apply(child_native)
            .expect("native child callback is classified");
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_stop", Some("owner-turn")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_task_only_fallback_cannot_replace_a_finished_owner() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(&reducer, session_id, "native_prompt", Some("owner-turn"));
        apply_codex(&reducer, session_id, "native_stop", Some("owner-turn"));

        let mut task = codex_event(session_id, "jsonl_task", Some("unowned-turn"));
        task.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer.apply(task).expect("fallback task is classified"),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_capability_without_native_receipt_preserves_fallback() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        let mut provisional = codex_event(session_id, "jsonl_user", None);
        provisional.native_hooks_enabled = Some(true);
        reducer
            .apply(provisional)
            .expect("provisional owner starts");

        let mut task = codex_event(session_id, "jsonl_task", Some("fallback-turn"));
        task.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer.apply(task).expect("fallback task applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));

        let mut approval = codex_event(session_id, "jsonl_approval", Some("fallback-turn"));
        approval.provider_tool_id = Some("tool-1".to_string());
        approval.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer.apply(approval).expect("fallback approval applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));

        let mut tool = codex_event(session_id, "jsonl_tool", Some("fallback-turn"));
        tool.provider_tool_id = Some("tool-1".to_string());
        tool.native_hooks_enabled = Some(true);
        assert!(matches!(
            reducer.apply(tool).expect("fallback tool applies"),
            AgentHookApplyOutcome::Applied(SessionStatus::Working)
        ));
        assert_eq!(sessions.codex_permission_waiting_at(&session_id), None);

        let mut owner_prompt = codex_event(session_id, "native_prompt", Some("fallback-turn"));
        owner_prompt.native_hooks_enabled = Some(true);
        reducer.apply(owner_prompt).expect("owner prompt binds");
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_stop", Some("fallback-turn")),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
    }

    #[test]
    fn hook_server_maps_reducer_owner_child_malformed_and_unavailable_outcomes() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        let hooks =
            AgentHookServer::start_with_outcome_handler(move |event| reducer.apply(event).into())
                .expect("hook server starts");
        let owner = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "opaque-owner-turn",
            "hook_event_name": "UserPromptSubmit"
        })
        .to_string();
        assert!(
            post_raw_codex_hook(&hooks, session_id, &owner).starts_with("HTTP/1.1 204 No Content")
        );

        let child = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "opaque-child-turn",
            "hook_event_name": "PermissionRequest",
            "agent_id": "child-1",
            "agent_type": "worker"
        })
        .to_string();
        assert!(
            post_raw_codex_hook(&hooks, session_id, &child).starts_with("HTTP/1.1 202 Accepted")
        );

        let malformed = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "opaque-turn",
            "hook_event_name": "PermissionRequest",
            "agent_id": null
        })
        .to_string();
        assert!(post_raw_codex_hook(&hooks, session_id, &malformed)
            .starts_with("HTTP/1.1 400 Bad Request"));

        assert!(post_raw_codex_hook(&hooks, Uuid::new_v4(), &owner)
            .starts_with("HTTP/1.1 503 Service Unavailable"));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn raw_codex_fallback_sources_preserve_provider_ids() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        for (source, body, expected_kind) in [
            (
                "jsonl_user",
                r#"{"session_id":"provider-session","turn_id":"turn-u"}"#,
                AgentHookEventKind::Start,
            ),
            (
                "jsonl_task",
                r#"{"payload":{"thread_id":"provider-session","turn_id":"turn-t"}}"#,
                AgentHookEventKind::Start,
            ),
            (
                "jsonl_tool",
                r#"{"msg":{"thread_id":"provider-session","turn_id":"turn-x","call_id":"tool-x"}}"#,
                AgentHookEventKind::Start,
            ),
            (
                "jsonl_approval",
                r#"{"msg":{"thread_id":"provider-session","turn_id":"turn-a","call_id":"tool-a"}}"#,
                AgentHookEventKind::NeedsInput,
            ),
            (
                "legacy_completion",
                r#"{"type":"agent-turn-complete","thread-id":"provider-session","turn-id":"12345"}"#,
                AgentHookEventKind::NeedsInput,
            ),
        ] {
            let response = post_raw_codex_source(&hooks, session_id, source, body);
            assert!(response.starts_with("HTTP/1.1 204 No Content"));
            let event = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("fallback event delivered");
            assert_eq!(event.source.as_deref(), Some(source));
            assert_eq!(event.event, expected_kind);
            assert!(event.provider_turn_id.is_some());
        }
    }

    #[test]
    fn raw_pre_tool_use_request_user_input_maps_to_waiting() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let body = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "opaque-turn",
            "hook_event_name": "PreToolUse",
            "tool_name": "request_user_input",
            "tool_use_id": "input-1"
        })
        .to_string();
        assert!(post_raw_codex_hook(&hooks, Uuid::new_v4(), &body)
            .starts_with("HTTP/1.1 204 No Content"));
        let event = rx.recv_timeout(Duration::from_secs(1)).expect("event");
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.source.as_deref(), Some("native_permission"));
        assert_eq!(event.provider_tool_id.as_deref(), Some("input-1"));
    }

    #[test]
    fn raw_codex_approval_payloads_preserve_supported_ids_without_envelope_shadowing() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        for (body, expected_tool_id) in [
            (
                r#"{"id":"envelope-id","msg":{"call_id":"tool-call"}}"#,
                "tool-call",
            ),
            (r#"{"approval_id":"approval-1"}"#, "approval-1"),
            (
                r#"{"payload":{"msg":{"approval_id":"approval-2"}}}"#,
                "approval-2",
            ),
            (
                r#"{"call_id":" ","msg":{"call_id":"tool-after-blank"}}"#,
                "tool-after-blank",
            ),
        ] {
            assert!(
                post_raw_codex_source(&hooks, session_id, "jsonl_approval", body)
                    .starts_with("HTTP/1.1 204 No Content")
            );
            let event = rx.recv_timeout(Duration::from_secs(1)).expect("event");
            assert_eq!(event.provider_tool_id.as_deref(), Some(expected_tool_id));
        }

        let oversized = "x".repeat(513);
        let body = serde_json::json!({
            "call_id": oversized,
            "payload": { "call_id": "tool-after-oversized" }
        })
        .to_string();
        assert!(
            post_raw_codex_source(&hooks, session_id, "jsonl_approval", &body)
                .starts_with("HTTP/1.1 204 No Content")
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("event")
                .provider_tool_id
                .as_deref(),
            Some("tool-after-oversized")
        );

        let prompt = serde_json::json!({
            "session_id": "provider-session",
            "turn_id": "turn-1",
            "hook_event_name": "UserPromptSubmit",
            "id": "generic-event-id"
        })
        .to_string();
        assert!(
            post_raw_codex_hook(&hooks, session_id, &prompt).starts_with("HTTP/1.1 204 No Content")
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("event")
                .provider_tool_id,
            None
        );
    }

    #[test]
    fn raw_codex_native_hooks_capability_header_is_strictly_parsed() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let body = r#"{"session_id":"provider-session","turn_id":"turn-1"}"#;

        for (header, expected) in [
            (Some("1"), Some(true)),
            (Some("0"), Some(false)),
            (None, None),
        ] {
            assert!(post_raw_codex_source_with_capability(
                &hooks,
                session_id,
                "jsonl_user",
                body,
                header,
            )
            .starts_with("HTTP/1.1 204 No Content"));
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(1))
                    .expect("event")
                    .native_hooks_enabled,
                expected
            );
        }

        assert!(post_raw_codex_source_with_capability(
            &hooks,
            session_id,
            "jsonl_user",
            body,
            Some("maybe"),
        )
        .starts_with("HTTP/1.1 400 Bad Request"));
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
    }

    fn codex_reducer_fixture() -> (
        Arc<acorn_session::SessionStore>,
        Uuid,
        Arc<AgentHookReducer>,
    ) {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);
        let reducer = Arc::new(AgentHookReducer::new(sessions.clone()));
        (sessions, session_id, reducer)
    }

    fn apply_codex(
        reducer: &AgentHookReducer,
        session_id: Uuid,
        source: &str,
        provider_turn_id: Option<&str>,
    ) -> AgentHookApplyOutcome {
        reducer
            .apply(codex_event(session_id, source, provider_turn_id))
            .expect("event is classified")
    }

    fn codex_event(
        session_id: Uuid,
        source: &str,
        provider_turn_id: Option<&str>,
    ) -> AgentHookEvent {
        let event = match source {
            "native_stop" | "native_permission" | "jsonl_approval" | "legacy_completion" => {
                AgentHookEventKind::NeedsInput
            }
            _ => AgentHookEventKind::Start,
        };
        AgentHookEvent {
            session_id,
            provider: SessionAgentProvider::Codex,
            event,
            message: None,
            source: Some(source.to_string()),
            lifecycle_id: Some("lifecycle-1".to_string()),
            provider_session_id: Some("provider-session".to_string()),
            provider_turn_id: provider_turn_id.map(str::to_string),
            provider_tool_id: None,
            provider_version: Some("0.144.4".to_string()),
            native_hooks_enabled: None,
            ownership: AgentHookOwnership::Owner,
        }
    }

    fn post(hooks: &AgentHookServer, token: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("write request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    }

    fn post_raw_codex_hook(hooks: &AgentHookServer, session_id: Uuid, body: &str) -> String {
        post_raw_codex_source(hooks, session_id, "native", body)
    }

    fn post_raw_claude_hook(hooks: &AgentHookServer, session_id: Uuid, body: &str) -> String {
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: {}\r\nX-Acorn-Agent-Hook-Provider: claude\r\nX-Acorn-Agent-Hook-Session-Id: {session_id}\r\nX-Acorn-Agent-Hook-Source: native\r\nContent-Length: {}\r\n\r\n{body}",
            hooks.token(),
            body.len()
        )
        .expect("write raw Claude request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    }

    fn post_raw_codex_source(
        hooks: &AgentHookServer,
        session_id: Uuid,
        source: &str,
        body: &str,
    ) -> String {
        post_raw_codex_source_with_capability(hooks, session_id, source, body, None)
    }

    fn post_raw_codex_source_with_capability(
        hooks: &AgentHookServer,
        session_id: Uuid,
        source: &str,
        body: &str,
        native_hooks_enabled: Option<&str>,
    ) -> String {
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        let capability_header = native_hooks_enabled
            .map(|value| format!("X-Acorn-Codex-Native-Hooks-Enabled: {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: {}\r\nX-Acorn-Agent-Hook-Provider: codex\r\nX-Acorn-Agent-Hook-Session-Id: {session_id}\r\nX-Acorn-Agent-Hook-Source: {source}\r\nX-Acorn-Codex-Lifecycle-Id: lifecycle-1\r\nX-Acorn-Codex-Version: 0.144.4\r\n{capability_header}Content-Length: {}\r\n\r\n{body}",
            hooks.token(),
            body.len()
        )
        .expect("write raw Codex request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    }

    fn addr_from_url(url: &str) -> SocketAddr {
        let raw = url
            .strip_prefix("http://")
            .and_then(|rest| rest.strip_suffix("/agent-hook"))
            .expect("expected hook url shape");
        raw.parse().expect("parse hook addr")
    }
}
