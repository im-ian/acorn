use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

pub const GRAPH_PROMPT_PLAN_VERSION: u32 = 1;
pub const GRAPH_PROMPT_CONTINUATION_VERSION: u32 = 1;
pub const WORK_GRAPH_VERSION: u32 = 1;
pub const WORK_GRAPH_GOAL_ID: &str = "goal";
const MAX_NODES: usize = 24;
const MAX_EDGES: usize = 96;
const MAX_ID_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 120;
const MAX_INSTRUCTION_CHARS: usize = 1_200;
const MAX_TOTAL_INSTRUCTION_CHARS: usize = 8_000;
const MAX_CONTINUATION_CHECKPOINT_CHARS: usize = 8_000;

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

impl GraphPromptPlan {
    pub fn automatic() -> Self {
        Self::Automatic {
            version: GRAPH_PROMPT_PLAN_VERSION,
            continuation: None,
        }
    }

    fn version(&self) -> u32 {
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

fn valid_stable_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

pub fn validate_prompt_plan(plan: &GraphPromptPlan) -> Result<(), String> {
    if plan.version() != GRAPH_PROMPT_PLAN_VERSION {
        return Err(format!(
            "unsupported graph prompt plan version: {}",
            plan.version()
        ));
    }
    if let Some(continuation) = plan.continuation() {
        if continuation.version != GRAPH_PROMPT_CONTINUATION_VERSION {
            return Err(format!(
                "unsupported graph prompt continuation version: {}",
                continuation.version
            ));
        }
    }
    if let GraphPromptPlan::Manual { graph, .. } = plan {
        validate_work_graph(graph)?;
    }
    Ok(())
}

pub fn validate_work_graph(graph: &WorkGraph) -> Result<(), String> {
    if graph.version != WORK_GRAPH_VERSION {
        return Err(format!("unsupported work graph version: {}", graph.version));
    }
    if graph.nodes.len() > MAX_NODES {
        return Err(format!(
            "a work graph can contain at most {MAX_NODES} nodes"
        ));
    }
    if graph.edges.len() > MAX_EDGES {
        return Err(format!(
            "a work graph can contain at most {MAX_EDGES} edges"
        ));
    }

    let mut node_ids = BTreeSet::new();
    let mut goal_count = 0usize;
    let mut executable_count = 0usize;
    let mut total_instruction_chars = 0usize;
    for node in &graph.nodes {
        let id_chars = node.id.chars().count();
        if id_chars == 0 || id_chars > MAX_ID_CHARS || !valid_stable_id(&node.id) {
            return Err(format!("invalid stable node id: {}", node.id));
        }
        if !node_ids.insert(node.id.clone()) {
            return Err(format!("duplicate node id: {}", node.id));
        }
        if node.kind == WorkGraphNodeKind::GoalSink {
            goal_count += 1;
            if node.id != WORK_GRAPH_GOAL_ID || node.title != "GOAL" || !node.instruction.is_empty()
            {
                return Err("the GOAL node must use the fixed goal sink contract".to_string());
            }
            continue;
        }
        executable_count += 1;
        let title_chars = node.title.trim().chars().count();
        if title_chars == 0 || title_chars > MAX_TITLE_CHARS {
            return Err(format!("invalid title for node {}", node.id));
        }
        let instruction_chars = node.instruction.trim().chars().count();
        if instruction_chars == 0 || instruction_chars > MAX_INSTRUCTION_CHARS {
            return Err(format!("invalid instruction for node {}", node.id));
        }
        total_instruction_chars = total_instruction_chars.saturating_add(instruction_chars);
    }
    if total_instruction_chars > MAX_TOTAL_INSTRUCTION_CHARS {
        return Err("combined node instructions are too long".to_string());
    }
    if goal_count != 1 {
        return Err("a work graph must contain exactly one GOAL node".to_string());
    }
    if executable_count == 0 {
        return Err("a manual work graph needs at least one executable node".to_string());
    }
    if graph.edges.is_empty() {
        return Err("a manual work graph needs at least one execution edge".to_string());
    }

    let mut edge_ids = BTreeSet::new();
    let mut endpoint_pairs = BTreeSet::new();
    let mut outgoing: BTreeMap<&str, Vec<&str>> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), Vec::new()))
        .collect();
    let mut reverse: BTreeMap<&str, Vec<&str>> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), Vec::new()))
        .collect();
    let mut indegree: BTreeMap<&str, usize> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0))
        .collect();

    for edge in &graph.edges {
        let id_chars = edge.id.chars().count();
        if id_chars == 0 || id_chars > MAX_ID_CHARS || !valid_stable_id(&edge.id) {
            return Err(format!("invalid stable edge id: {}", edge.id));
        }
        if !edge_ids.insert(edge.id.clone()) {
            return Err(format!("duplicate edge id: {}", edge.id));
        }
        if !node_ids.contains(&edge.from) {
            return Err(format!(
                "edge {} has unknown source: {}",
                edge.id, edge.from
            ));
        }
        if !node_ids.contains(&edge.to) {
            return Err(format!("edge {} has unknown target: {}", edge.id, edge.to));
        }
        if edge.from == edge.to {
            return Err(format!("edge {} cannot connect a node to itself", edge.id));
        }
        if edge.from == WORK_GRAPH_GOAL_ID {
            return Err("GOAL cannot have outgoing edges".to_string());
        }
        if !endpoint_pairs.insert((edge.from.as_str(), edge.to.as_str())) {
            return Err(format!(
                "duplicate execution edge: {} -> {}",
                edge.from, edge.to
            ));
        }
        outgoing
            .get_mut(edge.from.as_str())
            .expect("known edge source")
            .push(edge.to.as_str());
        reverse
            .get_mut(edge.to.as_str())
            .expect("known edge target")
            .push(edge.from.as_str());
        *indegree
            .get_mut(edge.to.as_str())
            .expect("known edge target") += 1;
    }

    let mut ready: VecDeque<&str> = indegree
        .iter()
        .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
        .collect();
    let mut visited = 0usize;
    while let Some(id) = ready.pop_front() {
        visited += 1;
        for target in outgoing.get(id).into_iter().flatten() {
            let degree = indegree.get_mut(target).expect("known graph node");
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(target);
            }
        }
    }
    if visited != graph.nodes.len() {
        return Err("the work graph must be a DAG (cycles are not allowed)".to_string());
    }

    let mut reaches_goal = BTreeSet::new();
    let mut stack = vec![WORK_GRAPH_GOAL_ID];
    while let Some(id) = stack.pop() {
        if !reaches_goal.insert(id) {
            continue;
        }
        stack.extend(reverse.get(id).into_iter().flatten().copied());
    }
    if let Some(node) = graph.nodes.iter().find(|node| {
        node.kind != WorkGraphNodeKind::GoalSink && !reaches_goal.contains(node.id.as_str())
    }) {
        return Err(format!("node {} has no path to GOAL", node.id));
    }
    Ok(())
}

fn mermaid_text(value: &str) -> String {
    value
        .trim()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace("\r\n", "<br/>")
        .replace('\n', "<br/>")
        .replace('\r', "<br/>")
}

fn node_kind_label(kind: WorkGraphNodeKind) -> &'static str {
    match kind {
        WorkGraphNodeKind::Agent => "agent",
        WorkGraphNodeKind::Validator => "validator",
        WorkGraphNodeKind::Merge => "merge",
        WorkGraphNodeKind::Human => "human",
        WorkGraphNodeKind::GoalSink => "goal_sink",
    }
}

pub fn serialize_mermaid(graph: &WorkGraph) -> Result<String, String> {
    validate_work_graph(graph)?;
    let mut nodes = graph.nodes.iter().collect::<Vec<_>>();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let aliases: BTreeMap<&str, String> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), format!("n{index}")))
        .collect();
    let mut lines = vec!["flowchart TD".to_string()];
    for node in nodes {
        let alias = aliases.get(node.id.as_str()).expect("node alias");
        if node.kind == WorkGraphNodeKind::GoalSink {
            lines.push(format!("  {alias}((GOAL))"));
            continue;
        }
        let label = format!(
            "{}<br/>[{}] {}<br/>{}",
            mermaid_text(&node.id),
            node_kind_label(node.kind),
            mermaid_text(&node.title),
            mermaid_text(&node.instruction)
        );
        lines.push(format!("  {alias}[\"{label}\"]"));
    }
    let mut edges = graph.edges.iter().collect::<Vec<_>>();
    edges.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then_with(|| a.to.cmp(&b.to))
            .then_with(|| a.id.cmp(&b.id))
    });
    for edge in edges {
        lines.push(format!(
            "  {} --> {}",
            aliases.get(edge.from.as_str()).expect("source alias"),
            aliases.get(edge.to.as_str()).expect("target alias")
        ));
    }
    Ok(lines.join("\n"))
}

pub fn compile_prompt(raw_content: &str, plan: &GraphPromptPlan) -> Result<String, String> {
    compile_prompt_with_checkpoint(raw_content, plan, None)
}

pub fn compile_prompt_with_checkpoint(
    raw_content: &str,
    plan: &GraphPromptPlan,
    continuation_checkpoint: Option<&str>,
) -> Result<String, String> {
    validate_prompt_plan(plan)?;
    let checkpoint = if plan.continuation().is_some() {
        let checkpoint = continuation_checkpoint
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "graph prompt continuation requires the active WAITING checkpoint".to_string()
            })?;
        Some(bound_continuation_checkpoint(checkpoint))
    } else {
        None
    };
    match plan {
        GraphPromptPlan::Automatic {
            continuation: None, ..
        } => Ok(compile_automatic_prompt(raw_content)),
        GraphPromptPlan::Automatic {
            continuation: Some(_),
            ..
        } => Ok(compile_automatic_continuation_prompt(
            raw_content,
            checkpoint
                .as_deref()
                .expect("validated continuation checkpoint"),
        )),
        GraphPromptPlan::Manual {
            graph,
            continuation: None,
            ..
        } => compile_manual_prompt(raw_content, graph),
        GraphPromptPlan::Manual {
            graph,
            continuation: Some(_),
            ..
        } => compile_manual_continuation_prompt(
            raw_content,
            graph,
            checkpoint
                .as_deref()
                .expect("validated continuation checkpoint"),
        ),
    }
}

fn bound_continuation_checkpoint(value: &str) -> String {
    let character_count = value.chars().count();
    if character_count <= MAX_CONTINUATION_CHECKPOINT_CHARS {
        return value.to_string();
    }
    const MARKER: &str = "\n...[checkpoint middle omitted by Acorn]...\n";
    let remaining = MAX_CONTINUATION_CHECKPOINT_CHARS.saturating_sub(MARKER.chars().count());
    let head_chars = remaining / 2;
    let tail_chars = remaining - head_chars;
    let head = value.chars().take(head_chars).collect::<String>();
    let mut tail = value.chars().rev().take(tail_chars).collect::<Vec<_>>();
    tail.reverse();
    format!("{head}{MARKER}{}", tail.into_iter().collect::<String>())
}

fn compile_automatic_prompt(raw_content: &str) -> String {
    format!(
        "<acorn_graph_engineering version=\"1\" mode=\"automatic\">\n\
USER REQUEST (preserve its intent exactly):\n{raw_content}\n\n\
Apply the layer decision before acting; the first yes wins:\n\
1. LAYER: prompt — one model response is enough. Answer directly.\n\
2. LAYER: loop — one agent with tools and retries can finish this single-domain task. State a one-line loop plan, execute until verified, then answer.\n\
3. LAYER: graph — independent branches, distinct roles, validation gates, human approval, or context-isolated handoffs are materially useful. Continue with the graph protocol below.\n\n\
For LAYER: graph, first emit a version 1 graph JSON shaped as {{\"version\":1,\"nodes\":[{{\"id\":\"...\",\"kind\":\"agent|validator|merge|human|goal_sink\",\"title\":\"...\",\"instruction\":\"...\"}}],\"edges\":[{{\"id\":\"...\",\"from\":\"...\",\"to\":\"...\"}}]}}, then a `flowchart TD` Mermaid diagram. Use the fewest useful nodes and one fixed node {{\"id\":\"goal\",\"kind\":\"goal_sink\",\"title\":\"GOAL\",\"instruction\":\"\"}}. Use unique stable IDs, known endpoints, no self-edges, no cycles, no outgoing edge from GOAL, and ensure every executable node has a path to GOAL.\n\
Execute every ready node in parallel. A node receives only its instruction, the original request when it is an entry node, and results carried by incoming edges. Validators return binary PASS/FAIL; on FAIL, retry the producer with the critique (maximum two retries), without drawing a cycle. Human nodes pause and ask the user with `WAITING:`. Log each attempt as `RUN: <id> attempt=<n> → <ok|fail> — <result>`. Do not claim completion before GOAL is reached. Finish with the ordered RUN LOG and `FINAL:` followed by the GOAL result.\n\
</acorn_graph_engineering>"
    )
}

fn compile_automatic_continuation_prompt(raw_content: &str, checkpoint: &str) -> String {
    format!(
        "<acorn_graph_engineering version=\"1\" mode=\"automatic\" continuation=\"1\">\n\
USER REPLY FOR THE ACTIVE RUN:\n{raw_content}\n\n\
ACTIVE WAITING CHECKPOINT FROM THE PRECEDING ASSISTANT RESPONSE:\n<checkpoint>\n{checkpoint}\n</checkpoint>\n\n\
Resume the active loop or graph run represented by this checkpoint. Do not perform a new prompt → loop → graph layer decision and do not design a replacement graph. Treat the user reply as the result of the pending human node or blocker. Preserve every completed node, attempt count, validation result, and RUN entry; execute only nodes that remain ready. Keep branch context isolation and the original validator retry limit. If another human node or blocker is reached, end with `WAITING:` again. Do not claim completion before the existing GOAL is reached. Finish with the cumulative ordered RUN LOG and `FINAL:` only when that GOAL is complete.\n\
</acorn_graph_engineering>"
    )
}

fn compile_manual_prompt(raw_content: &str, graph: &WorkGraph) -> Result<String, String> {
    let mermaid = serialize_mermaid(graph)?;
    let graph_json = serde_json::to_string_pretty(graph)
        .map_err(|err| format!("failed to serialize work graph: {err}"))?;
    Ok(format!(
        "<acorn_graph_engineering version=\"1\" mode=\"manual\">\n\
USER REQUEST (preserve its intent exactly):\n{raw_content}\n\n\
Execute this user-authored work graph exactly as its dependencies allow. The JSON is the structured contract; the Mermaid below is the authoritative execution serialization produced by Acorn.\n\n\
WORK GRAPH JSON:\n```json\n{graph_json}\n```\n\n\
WORK GRAPH MERMAID:\n```mermaid\n{mermaid}\n```\n\n\
Execution protocol:\n\
- Run every ready node in parallel. Entry nodes receive the user request; every other node receives only its own instruction and results from incoming nodes.\n\
- Keep branch context isolated. Do not leak unrelated branch history into a node.\n\
- Validators return binary PASS/FAIL. On FAIL, retry the producing node with the critique, at most twice, without adding a cycle.\n\
- Human nodes pause and ask the user with `WAITING:`; their answer becomes that node's result.\n\
- Merge nodes combine only their incoming results. GOAL is a sink, never executes work, and is reached only after all incoming dependencies complete.\n\
- Log every attempt as `RUN: <id> attempt=<n> → <ok|fail> — <result>`. Do not claim completion before GOAL. End with the ordered RUN LOG and `FINAL:` followed by the GOAL result.\n\
</acorn_graph_engineering>"
    ))
}

fn compile_manual_continuation_prompt(
    raw_content: &str,
    graph: &WorkGraph,
    checkpoint: &str,
) -> Result<String, String> {
    let mermaid = serialize_mermaid(graph)?;
    let graph_json = serde_json::to_string_pretty(graph)
        .map_err(|err| format!("failed to serialize work graph: {err}"))?;
    Ok(format!(
        "<acorn_graph_engineering version=\"1\" mode=\"manual\" continuation=\"1\">\n\
USER REPLY FOR THE ACTIVE RUN:\n{raw_content}\n\n\
ACTIVE WAITING CHECKPOINT FROM THE PRECEDING ASSISTANT RESPONSE:\n<checkpoint>\n{checkpoint}\n</checkpoint>\n\n\
Resume this same user-authored work graph. The reply is the output of the pending human node or blocker. Do not restart completed nodes, reset attempt counts, repeat completed validation, or replace the graph. Use the checkpoint to recover completed work and run only remaining ready nodes.\n\n\
WORK GRAPH JSON:\n```json\n{graph_json}\n```\n\n\
WORK GRAPH MERMAID:\n```mermaid\n{mermaid}\n```\n\n\
Continuation protocol:\n\
- Preserve the cumulative RUN LOG and branch context isolation from the checkpoint.\n\
- Validators still return binary PASS/FAIL and retain the original maximum of two producer retries.\n\
- If another human node or blocker is reached, end with `WAITING:` again and retain this graph.\n\
- GOAL remains a sink and is reached only after all incoming dependencies complete. End with `FINAL:` only when the existing GOAL is complete.\n\
</acorn_graph_engineering>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_graph() -> WorkGraph {
        WorkGraph {
            version: 1,
            nodes: vec![
                WorkGraphNode {
                    id: "goal".to_string(),
                    kind: WorkGraphNodeKind::GoalSink,
                    title: "GOAL".to_string(),
                    instruction: String::new(),
                },
                WorkGraphNode {
                    id: "build".to_string(),
                    kind: WorkGraphNodeKind::Agent,
                    title: "Build feature".to_string(),
                    instruction: "Implement the requested feature.".to_string(),
                },
                WorkGraphNode {
                    id: "check".to_string(),
                    kind: WorkGraphNodeKind::Validator,
                    title: "Verify".to_string(),
                    instruction: "Return PASS or FAIL with a concrete critique.".to_string(),
                },
            ],
            edges: vec![
                WorkGraphEdge {
                    id: "check-goal".to_string(),
                    from: "check".to_string(),
                    to: "goal".to_string(),
                },
                WorkGraphEdge {
                    id: "build-check".to_string(),
                    from: "build".to_string(),
                    to: "check".to_string(),
                },
            ],
        }
    }

    #[test]
    fn validates_and_serializes_manual_graph_deterministically() {
        let graph = valid_graph();
        validate_work_graph(&graph).expect("valid graph");
        assert_eq!(
            serialize_mermaid(&graph).expect("mermaid"),
            "flowchart TD\n  n0[\"build<br/>[agent] Build feature<br/>Implement the requested feature.\"]\n  n1[\"check<br/>[validator] Verify<br/>Return PASS or FAIL with a concrete critique.\"]\n  n2((GOAL))\n  n0 --> n1\n  n1 --> n2"
        );
    }

    #[test]
    fn rejects_cycles_and_nodes_without_a_path_to_goal() {
        let mut cycle = valid_graph();
        cycle.edges.push(WorkGraphEdge {
            id: "check-build".to_string(),
            from: "check".to_string(),
            to: "build".to_string(),
        });
        assert!(validate_work_graph(&cycle)
            .expect_err("cycle rejected")
            .contains("DAG"));

        let mut orphan = valid_graph();
        orphan.nodes.push(WorkGraphNode {
            id: "orphan".to_string(),
            kind: WorkGraphNodeKind::Human,
            title: "Approve".to_string(),
            instruction: "Approve the result.".to_string(),
        });
        assert!(validate_work_graph(&orphan)
            .expect_err("orphan rejected")
            .contains("no path to GOAL"));
    }

    #[test]
    fn compiler_preserves_raw_request_and_adds_execution_protocol() {
        let plan = GraphPromptPlan::Manual {
            version: 1,
            graph: valid_graph(),
            continuation: None,
        };
        let prompt = compile_prompt("Keep this raw request", &plan).expect("compiled prompt");
        assert!(prompt.contains("Keep this raw request"));
        assert!(prompt.contains("```mermaid\nflowchart TD"));
        assert!(prompt.contains("Run every ready node in parallel"));
        assert!(prompt.contains("Do not claim completion before GOAL"));
    }

    #[test]
    fn automatic_compiler_includes_layer_decision_and_retry_contract() {
        let prompt = compile_prompt("Investigate the task", &GraphPromptPlan::automatic())
            .expect("automatic prompt");
        assert!(prompt.contains("LAYER: prompt"));
        assert!(prompt.contains("LAYER: loop"));
        assert!(prompt.contains("LAYER: graph"));
        assert!(prompt.contains("maximum two retries"));
        assert!(prompt.contains("FINAL:"));
    }

    #[test]
    fn legacy_plan_without_continuation_deserializes_as_a_fresh_plan() {
        let plan: GraphPromptPlan = serde_json::from_value(serde_json::json!({
            "version": 1,
            "mode": "automatic"
        }))
        .expect("legacy plan");

        assert_eq!(plan, GraphPromptPlan::automatic());
        assert!(serde_json::to_value(plan)
            .expect("serialize plan")
            .get("continuation")
            .is_none());
    }

    #[test]
    fn continuation_compilers_resume_the_checkpoint_without_a_new_layer_decision() {
        let continuation = Some(GraphPromptContinuation { version: 1 });
        let automatic = GraphPromptPlan::Automatic {
            version: 1,
            continuation: continuation.clone(),
        };
        let automatic_prompt = compile_prompt_with_checkpoint(
            "Approved; continue.",
            &automatic,
            Some("RUN: research attempt=1 → ok\nWAITING: Approve the implementation."),
        )
        .expect("automatic continuation");
        assert!(automatic_prompt.contains("Approved; continue."));
        assert!(automatic_prompt.contains("RUN: research attempt=1"));
        assert!(automatic_prompt.contains("Do not perform a new prompt → loop → graph"));
        assert!(automatic_prompt.contains("execute only nodes that remain ready"));
        assert!(!automatic_prompt.contains("LAYER: prompt"));

        let manual = GraphPromptPlan::Manual {
            version: 1,
            graph: valid_graph(),
            continuation,
        };
        let manual_prompt = compile_prompt_with_checkpoint(
            "Use option B.",
            &manual,
            Some("RUN: build attempt=1 → ok\nWAITING: Choose A or B."),
        )
        .expect("manual continuation");
        assert!(manual_prompt.contains("WORK GRAPH JSON"));
        assert!(manual_prompt.contains("WORK GRAPH MERMAID"));
        assert!(manual_prompt.contains("Do not restart completed nodes"));
        assert!(manual_prompt.contains("Use option B."));
    }

    #[test]
    fn continuation_requires_an_active_waiting_checkpoint() {
        let plan = GraphPromptPlan::Automatic {
            version: 1,
            continuation: Some(GraphPromptContinuation { version: 1 }),
        };

        assert!(compile_prompt("Continue", &plan)
            .expect_err("checkpoint required")
            .contains("active WAITING checkpoint"));
    }
}
