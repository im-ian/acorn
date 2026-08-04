use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::SessionAgentProvider;

pub const GRAPH_PROMPT_PLAN_VERSION: u32 = 1;
pub const GRAPH_PROMPT_CONTINUATION_VERSION: u32 = 1;
pub const LEGACY_WORK_GRAPH_VERSION: u32 = 1;
pub const WORK_GRAPH_VERSION: u32 = 2;
pub const WORK_GRAPH_GOAL_ID: &str = "goal";
pub const SESSION_GRAPH_CANVAS_VERSION: u32 = 2;
pub const SESSION_GRAPH_VERSION: u32 = 1;
pub const GRAPH_RUN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphPromptContinuation {
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum GraphPromptPlan {
    Automatic {
        version: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continuation: Option<GraphPromptContinuation>,
    },
    Manual {
        version: u32,
        graph: WorkGraph,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continuation: Option<GraphPromptContinuation>,
    },
}

impl GraphPromptPlan {
    pub fn automatic() -> Self {
        Self::Automatic {
            version: GRAPH_PROMPT_PLAN_VERSION,
            continuation: None,
        }
    }

    pub fn version(&self) -> u32 {
        match self {
            Self::Automatic { version, .. } | Self::Manual { version, .. } => *version,
        }
    }

    pub fn continuation(&self) -> Option<&GraphPromptContinuation> {
        match self {
            Self::Automatic { continuation, .. } | Self::Manual { continuation, .. } => {
                continuation.as_ref()
            }
        }
    }

    pub fn without_continuation(&self) -> Self {
        match self {
            Self::Automatic { version, .. } => Self::Automatic {
                version: *version,
                continuation: None,
            },
            Self::Manual { version, graph, .. } => Self::Manual {
                version: *version,
                graph: graph.clone(),
                continuation: None,
            },
        }
    }

    pub fn as_continuation(&self) -> Self {
        match self.without_continuation() {
            Self::Automatic { version, .. } => Self::Automatic {
                version,
                continuation: Some(GraphPromptContinuation {
                    version: GRAPH_PROMPT_CONTINUATION_VERSION,
                }),
            },
            Self::Manual { version, graph, .. } => Self::Manual {
                version,
                graph,
                continuation: Some(GraphPromptContinuation {
                    version: GRAPH_PROMPT_CONTINUATION_VERSION,
                }),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkGraph {
    pub version: u32,
    #[serde(default, skip_serializing_if = "is_parallel_execution_mode")]
    pub execution_mode: WorkGraphExecutionMode,
    pub nodes: Vec<WorkGraphNode>,
    pub edges: Vec<WorkGraphEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<WorkGraphGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkGraphNode {
    pub id: String,
    pub kind: WorkGraphNodeKind,
    pub title: String,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<WorkGraphExecutionMode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkGraphNodeKind {
    Agent,
    Validator,
    Merge,
    Human,
    GoalSink,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkGraphExecutionMode {
    #[default]
    Parallel,
    Sequential,
}

fn is_parallel_execution_mode(mode: &WorkGraphExecutionMode) -> bool {
    *mode == WorkGraphExecutionMode::Parallel
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum WorkGraphGroupDirection {
    #[serde(rename = "LR")]
    LeftToRight,
    #[serde(rename = "TD")]
    TopDown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkGraphGroupGenerationMode {
    Fixed,
    Prompt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkGraphGroupGeneration {
    pub mode: WorkGraphGroupGenerationMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkGraphGroup {
    pub id: String,
    pub title: String,
    pub direction: WorkGraphGroupDirection,
    pub execution_mode: WorkGraphExecutionMode,
    pub generation: WorkGraphGroupGeneration,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum WorkGraphEdgeCondition {
    #[default]
    Always,
    Pass,
    Fail,
    Approved,
    Rejected,
}

fn is_always_edge_condition(condition: &WorkGraphEdgeCondition) -> bool {
    *condition == WorkGraphEdgeCondition::Always
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum WorkGraphEdgeKind {
    #[default]
    Dependency,
    Retry,
}

fn is_dependency_edge_kind(kind: &WorkGraphEdgeKind) -> bool {
    *kind == WorkGraphEdgeKind::Dependency
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkGraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "is_always_edge_condition")]
    pub condition: WorkGraphEdgeCondition,
    #[serde(default, skip_serializing_if = "is_dependency_edge_kind")]
    pub kind: WorkGraphEdgeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionGraphAgent {
    pub provider: SessionAgentProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionGraphNodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionGraphViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

fn default_canvas_version() -> u32 {
    SESSION_GRAPH_CANVAS_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionGraphCanvas {
    #[serde(default = "default_canvas_version")]
    pub version: u32,
    #[serde(default)]
    pub node_positions: BTreeMap<String, SessionGraphNodePosition>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_positions: BTreeMap<String, SessionGraphNodePosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<SessionGraphViewport>,
}

impl Default for SessionGraphCanvas {
    fn default() -> Self {
        Self {
            version: SESSION_GRAPH_CANVAS_VERSION,
            node_positions: BTreeMap::new(),
            group_positions: BTreeMap::new(),
            viewport: None,
        }
    }
}

fn default_graph_revision() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionGraph {
    pub version: u32,
    pub objective: String,
    pub agent: SessionGraphAgent,
    pub definition: WorkGraph,
    #[serde(default)]
    pub canvas: SessionGraphCanvas,
    #[serde(default = "default_graph_revision")]
    pub revision: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GraphRunStatus {
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeRunStatus {
    Queued,
    Working,
    Waiting,
    Completed,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeVerdict {
    Pass,
    Fail,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphNodeRunAttempt {
    pub attempt: u32,
    pub status: GraphNodeRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub critique: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<GraphNodeVerdict>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphNodeRunState {
    pub node_id: String,
    pub status: GraphNodeRunStatus,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempts: Vec<GraphNodeRunAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<GraphNodeVerdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphEdgeRunState {
    pub edge_id: String,
    pub active: bool,
    pub traversed: bool,
    pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphRunState {
    pub schema_version: u32,
    pub session_id: String,
    pub run_id: String,
    /// Monotonic revision for optimistic Human-node input and cancellation.
    pub revision: u64,
    pub graph_revision: u32,
    pub objective: String,
    pub agent: SessionGraphAgent,
    pub status: GraphRunStatus,
    pub definition: WorkGraph,
    pub nodes: BTreeMap<String, GraphNodeRunState>,
    pub edges: BTreeMap<String, GraphEdgeRunState>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_output: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_v1_work_graph_deserializes_with_v2_defaults() {
        let graph: WorkGraph = serde_json::from_value(serde_json::json!({
            "version": 1,
            "nodes": [
                {"id":"build","kind":"agent","title":"Build","instruction":"Build it"},
                {"id":"goal","kind":"goal_sink","title":"GOAL","instruction":""}
            ],
            "edges": [{"id":"done","from":"build","to":"goal"}]
        }))
        .expect("legacy graph deserializes");

        assert_eq!(graph.execution_mode, WorkGraphExecutionMode::Parallel);
        assert!(graph.groups.is_empty());
        assert!(graph.nodes.iter().all(|node| node.group_id.is_none()));
        assert_eq!(graph.edges[0].kind, WorkGraphEdgeKind::Dependency);
        assert_eq!(graph.edges[0].condition, WorkGraphEdgeCondition::Always);
    }

    #[test]
    fn legacy_canvas_deserializes_without_group_positions() {
        let canvas: SessionGraphCanvas = serde_json::from_value(serde_json::json!({
            "version": 1,
            "node_positions": {"goal": {"x": 10.0, "y": 20.0}}
        }))
        .expect("legacy canvas deserializes");

        assert!(canvas.group_positions.is_empty());
        assert_eq!(canvas.version, 1);
    }
}
