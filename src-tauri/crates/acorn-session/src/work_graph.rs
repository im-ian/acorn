use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::SessionAgentProvider;

pub const GRAPH_PROMPT_PLAN_VERSION: u32 = 1;
pub const GRAPH_PROMPT_CONTINUATION_VERSION: u32 = 1;
pub const WORK_GRAPH_VERSION: u32 = 1;
pub const WORK_GRAPH_GOAL_ID: &str = "goal";
pub const SESSION_GRAPH_CANVAS_VERSION: u32 = 1;
pub const SESSION_GRAPH_VERSION: u32 = 1;

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
    pub nodes: Vec<WorkGraphNode>,
    pub edges: Vec<WorkGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkGraphNode {
    pub id: String,
    pub kind: WorkGraphNodeKind,
    pub title: String,
    pub instruction: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkGraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<SessionGraphViewport>,
}

impl Default for SessionGraphCanvas {
    fn default() -> Self {
        Self {
            version: SESSION_GRAPH_CANVAS_VERSION,
            node_positions: BTreeMap::new(),
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
