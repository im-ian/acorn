//! Session-state primitives shared across the Acorn app and its sibling
//! tools. Pulled out of the main `acorn` crate so changes to unrelated
//! Tauri command surfaces do not force a recompile of these stable types.
//!
//! Three submodules:
//!
//! - [`session`] — `Project` / `Session` records and their in-memory stores.
//! - [`status`] — JSONL-transcript-tail parser that maps the last meaningful
//!   line to a `SessionStatus`.
//! - [`scrollback`] — per-session terminal scrollback persistence under a
//!   caller-provided data directory.

pub mod scrollback;
pub mod session;
pub mod status;
pub mod work_graph;

pub use session::{
    AgentStatusSource, Project, ProjectStore, Session, SessionAgentProvider, SessionError,
    SessionGoal, SessionGoalModelConfig, SessionGoalModelSelection, SessionGoalPolicies,
    SessionGoalPreset, SessionGoalProgress, SessionGoalRunState, SessionGoalStage,
    SessionGoalStageModels, SessionGoalStagePolicy, SessionKind, SessionMode, SessionOwner,
    SessionResult, SessionStatus, SessionStore, SessionTitleSource,
};
pub use work_graph::{
    GraphEdgeRunState, GraphNodeRunAttempt, GraphNodeRunState, GraphNodeRunStatus,
    GraphNodeVerdict, GraphPromptContinuation, GraphPromptPlan, GraphRunState, GraphRunStatus,
    SessionGraph, SessionGraphAgent, SessionGraphCanvas, SessionGraphNodePosition,
    SessionGraphViewport, WorkGraph, WorkGraphEdge, WorkGraphEdgeCondition, WorkGraphEdgeKind,
    WorkGraphExecutionMode, WorkGraphGroup, WorkGraphGroupDirection, WorkGraphGroupGeneration,
    WorkGraphGroupGenerationMode, WorkGraphNode, WorkGraphNodeKind,
    GRAPH_PROMPT_CONTINUATION_VERSION, GRAPH_PROMPT_PLAN_VERSION, GRAPH_RUN_SCHEMA_VERSION,
    LEGACY_WORK_GRAPH_VERSION, SESSION_GRAPH_CANVAS_VERSION, SESSION_GRAPH_VERSION,
    WORK_GRAPH_GOAL_ID, WORK_GRAPH_VERSION,
};
