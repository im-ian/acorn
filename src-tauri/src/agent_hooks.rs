use std::collections::VecDeque;
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

type HookEventHandler = Arc<dyn Fn(AgentHookEvent) + Send + Sync + 'static>;

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
    #[serde(default)]
    pub provider_turn_id: Option<String>,
    #[serde(default)]
    pub provider_tool_id: Option<String>,
    #[serde(default)]
    pub provider_version: Option<String>,
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

    pub fn apply(&self, event: AgentHookEvent) -> Result<AgentHookApplyOutcome, String> {
        let lane = self
            .lanes
            .entry(event.session_id)
            .or_insert_with(|| Arc::new(Mutex::new(HookLane::default())))
            .clone();
        let mut lane = lane.lock();
        let current_status = validate_agent_hook_event(&self.sessions, &event)?.status;

        if event.provider != SessionAgentProvider::Codex {
            let status = apply_validated_agent_hook_event(
                &self.sessions,
                event,
                CodexStoreEffects::default(),
            )?;
            return Ok(AgentHookApplyOutcome::Applied(status));
        }

        if event.lifecycle_id.is_none() && lane.codex.current.is_some() {
            return Ok(AgentHookApplyOutcome::Ignored {
                status: current_status,
                reason: "missing lifecycle id after lifecycle attachment",
            });
        }

        let signal = match CodexSignal::from_event(&event)? {
            Some(signal) => signal,
            None => {
                let effects = legacy_codex_store_effects(&event);
                let status = apply_validated_agent_hook_event(&self.sessions, event, effects)?;
                return Ok(AgentHookApplyOutcome::Applied(status));
            }
        };

        let Some(lifecycle_id) = event.lifecycle_id.as_deref() else {
            let effects = legacy_codex_store_effects(&event);
            let status = apply_validated_agent_hook_event(&self.sessions, event, effects)?;
            return Ok(AgentHookApplyOutcome::Applied(status));
        };

        let transition = match lane.codex.reduce(lifecycle_id, signal, &event) {
            CodexReduction::Apply(effects) => effects,
            CodexReduction::Ignore(reason) => {
                return Ok(AgentHookApplyOutcome::Ignored {
                    status: current_status,
                    reason,
                });
            }
        };
        let status = apply_validated_agent_hook_event(&self.sessions, event, transition)?;
        Ok(AgentHookApplyOutcome::Applied(status))
    }
}

#[derive(Default)]
struct HookLane {
    codex: CodexLane,
}

#[derive(Default)]
struct CodexLane {
    current: Option<CodexInvocation>,
    retired_lifecycle_ids: VecDeque<String>,
}

struct CodexInvocation {
    lifecycle_id: String,
    turn: Option<CodexTurn>,
    last_finished: Option<FinishedCodexTurn>,
    recent_finished_turn_ids: VecDeque<String>,
}

struct CodexTurn {
    provider_turn_id: Option<String>,
    phase: CodexTurnPhase,
    native_prompt_seen: bool,
    jsonl_user_seen: bool,
    jsonl_task_seen: bool,
    completed_native_tool_ids: VecDeque<String>,
}

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

#[derive(Clone, Copy)]
enum CodexSignal {
    NativePrompt,
    NativeStop,
    NativePermission,
    NativeToolComplete,
    JsonlUser,
    JsonlTask,
    JsonlTool,
    JsonlApproval,
    LegacyCompletion,
}

impl CodexSignal {
    fn from_event(event: &AgentHookEvent) -> Result<Option<Self>, String> {
        let Some(source) = event.source.as_deref() else {
            return Ok(None);
        };
        let signal = match source {
            "native_prompt" if event.event == AgentHookEventKind::Start => Self::NativePrompt,
            "native_stop" if event.event == AgentHookEventKind::NeedsInput => Self::NativeStop,
            "native_permission" if event.event == AgentHookEventKind::NeedsInput => {
                Self::NativePermission
            }
            "native_tool_complete" if event.event == AgentHookEventKind::Start => {
                Self::NativeToolComplete
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
                return Err(format!(
                    "invalid Codex source/event combination: {source}/{:?}",
                    event.event
                ));
            }
            _ => return Ok(None),
        };
        Ok(Some(signal))
    }

    fn can_replace_lifecycle(self) -> bool {
        matches!(self, Self::NativePrompt | Self::JsonlUser | Self::JsonlTask)
    }
}

enum CodexReduction {
    Apply(CodexStoreEffects),
    Ignore(&'static str),
}

#[derive(Default)]
struct CodexStoreEffects {
    begin_turn: bool,
    mark_tool_started: bool,
    mark_permission_waiting: bool,
    clear_permission_waiting: bool,
}

impl CodexLane {
    fn reduce(
        &mut self,
        lifecycle_id: &str,
        signal: CodexSignal,
        event: &AgentHookEvent,
    ) -> CodexReduction {
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
        }
        let invocation = self.current.get_or_insert_with(|| CodexInvocation {
            lifecycle_id: lifecycle_id.to_string(),
            turn: None,
            last_finished: None,
            recent_finished_turn_ids: VecDeque::new(),
        });
        invocation.reduce(
            signal,
            event.provider_turn_id.as_deref(),
            event.provider_tool_id.as_deref(),
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
        if provider_turn_id.is_some_and(|id| self.is_finished(id)) {
            let id = provider_turn_id.expect("finished turn id is present");
            let resumes_latest_tentative_stop = self.turn.is_none()
                && self
                    .last_finished
                    .as_ref()
                    .and_then(|finished| finished.provider_turn_id.as_deref())
                    == Some(id)
                && matches!(
                    signal,
                    CodexSignal::NativePermission | CodexSignal::NativeToolComplete
                );
            if !resumes_latest_tentative_stop {
                return CodexReduction::Ignore("event belongs to a finished turn");
            }
            self.recent_finished_turn_ids
                .retain(|finished| finished != id);
            self.last_finished = None;
            self.turn = Some(new_codex_turn(provider_turn_id, false));
        }

        match signal {
            CodexSignal::NativePrompt => self.start_or_merge_native_prompt(provider_turn_id),
            CodexSignal::NativeStop | CodexSignal::LegacyCompletion => {
                self.finish_turn(provider_turn_id)
            }
            CodexSignal::NativePermission => self.await_permission(provider_turn_id),
            CodexSignal::JsonlApproval => {
                if self.is_completed_native_tool(provider_turn_id, provider_tool_id) {
                    CodexReduction::Ignore("late JSONL approval for completed native tool")
                } else {
                    self.await_permission(provider_turn_id)
                }
            }
            CodexSignal::NativeToolComplete => {
                self.resume_from_tool(provider_turn_id, false, provider_tool_id)
            }
            CodexSignal::JsonlTool => self.resume_from_tool(provider_turn_id, true, None),
            CodexSignal::JsonlUser => self.observe_jsonl_start(provider_turn_id, true),
            CodexSignal::JsonlTask => self.observe_jsonl_start(provider_turn_id, false),
        }
    }

    fn start_or_merge_native_prompt(&mut self, provider_turn_id: Option<&str>) -> CodexReduction {
        if let Some(turn) = self.turn.as_mut() {
            if turn.native_prompt_seen
                || turn_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
            {
                self.turn = Some(new_codex_turn(provider_turn_id, true));
                return CodexReduction::Apply(CodexStoreEffects {
                    begin_turn: true,
                    clear_permission_waiting: true,
                    ..Default::default()
                });
            }
            if turn.phase == CodexTurnPhase::AwaitingPermission {
                turn.native_prompt_seen = true;
                return CodexReduction::Ignore("late prompt for permission-waiting turn");
            }
            attach_turn_id(turn, provider_turn_id);
            turn.native_prompt_seen = true;
            return CodexReduction::Apply(CodexStoreEffects {
                clear_permission_waiting: true,
                ..Default::default()
            });
        }

        self.turn = Some(new_codex_turn(provider_turn_id, true));
        CodexReduction::Apply(CodexStoreEffects {
            begin_turn: true,
            clear_permission_waiting: true,
            ..Default::default()
        })
    }

    fn finish_turn(&mut self, provider_turn_id: Option<&str>) -> CodexReduction {
        if self.turn.is_none() && provider_turn_id.is_none() && self.last_finished.is_some() {
            return CodexReduction::Ignore("duplicate unidentified completion");
        }
        if self.turn.as_ref().is_some_and(|turn| {
            turn_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
        }) {
            return CodexReduction::Ignore("completion belongs to another turn");
        }

        let finished = if let Some(mut turn) = self.turn.take() {
            attach_turn_id(&mut turn, provider_turn_id);
            FinishedCodexTurn {
                provider_turn_id: turn.provider_turn_id,
                consume_jsonl_user: !turn.jsonl_user_seen,
                consume_jsonl_task: !turn.jsonl_task_seen,
            }
        } else {
            FinishedCodexTurn {
                provider_turn_id: provider_turn_id.map(str::to_string),
                consume_jsonl_user: true,
                consume_jsonl_task: true,
            }
        };
        if let Some(id) = finished.provider_turn_id.clone() {
            push_bounded(&mut self.recent_finished_turn_ids, id, 8);
        }
        self.last_finished = Some(finished);
        CodexReduction::Apply(CodexStoreEffects {
            clear_permission_waiting: true,
            ..Default::default()
        })
    }

    fn await_permission(&mut self, provider_turn_id: Option<&str>) -> CodexReduction {
        let begin_turn = match self.turn.as_ref() {
            Some(turn) if turn_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id) => {
                true
            }
            None => true,
            _ => false,
        };
        if begin_turn {
            self.turn = Some(new_codex_turn(provider_turn_id, false));
        }
        let turn = self.turn.as_mut().expect("turn established");
        attach_turn_id(turn, provider_turn_id);
        turn.phase = CodexTurnPhase::AwaitingPermission;
        CodexReduction::Apply(CodexStoreEffects {
            begin_turn,
            mark_permission_waiting: true,
            ..Default::default()
        })
    }

    fn resume_from_tool(
        &mut self,
        provider_turn_id: Option<&str>,
        mark_tool_started: bool,
        completed_native_tool_id: Option<&str>,
    ) -> CodexReduction {
        if self.turn.is_none() && provider_turn_id.is_none() && self.last_finished.is_some() {
            return CodexReduction::Ignore("unidentified tool event after finished turn");
        }
        let begin_turn = match self.turn.as_ref() {
            Some(turn) if turn_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id) => {
                true
            }
            None => true,
            _ => false,
        };
        if begin_turn {
            self.turn = Some(new_codex_turn(provider_turn_id, false));
        }
        let turn = self.turn.as_mut().expect("turn established");
        attach_turn_id(turn, provider_turn_id);
        turn.phase = CodexTurnPhase::Working;
        if let Some(tool_id) = completed_native_tool_id {
            push_bounded(&mut turn.completed_native_tool_ids, tool_id.to_string(), 16);
        }
        CodexReduction::Apply(CodexStoreEffects {
            begin_turn,
            mark_tool_started,
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
            if provider_turn_id.is_none() {
                if let Some(finished) = self.last_finished.as_mut() {
                    let consume = if user_signal {
                        &mut finished.consume_jsonl_user
                    } else {
                        &mut finished.consume_jsonl_task
                    };
                    if *consume {
                        *consume = false;
                        return CodexReduction::Ignore("late unidentified JSONL counterpart");
                    }
                }
            }
            let mut turn = new_codex_turn(provider_turn_id, false);
            if user_signal {
                turn.jsonl_user_seen = true;
            } else {
                turn.jsonl_task_seen = true;
            }
            self.turn = Some(turn);
            return CodexReduction::Apply(CodexStoreEffects {
                begin_turn: true,
                clear_permission_waiting: true,
                ..Default::default()
            });
        }

        if self.turn.as_ref().is_some_and(|turn| {
            turn_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
        }) {
            let mut turn = new_codex_turn(provider_turn_id, false);
            if user_signal {
                turn.jsonl_user_seen = true;
            } else {
                turn.jsonl_task_seen = true;
            }
            self.turn = Some(turn);
            return CodexReduction::Apply(CodexStoreEffects {
                begin_turn: true,
                clear_permission_waiting: true,
                ..Default::default()
            });
        }

        let turn = self.turn.as_mut().expect("turn exists");
        attach_turn_id(turn, provider_turn_id);
        if user_signal {
            turn.jsonl_user_seen = true;
        } else {
            turn.jsonl_task_seen = true;
        }
        if turn.phase == CodexTurnPhase::AwaitingPermission {
            return CodexReduction::Ignore("lagging JSONL start during permission wait");
        }
        CodexReduction::Apply(CodexStoreEffects::default())
    }

    fn is_finished(&self, provider_turn_id: &str) -> bool {
        self.recent_finished_turn_ids
            .iter()
            .any(|finished| finished == provider_turn_id)
    }

    fn is_completed_native_tool(
        &self,
        provider_turn_id: Option<&str>,
        provider_tool_id: Option<&str>,
    ) -> bool {
        let Some(provider_tool_id) = provider_tool_id else {
            return false;
        };
        self.turn.as_ref().is_some_and(|turn| {
            !turn_ids_conflict(turn.provider_turn_id.as_deref(), provider_turn_id)
                && turn
                    .completed_native_tool_ids
                    .iter()
                    .any(|completed| completed == provider_tool_id)
        })
    }
}

fn new_codex_turn(provider_turn_id: Option<&str>, native_prompt_seen: bool) -> CodexTurn {
    CodexTurn {
        provider_turn_id: provider_turn_id.map(str::to_string),
        phase: CodexTurnPhase::Working,
        native_prompt_seen,
        jsonl_user_seen: false,
        jsonl_task_seen: false,
        completed_native_tool_ids: VecDeque::new(),
    }
}

fn attach_turn_id(turn: &mut CodexTurn, provider_turn_id: Option<&str>) {
    if turn.provider_turn_id.is_none() {
        turn.provider_turn_id = provider_turn_id.map(str::to_string);
    }
}

fn turn_ids_conflict(current: Option<&str>, incoming: Option<&str>) -> bool {
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

#[cfg(test)]
fn apply_agent_hook_event(
    sessions: &SessionStore,
    event: AgentHookEvent,
) -> Result<SessionStatus, String> {
    validate_agent_hook_event(sessions, &event)?;
    let effects = legacy_codex_store_effects(&event);
    apply_validated_agent_hook_event(sessions, event, effects)
}

fn validate_agent_hook_event(
    sessions: &SessionStore,
    event: &AgentHookEvent,
) -> Result<acorn_session::Session, String> {
    let session = sessions
        .get(&event.session_id)
        .map_err(|_| format!("session not found: {}", event.session_id))?;
    // A terminal can carry stale live-provider metadata from a resting agent.
    // Accept a provider switch only from a resting session; while the owner is
    // Working, mismatched provider events are nested agent activity.
    if let Some(provider) = session.agent_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session =
                event_can_switch_provider(event) && session.status != SessionStatus::Working;
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
            let provider_switch_from_resting_session =
                event_can_switch_provider(event) && session.status != SessionStatus::Working;
            if !provider_switch_from_resting_session {
                return Err(format!(
                    "hook provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                ));
            }
        }
    }

    Ok(session)
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
        Some("turn" | "native_turn" | "native_prompt" | "jsonl_user" | "jsonl_task")
    )
}

fn apply_validated_agent_hook_event(
    sessions: &SessionStore,
    event: AgentHookEvent,
    effects: CodexStoreEffects,
) -> Result<SessionStatus, String> {
    if event.provider == SessionAgentProvider::Codex {
        if effects.begin_turn {
            sessions.begin_hook_turn(&event.session_id);
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

    // Mark the hook channel live so the transcript-tail status poll defers
    // turn-boundary classification to these events instead of clobbering a
    // just-set resting status (Ready/WaitingForInput) back to Working on its
    // next tick. See `poll_defers_to_hook` in `commands`.
    sessions.mark_hook_active(&event.session_id, event.provider);

    let status = event.event.session_status();
    sessions
        .refresh_status(&event.session_id, status)
        .map_err(|err| err.to_string())?;
    Ok(status)
}

fn legacy_codex_store_effects(event: &AgentHookEvent) -> CodexStoreEffects {
    if event.provider != SessionAgentProvider::Codex {
        return CodexStoreEffects::default();
    }
    match (event.source.as_deref(), event.event) {
        (Some("turn" | "native_turn"), AgentHookEventKind::Start) => CodexStoreEffects {
            begin_turn: true,
            clear_permission_waiting: true,
            ..Default::default()
        },
        (Some("tool"), AgentHookEventKind::Start) => CodexStoreEffects {
            mark_tool_started: true,
            clear_permission_waiting: true,
            ..Default::default()
        },
        (Some("approval"), AgentHookEventKind::NeedsInput) => CodexStoreEffects {
            mark_permission_waiting: true,
            ..Default::default()
        },
        (_, AgentHookEventKind::Stop | AgentHookEventKind::Error) => CodexStoreEffects {
            clear_permission_waiting: true,
            ..Default::default()
        },
        _ => CodexStoreEffects::default(),
    }
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

    pub fn start_with_handler<F>(handler: F) -> io::Result<Self>
    where
        F: Fn(AgentHookEvent) + Send + Sync + 'static,
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
        tracing::warn!(error = %spawn_error, "agent hook worker thread failed to start");
        match fallback_stream {
            Ok(stream) => {
                if let Err(err) = handle_connection(stream, &token, &handler) {
                    tracing::warn!(error = %err, "agent hook inline fallback failed");
                }
            }
            Err(clone_error) => {
                tracing::warn!(error = %clone_error, "agent hook connection could not be retained");
            }
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    handler: &HookEventHandler,
) -> io::Result<()> {
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
        Ok(None) => return HttpStatus::NoContent,
        Err(err) => {
            tracing::warn!(error = %err, "agent hook payload rejected");
            return HttpStatus::BadRequest;
        }
    };
    handler(event);
    HttpStatus::NoContent
}

fn parse_agent_hook_request(head: &str, body: &[u8]) -> Result<Option<AgentHookEvent>, String> {
    match header_value(head, "x-acorn-agent-hook-provider") {
        Some("codex") => parse_raw_codex_hook_request(head, body),
        Some(provider) => Err(format!("unsupported raw hook provider: {provider}")),
        None => serde_json::from_slice::<AgentHookEvent>(body)
            .map(Some)
            .map_err(|err| err.to_string()),
    }
}

fn parse_raw_codex_hook_request(head: &str, body: &[u8]) -> Result<Option<AgentHookEvent>, String> {
    let session_id = header_value(head, "x-acorn-agent-hook-session-id")
        .ok_or_else(|| "missing Acorn session id".to_string())?
        .parse::<Uuid>()
        .map_err(|_| "invalid Acorn session id".to_string())?;
    let source = header_value(head, "x-acorn-agent-hook-source")
        .ok_or_else(|| "missing Codex hook source".to_string())?;
    let lifecycle_id = header_value(head, "x-acorn-codex-lifecycle-id")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let provider_version = header_value(head, "x-acorn-codex-version")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let payload = serde_json::from_slice::<Value>(body).map_err(|err| err.to_string())?;
    if payload
        .get("agent_id")
        .is_some_and(|agent_id| !agent_id.is_null())
    {
        return Ok(None);
    }

    let event = match source {
        "native_prompt" => {
            expect_codex_hook_name(&payload, "UserPromptSubmit")?;
            AgentHookEventKind::Start
        }
        "native_stop" => {
            expect_codex_hook_name(&payload, "Stop")?;
            AgentHookEventKind::NeedsInput
        }
        "native_permission" => {
            expect_codex_hook_name(&payload, "PermissionRequest")?;
            AgentHookEventKind::NeedsInput
        }
        "native_tool_complete" => {
            expect_codex_hook_name(&payload, "PostToolUse")?;
            AgentHookEventKind::Start
        }
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
        _ => return Err(format!("unsupported Codex hook source: {source}")),
    };

    Ok(Some(AgentHookEvent {
        session_id,
        provider: SessionAgentProvider::Codex,
        event,
        message: None,
        source: Some(source.to_string()),
        lifecycle_id,
        provider_session_id: codex_payload_string(
            &payload,
            &[
                "/session_id",
                "/thread-id",
                "/msg/thread_id",
                "/payload/thread_id",
            ],
        ),
        provider_turn_id: codex_payload_string(
            &payload,
            &["/turn_id", "/turn-id", "/msg/turn_id", "/payload/turn_id"],
        ),
        provider_tool_id: match source {
            "native_tool_complete" => codex_payload_string(&payload, &["/tool_use_id"]),
            "jsonl_approval" => {
                codex_payload_string(&payload, &["/call_id", "/msg/call_id", "/payload/call_id"])
            }
            _ => None,
        },
        provider_version,
    }))
}

fn expect_codex_hook_name(payload: &Value, expected: &str) -> Result<(), String> {
    match payload.get("hook_event_name").and_then(Value::as_str) {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(format!(
            "Codex hook source expected {expected}, received {actual}"
        )),
        None => Err("Codex hook payload has no hook_event_name".to_string()),
    }
}

fn codex_payload_string(payload: &Value, pointers: &[&str]) -> Option<String> {
    pointers
        .iter()
        .find_map(|pointer| payload.pointer(pointer).and_then(Value::as_str))
        .map(str::to_string)
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
    NoContent,
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    PayloadTooLarge,
}

impl HttpStatus {
    fn code(&self) -> u16 {
        match self {
            Self::NoContent => 204,
            Self::BadRequest => 400,
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::PayloadTooLarge => 413,
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::NoContent => "No Content",
            Self::BadRequest => "Bad Request",
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
        AgentHookEvent, AgentHookEventKind, AgentHookReducer, AgentHookServer, HookEventHandler,
    };
    use acorn_session::{Session, SessionAgentProvider, SessionKind, SessionStatus};
    use std::io::{self, Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::sync::{mpsc, Arc, Barrier};
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
    fn hook_server_drop_releases_the_listener_before_returning() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let addr = addr_from_url(hooks.hook_url());
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );
        assert!(post(&hooks, hooks.token(), &body).starts_with("HTTP/1.1 204 No Content"));

        // Give the accept loop time to return to its nonblocking poll. Drop
        // must still join it instead of leaving the port and thread alive.
        std::thread::sleep(Duration::from_millis(20));
        drop(hooks);

        assert!(
            TcpStream::connect(addr).is_err(),
            "hook listener remained reachable after server drop"
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
    fn hook_connection_waits_for_bytes_on_an_inherited_nonblocking_socket() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "test-token".to_string();
        let (tx, rx) = mpsc::channel();
        let handler: HookEventHandler = Arc::new(move |event| {
            tx.send(event).expect("send event");
        });
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"start\"}}"
        );

        let client = std::thread::spawn(move || -> io::Result<String> {
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
    fn hook_server_rejects_invalid_token_and_accepts_valid_token() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );

        let invalid = post(&hooks, "invalid", &body);
        assert!(
            invalid.starts_with("HTTP/1.1 401 Unauthorized"),
            "unexpected invalid-token response: {invalid:?}"
        );

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
        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected native-hook response: {response:?}"
        );

        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("event delivered");
        assert_eq!(event.session_id, session_id);
        assert_eq!(event.provider, SessionAgentProvider::Codex);
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.message.as_deref(), Some("ready"));
        assert_eq!(event.lifecycle_id, None);
        assert_eq!(event.provider_turn_id, None);
    }

    #[test]
    fn hook_server_normalizes_raw_codex_native_payload() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let body = r#"{"session_id":"provider-session","turn_id":"turn-7","hook_event_name":"PermissionRequest","tool_name":"Bash"}"#;

        let response = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "native_permission",
            "lifecycle-2",
            "0.144.4",
            body,
        );
        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected raw native-hook response: {response:?}"
        );

        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("event delivered");
        assert_eq!(event.session_id, session_id);
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.source.as_deref(), Some("native_permission"));
        assert_eq!(event.lifecycle_id.as_deref(), Some("lifecycle-2"));
        assert_eq!(
            event.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(event.provider_turn_id.as_deref(), Some("turn-7"));
        assert_eq!(event.provider_version.as_deref(), Some("0.144.4"));

        let body = r#"{"session_id":"provider-session","turn_id":"turn-7","hook_event_name":"PostToolUse","tool_use_id":"tool-7","tool_name":"Bash"}"#;
        let response = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "native_tool_complete",
            "lifecycle-2",
            "0.144.4",
            body,
        );
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("post-tool event delivered");
        assert_eq!(event.provider_tool_id.as_deref(), Some("tool-7"));
    }

    #[test]
    fn hook_server_normalizes_codex_legacy_and_jsonl_fallback_ids() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        let legacy = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "legacy_completion",
            "lifecycle-2",
            "0.144.4",
            r#"{"type":"agent-turn-complete","thread-id":"provider-session","turn-id":"turn-7"}"#,
        );
        assert!(legacy.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("legacy event delivered");
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.source.as_deref(), Some("legacy_completion"));
        assert_eq!(
            event.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(event.provider_turn_id.as_deref(), Some("turn-7"));

        let jsonl = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "jsonl_tool",
            "lifecycle-2",
            "0.144.4",
            r#"{"dir":"to_tui","kind":"codex_event","msg":{"type":"exec_command_begin","turn_id":"turn-8","call_id":"tool-8"}}"#,
        );
        assert!(jsonl.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("JSONL event delivered");
        assert_eq!(event.event, AgentHookEventKind::Start);
        assert_eq!(event.source.as_deref(), Some("jsonl_tool"));
        assert_eq!(event.provider_turn_id.as_deref(), Some("turn-8"));
        assert_eq!(event.provider_tool_id, None);

        let approval = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "jsonl_approval",
            "lifecycle-2",
            "0.144.4",
            r#"{"dir":"to_tui","kind":"codex_event","msg":{"type":"exec_approval_request","turn_id":"turn-8","call_id":"tool-8"}}"#,
        );
        assert!(approval.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("JSONL approval delivered");
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.provider_tool_id.as_deref(), Some("tool-8"));
    }

    #[test]
    fn hook_server_rejects_mismatched_codex_native_source() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let response = post_with_codex_headers(
            &hooks,
            hooks.token(),
            Uuid::new_v4(),
            "native_stop",
            "lifecycle-2",
            "0.144.4",
            r#"{"session_id":"provider-session","turn_id":"turn-7","hook_event_name":"UserPromptSubmit"}"#,
        );

        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn hook_server_accepts_large_documented_codex_payloads() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let prompt = "x".repeat(32 * 1024);
        let body = serde_json::json!({
            "session_id": "provider-session",
            "turn_id": "turn-7",
            "hook_event_name": "UserPromptSubmit",
            "prompt": prompt,
        })
        .to_string();

        let response = post_with_codex_headers(
            &hooks,
            hooks.token(),
            Uuid::new_v4(),
            "native_prompt",
            "lifecycle-2",
            "0.144.4",
            &body,
        );

        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected response: {response:?}"
        );
    }

    #[test]
    fn hook_server_ignores_subagent_events_but_accepts_null_agent_id() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        let subagent = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "native_permission",
            "lifecycle-2",
            "0.144.4",
            r#"{"session_id":"provider-session","turn_id":"turn-sub","agent_id":"agent-1","hook_event_name":"PermissionRequest"}"#,
        );
        assert!(subagent.starts_with("HTTP/1.1 204 No Content"));
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());

        let root = post_with_codex_headers(
            &hooks,
            hooks.token(),
            session_id,
            "native_prompt",
            "lifecycle-2",
            "0.144.4",
            r#"{"session_id":"provider-session","turn_id":"turn-root","agent_id":null,"hook_event_name":"UserPromptSubmit"}"#,
        );
        assert!(root.starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("root event delivered")
                .provider_turn_id
                .as_deref(),
            Some("turn-root")
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
                lifecycle_id: None,
                provider_session_id: None,
                provider_turn_id: None,
                provider_tool_id: None,
                provider_version: None,
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
                lifecycle_id: None,
                provider_session_id: None,
                provider_turn_id: None,
                provider_tool_id: None,
                provider_version: None,
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
                lifecycle_id: None,
                provider_session_id: None,
                provider_turn_id: None,
                provider_tool_id: None,
                provider_version: None,
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
                    lifecycle_id: None,
                    provider_session_id: None,
                    provider_turn_id: None,
                    provider_tool_id: None,
                    provider_version: None,
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

        apply("tool", AgentHookEventKind::Start);
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        apply("native_turn", AgentHookEventKind::Start);
        assert_eq!(sessions.hook_tool_started_at(&session_id), None);
    }

    #[test]
    fn reducer_native_stop_suppresses_late_jsonl_for_the_same_turn() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();

        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"));
        let revision = sessions.hook_revision(&session_id);

        for source in ["jsonl_task", "jsonl_tool"] {
            assert!(matches!(
                apply_codex(&reducer, session_id, source, "run-1", Some("turn-1")),
                AgentHookApplyOutcome::Ignored { .. }
            ));
        }

        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_native_stop_wins_over_concurrent_jsonl_tool_start() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );

        let barrier = Arc::new(Barrier::new(3));
        let stop = {
            let reducer = reducer.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"))
            })
        };
        let tool = {
            let reducer = reducer.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                apply_codex(&reducer, session_id, "jsonl_tool", "run-1", Some("turn-1"))
            })
        };
        barrier.wait();
        stop.join().expect("stop thread");
        tool.join().expect("tool thread");

        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_native_activity_can_continue_after_a_tentative_stop() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"));

        apply_codex(
            &reducer,
            session_id,
            "native_tool_complete",
            "run-1",
            Some("turn-1"),
        );

        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_recovers_individual_missing_native_edges_from_fallbacks() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();

        apply_codex(&reducer, session_id, "jsonl_task", "run-1", Some("turn-1"));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );

        apply_codex(
            &reducer,
            session_id,
            "legacy_completion",
            "run-1",
            Some("turn-1"),
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_permission_wait_ignores_lagging_start_and_resumes_on_tool() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(
            &reducer,
            session_id,
            "native_permission",
            "run-1",
            Some("turn-1"),
        );

        assert!(sessions.codex_permission_waiting_at(&session_id).is_some());
        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_task", "run-1", Some("turn-1")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );

        apply_codex(&reducer, session_id, "jsonl_tool", "run-1", Some("turn-1"));
        assert_eq!(sessions.codex_permission_waiting_at(&session_id), None);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_tool_resume_ignores_a_matching_lagging_jsonl_approval() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(
            &reducer,
            session_id,
            "native_permission",
            "run-1",
            Some("turn-1"),
        );
        apply_codex_with_tool_id(
            &reducer,
            session_id,
            "native_tool_complete",
            "run-1",
            Some("turn-1"),
            Some("tool-1"),
        );

        assert!(matches!(
            apply_codex_with_tool_id(
                &reducer,
                session_id,
                "jsonl_approval",
                "run-1",
                Some("turn-1"),
                Some("tool-1"),
            ),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(sessions.codex_permission_waiting_at(&session_id), None);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_tool_resume_keeps_a_different_jsonl_approval() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex_with_tool_id(
            &reducer,
            session_id,
            "native_tool_complete",
            "run-1",
            Some("turn-1"),
            Some("tool-1"),
        );

        assert!(matches!(
            apply_codex_with_tool_id(
                &reducer,
                session_id,
                "jsonl_approval",
                "run-1",
                Some("turn-1"),
                Some("tool-2"),
            ),
            AgentHookApplyOutcome::Applied(SessionStatus::WaitingForInput)
        ));
        assert!(sessions.codex_permission_waiting_at(&session_id).is_some());
    }

    #[test]
    fn reducer_late_tool_from_finished_turn_cannot_clear_current_permission_wait() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-old"),
        );
        apply_codex(
            &reducer,
            session_id,
            "native_stop",
            "run-1",
            Some("turn-old"),
        );
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-current"),
        );
        apply_codex(
            &reducer,
            session_id,
            "native_permission",
            "run-1",
            Some("turn-current"),
        );
        let waiting_revision = sessions.hook_revision(&session_id);
        let permission_requested_at = sessions.codex_permission_waiting_at(&session_id);

        assert!(matches!(
            apply_codex(
                &reducer,
                session_id,
                "native_tool_complete",
                "run-1",
                Some("turn-old"),
            ),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(sessions.hook_revision(&session_id), waiting_revision);
        assert_eq!(
            sessions.codex_permission_waiting_at(&session_id),
            permission_requested_at
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_old_turn_and_retired_lifecycle_cannot_overwrite_current_turn() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"));
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-2"),
        );

        assert!(matches!(
            apply_codex(
                &reducer,
                session_id,
                "legacy_completion",
                "run-1",
                Some("turn-1"),
            ),
            AgentHookApplyOutcome::Ignored { .. }
        ));

        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-2",
            Some("turn-3"),
        );
        assert!(matches!(
            apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-2")),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_consumes_unidentified_jsonl_backlog_before_recovering_next_turn() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"));

        assert!(matches!(
            apply_codex(&reducer, session_id, "jsonl_user", "run-1", None),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        apply_codex(&reducer, session_id, "jsonl_user", "run-1", None);

        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_ignores_old_payloads_after_lifecycle_attachment() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"));
        let revision = sessions.hook_revision(&session_id);

        let outcome = reducer
            .apply(AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("tool".to_string()),
                lifecycle_id: None,
                provider_session_id: None,
                provider_turn_id: None,
                provider_tool_id: None,
                provider_version: None,
            })
            .expect("old event is classified");

        assert!(matches!(outcome, AgentHookApplyOutcome::Ignored { .. }));
        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn reducer_native_prompt_starts_a_new_turn_when_stop_was_missed() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "jsonl_tool", "run-1", Some("turn-1"));
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        apply_codex(&reducer, session_id, "native_prompt", "run-1", None);

        assert_eq!(sessions.hook_tool_started_at(&session_id), None);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_unknown_lifecycle_completion_cannot_retire_the_current_run() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-2",
            Some("turn-2"),
        );

        assert!(matches!(
            apply_codex(
                &reducer,
                session_id,
                "native_stop",
                "unseen-run-1",
                Some("turn-1"),
            ),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_idless_duplicate_completion_does_not_reset_jsonl_backlog() {
        let (sessions, session_id, reducer) = codex_reducer_fixture();
        apply_codex(
            &reducer,
            session_id,
            "native_prompt",
            "run-1",
            Some("turn-1"),
        );
        apply_codex(&reducer, session_id, "native_stop", "run-1", Some("turn-1"));
        apply_codex(&reducer, session_id, "jsonl_user", "run-1", None);

        assert!(matches!(
            apply_codex(&reducer, session_id, "legacy_completion", "run-1", None,),
            AgentHookApplyOutcome::Ignored { .. }
        ));
        apply_codex(&reducer, session_id, "jsonl_user", "run-1", None);

        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn reducer_codex_tool_cannot_take_over_a_waiting_claude_session() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Claude".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::WaitingForInput;
        session.agent_provider = Some(SessionAgentProvider::Claude);
        session.hook_provider = Some(SessionAgentProvider::Claude);
        let session_id = session.id;
        sessions.insert(session);
        let reducer = AgentHookReducer::new(sessions.clone());

        let error = reducer
            .apply(AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("native_tool_complete".to_string()),
                lifecycle_id: Some("run-1".to_string()),
                provider_session_id: Some("provider-session".to_string()),
                provider_turn_id: Some("turn-1".to_string()),
                provider_tool_id: Some("tool-1".to_string()),
                provider_version: Some("0.144.4".to_string()),
            })
            .expect_err("tool event cannot switch provider ownership");

        assert!(error.contains("provider mismatch"));
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
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
        lifecycle_id: &str,
        provider_turn_id: Option<&str>,
    ) -> AgentHookApplyOutcome {
        apply_codex_with_tool_id(
            reducer,
            session_id,
            source,
            lifecycle_id,
            provider_turn_id,
            None,
        )
    }

    fn apply_codex_with_tool_id(
        reducer: &AgentHookReducer,
        session_id: Uuid,
        source: &str,
        lifecycle_id: &str,
        provider_turn_id: Option<&str>,
        provider_tool_id: Option<&str>,
    ) -> AgentHookApplyOutcome {
        let event = match source {
            "native_stop" | "native_permission" | "legacy_completion" | "jsonl_approval" => {
                AgentHookEventKind::NeedsInput
            }
            _ => AgentHookEventKind::Start,
        };
        reducer
            .apply(AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event,
                message: None,
                source: Some(source.to_string()),
                lifecycle_id: Some(lifecycle_id.to_string()),
                provider_session_id: Some("provider-session".to_string()),
                provider_turn_id: provider_turn_id.map(str::to_string),
                provider_tool_id: provider_tool_id.map(str::to_string),
                provider_version: Some("0.144.4".to_string()),
            })
            .expect("event applies")
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

    fn post_with_codex_headers(
        hooks: &AgentHookServer,
        token: &str,
        session_id: Uuid,
        source: &str,
        lifecycle_id: &str,
        version: &str,
        body: &str,
    ) -> String {
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: {token}\r\nX-Acorn-Agent-Hook-Provider: codex\r\nX-Acorn-Agent-Hook-Session-Id: {session_id}\r\nX-Acorn-Agent-Hook-Source: {source}\r\nX-Acorn-Codex-Lifecycle-Id: {lifecycle_id}\r\nX-Acorn-Codex-Version: {version}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("write request");
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
