use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use acorn_session::{
    GraphEdgeRunState, GraphNodeRunAttempt, GraphNodeRunState, GraphNodeRunStatus,
    GraphNodeVerdict, GraphRunState, GraphRunStatus, Session, SessionGraph, SessionStatus,
    WorkGraph, WorkGraphEdgeCondition, WorkGraphEdgeKind, WorkGraphExecutionMode,
    WorkGraphGroupGenerationMode, WorkGraphNode, WorkGraphNodeKind, GRAPH_RUN_SCHEMA_VERSION,
    LEGACY_WORK_GRAPH_VERSION, WORK_GRAPH_GOAL_ID,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use crate::chat_runs::{ChatCancellation, GraphCancellation};
use crate::error::{AppError, AppResult};
use crate::persistence;
use crate::state::AppState;
use crate::work_graph::{
    self, effective_retry_limit, expand_work_graph_edges, EffectiveWorkGraphEdge,
};

pub const GRAPH_RUN_STATE_CHANGED_EVENT: &str = "acorn:graph-run-state-changed";
const MAX_PARALLEL_GRAPH_NODES: usize = 4;
const LEGACY_VALIDATOR_RETRY_LIMIT: u32 = 2;
const DEFAULT_PROMPT_GROUP_MAX_NODES: usize = 12;
const MAX_NODE_OUTPUT_CHARS: usize = 64 * 1024;
const MAX_NODE_PROMPT_CHARS: usize = 160 * 1024;
const OUTPUT_TRUNCATION_MARKER: &str = "\n...[output truncated by Acorn]...\n";

#[derive(Clone, Serialize)]
pub struct GraphRunStateChangedPayload {
    pub session_id: String,
    pub state: GraphRunState,
}

#[derive(Debug, Clone)]
pub struct GraphNodeExecution {
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,
    pub prompt: String,
}

pub trait GraphNodeExecutor: Send + Sync {
    fn execute(
        &self,
        execution: GraphNodeExecution,
        cancellation: ChatCancellation,
    ) -> AppResult<String>;
}

#[derive(Debug)]
struct NodeExecutionResult {
    node_id: String,
    result: AppResult<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeReadiness {
    Ready,
    Pending,
    Skip,
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        return value.to_string();
    }
    let remaining = max_chars.saturating_sub(OUTPUT_TRUNCATION_MARKER.chars().count());
    let head_count = remaining / 2;
    let tail_count = remaining - head_count;
    let head = value.chars().take(head_count).collect::<String>();
    let mut tail = value.chars().rev().take(tail_count).collect::<Vec<_>>();
    tail.reverse();
    format!(
        "{head}{OUTPUT_TRUNCATION_MARKER}{}",
        tail.into_iter().collect::<String>()
    )
}

fn node_kind_name(kind: WorkGraphNodeKind) -> &'static str {
    match kind {
        WorkGraphNodeKind::Agent => "agent",
        WorkGraphNodeKind::Validator => "validator",
        WorkGraphNodeKind::Merge => "merge",
        WorkGraphNodeKind::Human => "human",
        WorkGraphNodeKind::GoalSink => "goal_sink",
    }
}

fn condition_matches(condition: WorkGraphEdgeCondition, verdict: Option<GraphNodeVerdict>) -> bool {
    match condition {
        WorkGraphEdgeCondition::Always => true,
        WorkGraphEdgeCondition::Pass => verdict == Some(GraphNodeVerdict::Pass),
        WorkGraphEdgeCondition::Fail => verdict == Some(GraphNodeVerdict::Fail),
        WorkGraphEdgeCondition::Approved => verdict == Some(GraphNodeVerdict::Approved),
        WorkGraphEdgeCondition::Rejected => verdict == Some(GraphNodeVerdict::Rejected),
    }
}

fn retry_condition_matches(
    edge: &EffectiveWorkGraphEdge,
    verdict: Option<GraphNodeVerdict>,
) -> bool {
    matches!(
        (edge.condition, verdict),
        (WorkGraphEdgeCondition::Fail, Some(GraphNodeVerdict::Fail))
            | (
                WorkGraphEdgeCondition::Rejected,
                Some(GraphNodeVerdict::Rejected)
            )
    )
}

fn graph_node<'a>(run: &'a GraphRunState, node_id: &str) -> AppResult<&'a WorkGraphNode> {
    run.definition
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .ok_or_else(|| AppError::Other(format!("Graph node not found: {node_id}")))
}

fn dependency_edges(graph: &WorkGraph) -> Vec<EffectiveWorkGraphEdge> {
    expand_work_graph_edges(graph)
        .into_iter()
        .filter(|edge| edge.kind == WorkGraphEdgeKind::Dependency)
        .collect()
}

fn incoming_dependency_edges(graph: &WorkGraph, node_id: &str) -> Vec<EffectiveWorkGraphEdge> {
    dependency_edges(graph)
        .into_iter()
        .filter(|edge| edge.to == node_id)
        .collect()
}

fn node_readiness(run: &GraphRunState, node_id: &str) -> NodeReadiness {
    let incoming = incoming_dependency_edges(&run.definition, node_id);
    if incoming.is_empty() {
        return NodeReadiness::Ready;
    }
    let mut selected = 0usize;
    let mut pending = false;
    let mut blocked = false;
    for edge in incoming {
        let Some(source) = run.nodes.get(&edge.from) else {
            blocked = true;
            continue;
        };
        match source.status {
            GraphNodeRunStatus::Queued
            | GraphNodeRunStatus::Working
            | GraphNodeRunStatus::Waiting => pending = true,
            GraphNodeRunStatus::Completed => {
                if condition_matches(edge.condition, source.verdict) {
                    selected += 1;
                }
            }
            GraphNodeRunStatus::Skipped => {}
            GraphNodeRunStatus::Failed | GraphNodeRunStatus::Cancelled => blocked = true,
        }
    }
    if pending {
        NodeReadiness::Pending
    } else if blocked || selected == 0 {
        NodeReadiness::Skip
    } else {
        NodeReadiness::Ready
    }
}

pub fn ready_node_ids(run: &GraphRunState) -> Vec<String> {
    let mut ready = run
        .nodes
        .iter()
        .filter_map(|(node_id, state)| {
            (state.status == GraphNodeRunStatus::Queued
                && node_readiness(run, node_id) == NodeReadiness::Ready)
                .then(|| node_id.clone())
        })
        .collect::<Vec<_>>();
    ready.sort();
    ready
}

fn selected_incoming_sources(run: &GraphRunState, node_id: &str) -> Vec<String> {
    let mut sources = incoming_dependency_edges(&run.definition, node_id)
        .into_iter()
        .filter_map(|edge| {
            let source = run.nodes.get(&edge.from)?;
            (source.status == GraphNodeRunStatus::Completed
                && condition_matches(edge.condition, source.verdict))
            .then_some(edge.from)
        })
        .collect::<Vec<_>>();
    sources.sort();
    sources.dedup();
    sources
}

fn node_artifact(run: &GraphRunState, node_id: &str) -> String {
    let Some(state) = run.nodes.get(node_id) else {
        return String::new();
    };
    let output = state.output.as_deref().unwrap_or_default();
    let Some(node) = run.definition.nodes.iter().find(|node| node.id == node_id) else {
        return output.to_string();
    };
    if node.kind != WorkGraphNodeKind::Validator {
        return output.to_string();
    }
    let mut sections = selected_incoming_sources(run, node_id)
        .into_iter()
        .filter_map(|source_id| {
            let source = run.nodes.get(&source_id)?;
            Some(format!(
                "VALIDATED INPUT {source_id}:\n{}",
                source.output.as_deref().unwrap_or_default()
            ))
        })
        .collect::<Vec<_>>();
    sections.push(format!("VALIDATOR REPORT {node_id}:\n{output}"));
    sections.join("\n\n")
}

pub fn compile_graph_node_prompt(
    run: &GraphRunState,
    node_id: &str,
    retry_critique: Option<&str>,
) -> AppResult<String> {
    let node = graph_node(run, node_id)?;
    if matches!(
        node.kind,
        WorkGraphNodeKind::Human | WorkGraphNodeKind::GoalSink
    ) {
        return Err(AppError::Other(format!(
            "Graph node {node_id} does not invoke an AI provider"
        )));
    }
    let incoming_edges = incoming_dependency_edges(&run.definition, node_id);
    let is_entry = incoming_edges.is_empty();
    let mut incoming = selected_incoming_sources(run, node_id)
        .into_iter()
        .map(|source_id| {
            format!(
                "<incoming source=\"{source_id}\">\n{}\n</incoming>",
                node_artifact(run, &source_id)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if incoming.is_empty() {
        incoming = "(none)".to_string();
    }
    let objective = if is_entry {
        format!("ORIGINAL OBJECTIVE:\n{}\n\n", run.objective)
    } else {
        String::new()
    };
    let retry = retry_critique
        .map(|critique| {
            format!(
                "RETRY CRITIQUE FROM THE VALIDATION GATE:\n{}\n\n",
                bounded_text(critique, MAX_NODE_OUTPUT_CHARS)
            )
        })
        .unwrap_or_default();
    let output_contract = if node.kind == WorkGraphNodeKind::Validator {
        "Your first non-empty line must be exactly `PASS` or `FAIL`. On FAIL, follow it with a concrete critique. Do not orchestrate or invoke other graph nodes."
    } else {
        "Return only this node's useful result. Do not orchestrate or invoke other graph nodes."
    };
    let prompt = format!(
        "<acorn_graph_node version=\"1\" run_id=\"{}\" node_id=\"{}\" attempt=\"{}\">\nNODE KIND: {}\nNODE TITLE: {}\nNODE INSTRUCTION:\n{}\n\n{}{}INCOMING RESULTS (only direct active dependencies):\n{}\n\nEXECUTION CONTRACT:\n- Execute exactly this one node in the current shared worktree.\n- Other ready nodes may be running concurrently. Never reset, revert, or overwrite unrelated work.\n- Use only the instruction, entry objective when present, incoming results above, and files currently in the shared worktree.\n- {}\n</acorn_graph_node>",
        run.run_id,
        node.id,
        run.nodes
            .get(node_id)
            .map(|state| state.attempt.max(1))
            .unwrap_or(1),
        node_kind_name(node.kind),
        node.title,
        node.instruction,
        objective,
        retry,
        incoming,
        output_contract,
    );
    Ok(bounded_text(&prompt, MAX_NODE_PROMPT_CHARS))
}

pub fn parse_validator_output(output: &str) -> Result<(GraphNodeVerdict, String), String> {
    let trimmed = output.trim();
    let mut lines = trimmed.lines();
    let first = lines
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "validator returned an empty result".to_string())?
        .trim();
    let normalized = first
        .strip_prefix("VERDICT:")
        .unwrap_or(first)
        .trim()
        .trim_end_matches(':')
        .trim();
    let verdict = if normalized.eq_ignore_ascii_case("PASS") {
        GraphNodeVerdict::Pass
    } else if normalized.eq_ignore_ascii_case("FAIL") {
        GraphNodeVerdict::Fail
    } else {
        return Err("validator result must start with PASS or FAIL".to_string());
    };
    let critique = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if verdict == GraphNodeVerdict::Fail && critique.is_empty() {
        return Err("a FAIL validator result must include a critique".to_string());
    }
    Ok((verdict, critique))
}

fn queued_node_run_state(node_id: String) -> GraphNodeRunState {
    GraphNodeRunState {
        node_id,
        status: GraphNodeRunStatus::Queued,
        attempt: 0,
        attempts: Vec::new(),
        output: None,
        error: None,
        question: None,
        verdict: None,
        started_at: None,
        completed_at: None,
    }
}

fn new_graph_run(session: &Session, graph: SessionGraph) -> GraphRunState {
    let now = Utc::now();
    let nodes = graph
        .definition
        .nodes
        .iter()
        .map(|node| (node.id.clone(), queued_node_run_state(node.id.clone())))
        .collect();
    let edges = graph
        .definition
        .edges
        .iter()
        .map(|edge| {
            (
                edge.id.clone(),
                GraphEdgeRunState {
                    edge_id: edge.id.clone(),
                    active: false,
                    traversed: false,
                    retry_count: 0,
                },
            )
        })
        .collect();
    GraphRunState {
        schema_version: GRAPH_RUN_SCHEMA_VERSION,
        session_id: session.id.to_string(),
        run_id: Uuid::new_v4().to_string(),
        revision: 1,
        graph_revision: graph.revision,
        objective: graph.objective,
        agent: graph.agent,
        status: GraphRunStatus::Running,
        definition: graph.definition,
        nodes,
        edges,
        started_at: now,
        updated_at: now,
        completed_at: None,
        error: None,
        final_output: None,
    }
}

fn session_status_for_run(run: &GraphRunState) -> SessionStatus {
    match run.status {
        GraphRunStatus::Running => SessionStatus::Working,
        GraphRunStatus::Waiting => SessionStatus::WaitingForInput,
        GraphRunStatus::Completed | GraphRunStatus::Cancelled => SessionStatus::Ready,
        GraphRunStatus::Failed => SessionStatus::Errored,
    }
}

fn emit_graph_run_state_changed<R: Runtime>(app: &AppHandle<R>, run: &GraphRunState) {
    if let Err(error) = app.emit(
        GRAPH_RUN_STATE_CHANGED_EVENT,
        GraphRunStateChangedPayload {
            session_id: run.session_id.clone(),
            state: run.clone(),
        },
    ) {
        tracing::warn!(
            error = %error,
            session_id = %run.session_id,
            run_id = %run.run_id,
            "failed to emit Graph run state change"
        );
    }
}

fn publish_run<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    run: &mut GraphRunState,
    bump_revision: bool,
) -> AppResult<()> {
    if bump_revision {
        run.revision = run
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::Other("Graph run revision overflow".to_string()))?;
    }
    run.updated_at = Utc::now();
    *run = persistence::save_graph_run_state(run.clone())?;
    state.sessions.update_status(
        &Uuid::parse_str(&run.session_id)
            .map_err(|_| AppError::Other("invalid Graph run session id".to_string()))?,
        session_status_for_run(run),
    )?;
    if let Err(error) = persistence::save_sessions(&state.sessions) {
        tracing::warn!(error = %error, "failed to persist Graph session status");
    }
    emit_graph_run_state_changed(app, run);
    Ok(())
}

fn refresh_edge_states(run: &mut GraphRunState) {
    let effective = expand_work_graph_edges(&run.definition);
    for edge in &run.definition.edges {
        let matching = effective
            .iter()
            .filter(|candidate| candidate.source_edge_id == edge.id)
            .collect::<Vec<_>>();
        let selected = |candidate: &EffectiveWorkGraphEdge| {
            run.nodes.get(&candidate.from).is_some_and(|source| {
                source.status == GraphNodeRunStatus::Completed
                    && if candidate.kind == WorkGraphEdgeKind::Retry {
                        retry_condition_matches(candidate, source.verdict)
                    } else {
                        condition_matches(candidate.condition, source.verdict)
                    }
            })
        };
        let active = matching.iter().any(|candidate| {
            selected(candidate)
                && run.nodes.get(&candidate.to).is_some_and(|target| {
                    matches!(
                        target.status,
                        GraphNodeRunStatus::Queued
                            | GraphNodeRunStatus::Working
                            | GraphNodeRunStatus::Waiting
                    )
                })
        });
        let traversed = matching.iter().any(|candidate| {
            selected(candidate)
                && run.nodes.get(&candidate.to).is_some_and(|target| {
                    matches!(
                        target.status,
                        GraphNodeRunStatus::Completed
                            | GraphNodeRunStatus::Failed
                            | GraphNodeRunStatus::Cancelled
                    )
                })
        });
        if let Some(state) = run.edges.get_mut(&edge.id) {
            state.active = active;
            state.traversed = traversed;
        }
    }
}

fn settle_skipped_nodes(run: &mut GraphRunState) -> bool {
    let mut changed = false;
    loop {
        let to_skip = run
            .nodes
            .iter()
            .filter_map(|(node_id, state)| {
                (state.status == GraphNodeRunStatus::Queued
                    && node_readiness(run, node_id) == NodeReadiness::Skip)
                    .then(|| node_id.clone())
            })
            .collect::<Vec<_>>();
        if to_skip.is_empty() {
            break;
        }
        let now = Utc::now();
        for node_id in to_skip {
            if let Some(node) = run.nodes.get_mut(&node_id) {
                node.status = GraphNodeRunStatus::Skipped;
                node.error = Some("no active completed dependency path".to_string());
                node.completed_at = Some(now);
                changed = true;
            }
        }
    }
    changed
}

fn mark_human_nodes_waiting(run: &mut GraphRunState, ready: &[String]) -> bool {
    let human_ids = ready
        .iter()
        .filter_map(|node_id| {
            run.definition
                .nodes
                .iter()
                .find(|node| node.id == *node_id && node.kind == WorkGraphNodeKind::Human)
                .map(|_| node_id.clone())
        })
        .collect::<Vec<_>>();
    if human_ids.is_empty() {
        return false;
    }
    let now = Utc::now();
    for node_id in human_ids {
        let question = run
            .definition
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .map(|node| node.instruction.clone());
        if let Some(node) = run.nodes.get_mut(&node_id) {
            node.status = GraphNodeRunStatus::Waiting;
            node.question = question;
            node.started_at.get_or_insert(now);
        }
    }
    true
}

fn group_is_sequential(graph: &WorkGraph, group_id: &str) -> bool {
    graph
        .groups
        .iter()
        .find(|group| group.id == group_id)
        .is_some_and(|group| group.execution_mode == WorkGraphExecutionMode::Sequential)
        || graph.nodes.iter().any(|node| {
            node.group_id.as_deref() == Some(group_id)
                && node.execution_mode == Some(WorkGraphExecutionMode::Sequential)
        })
}

fn select_execution_batch(run: &GraphRunState, ready: &[String]) -> Vec<String> {
    let mut candidates = ready
        .iter()
        .filter(|node_id| {
            run.definition.nodes.iter().any(|node| {
                node.id == node_id.as_str()
                    && matches!(
                        node.kind,
                        WorkGraphNodeKind::Agent
                            | WorkGraphNodeKind::Validator
                            | WorkGraphNodeKind::Merge
                    )
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort();
    if run.definition.execution_mode == WorkGraphExecutionMode::Sequential {
        let Some(first_node_id) = candidates.first().cloned() else {
            return candidates;
        };
        let first_group_id = run
            .definition
            .nodes
            .iter()
            .find(|node| node.id == first_node_id)
            .and_then(|node| node.group_id.as_deref());
        if let Some(group_id) = first_group_id {
            if !group_is_sequential(&run.definition, group_id) {
                return candidates
                    .into_iter()
                    .filter(|node_id| {
                        run.definition.nodes.iter().any(|node| {
                            node.id == *node_id && node.group_id.as_deref() == Some(group_id)
                        })
                    })
                    .take(MAX_PARALLEL_GRAPH_NODES)
                    .collect();
            }
        }
        return vec![first_node_id];
    }
    let mut lanes = HashSet::new();
    let mut selected = Vec::new();
    for node_id in candidates {
        let node = run
            .definition
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .expect("ready node definition");
        let lane = node.group_id.as_deref().and_then(|group_id| {
            group_is_sequential(&run.definition, group_id).then(|| format!("group:{group_id}"))
        });
        let lane = lane.or_else(|| {
            (node.group_id.is_none()
                && node.execution_mode == Some(WorkGraphExecutionMode::Sequential))
            .then(|| "standalone-sequential".to_string())
        });
        if lane
            .as_ref()
            .is_some_and(|lane| !lanes.insert(lane.clone()))
        {
            continue;
        }
        selected.push(node_id);
        if selected.len() >= MAX_PARALLEL_GRAPH_NODES {
            break;
        }
    }
    selected
}

fn mark_batch_working(run: &mut GraphRunState, batch: &[String]) {
    let now = Utc::now();
    for node_id in batch {
        let node = run.nodes.get_mut(node_id).expect("ready node state");
        node.attempt = node.attempt.saturating_add(1);
        node.status = GraphNodeRunStatus::Working;
        node.output = None;
        node.error = None;
        node.question = None;
        node.verdict = None;
        node.started_at = Some(now);
        node.completed_at = None;
        node.attempts.push(GraphNodeRunAttempt {
            attempt: node.attempt,
            status: GraphNodeRunStatus::Working,
            output: None,
            error: None,
            critique: None,
            verdict: None,
            started_at: now,
            completed_at: None,
        });
    }
}

fn execute_batch(
    run: &GraphRunState,
    batch: &[String],
    retry_context: &HashMap<String, String>,
    executor: Arc<dyn GraphNodeExecutor>,
    cancellation: GraphCancellation,
) -> AppResult<Vec<NodeExecutionResult>> {
    let jobs = batch
        .iter()
        .map(|node_id| {
            let attempt = run.nodes.get(node_id).map(|node| node.attempt).unwrap_or(1);
            let prompt = compile_graph_node_prompt(
                run,
                node_id,
                retry_context.get(node_id).map(String::as_str),
            )?;
            Ok(GraphNodeExecution {
                run_id: run.run_id.clone(),
                node_id: node_id.clone(),
                attempt,
                prompt,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    std::thread::scope(|scope| {
        let handles = jobs
            .into_iter()
            .map(|execution| {
                let executor = executor.clone();
                let cancellation = cancellation.clone();
                scope.spawn(move || {
                    let child_key = format!(
                        "graph:{}:{}:{}",
                        execution.run_id, execution.node_id, execution.attempt
                    );
                    let child_cancellation = cancellation.register_child(child_key.clone());
                    let node_id = execution.node_id.clone();
                    let result = if cancellation.is_cancelled() {
                        Err(AppError::Other("Graph run cancelled".to_string()))
                    } else {
                        executor.execute(execution, child_cancellation)
                    };
                    cancellation.finish_child(&child_key);
                    NodeExecutionResult { node_id, result }
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().map_err(|_| {
                    AppError::Other("Graph node execution worker panicked".to_string())
                })
            })
            .collect::<AppResult<Vec<_>>>()
    })
}

fn finish_batch(run: &mut GraphRunState, results: Vec<NodeExecutionResult>, cancelled: bool) {
    let now = Utc::now();
    for result in results {
        let kind = run
            .definition
            .nodes
            .iter()
            .find(|node| node.id == result.node_id)
            .map(|node| node.kind)
            .expect("executed node definition");
        let node = run
            .nodes
            .get_mut(&result.node_id)
            .expect("executed node state");
        let (status, output, error, verdict, critique) = match result.result {
            Ok(output) if output.trim().is_empty() => (
                GraphNodeRunStatus::Failed,
                None,
                Some("Graph node returned an empty result".to_string()),
                None,
                None,
            ),
            Ok(output) if kind == WorkGraphNodeKind::Validator => {
                match parse_validator_output(&output) {
                    Ok((verdict, critique)) => (
                        GraphNodeRunStatus::Completed,
                        Some(bounded_text(&output, MAX_NODE_OUTPUT_CHARS)),
                        None,
                        Some(verdict),
                        (!critique.is_empty()).then_some(critique),
                    ),
                    Err(error) => (
                        GraphNodeRunStatus::Failed,
                        Some(bounded_text(&output, MAX_NODE_OUTPUT_CHARS)),
                        Some(error),
                        None,
                        None,
                    ),
                }
            }
            Ok(output) => (
                GraphNodeRunStatus::Completed,
                Some(bounded_text(&output, MAX_NODE_OUTPUT_CHARS)),
                None,
                None,
                None,
            ),
            Err(error) => (
                if cancelled {
                    GraphNodeRunStatus::Cancelled
                } else {
                    GraphNodeRunStatus::Failed
                },
                None,
                Some(error.to_string()),
                None,
                None,
            ),
        };
        node.status = status;
        node.output = output.clone();
        node.error = error.clone();
        node.verdict = verdict;
        node.completed_at = Some(now);
        if let Some(attempt) = node.attempts.last_mut() {
            attempt.status = status;
            attempt.output = output;
            attempt.error = error;
            attempt.critique = critique;
            attempt.verdict = verdict;
            attempt.completed_at = Some(now);
        }
    }
}

fn dependency_descendants(graph: &WorkGraph, root: &str) -> BTreeSet<String> {
    let mut outgoing: BTreeMap<String, Vec<String>> = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), Vec::new()))
        .collect();
    for edge in dependency_edges(graph) {
        outgoing.entry(edge.from).or_default().push(edge.to);
    }
    let mut descendants = BTreeSet::new();
    let mut stack = vec![root.to_string()];
    while let Some(node_id) = stack.pop() {
        if !descendants.insert(node_id.clone()) {
            continue;
        }
        stack.extend(outgoing.get(&node_id).into_iter().flatten().cloned());
    }
    descendants
}

fn reset_retry_region(run: &mut GraphRunState, target: &str) {
    let reset = dependency_descendants(&run.definition, target);
    for node_id in &reset {
        if let Some(node) = run.nodes.get_mut(node_id) {
            node.status = GraphNodeRunStatus::Queued;
            node.output = None;
            node.error = None;
            node.question = None;
            node.verdict = None;
            node.started_at = None;
            node.completed_at = None;
        }
    }
    for edge in run.edges.values_mut() {
        let raw = run
            .definition
            .edges
            .iter()
            .find(|candidate| candidate.id == edge.edge_id);
        if raw.is_some_and(|raw| reset.contains(&raw.from) || reset.contains(&raw.to)) {
            edge.active = false;
            edge.traversed = false;
        }
    }
}

fn apply_explicit_retry(
    run: &mut GraphRunState,
    retry_context: &mut HashMap<String, String>,
) -> bool {
    let retry_edges = expand_work_graph_edges(&run.definition)
        .into_iter()
        .filter(|edge| edge.kind == WorkGraphEdgeKind::Retry)
        .collect::<Vec<_>>();
    let mut raw_ids = retry_edges
        .iter()
        .map(|edge| edge.source_edge_id.clone())
        .collect::<Vec<_>>();
    raw_ids.sort();
    raw_ids.dedup();
    for raw_id in raw_ids {
        let effective = retry_edges
            .iter()
            .filter(|edge| edge.source_edge_id == raw_id)
            .collect::<Vec<_>>();
        let Some(representative) = effective.first().copied() else {
            continue;
        };
        let retry_count = run
            .edges
            .get(&raw_id)
            .map(|edge| edge.retry_count)
            .unwrap_or_default();
        if retry_count >= effective_retry_limit(representative) {
            continue;
        }
        let mut matched_sources = BTreeSet::new();
        for edge in &effective {
            let Some(source) = run.nodes.get(&edge.from) else {
                continue;
            };
            if source.status == GraphNodeRunStatus::Completed
                && source.attempt > retry_count
                && retry_condition_matches(edge, source.verdict)
            {
                matched_sources.insert(edge.from.clone());
            }
        }
        if matched_sources.is_empty() {
            continue;
        }
        let critique = matched_sources
            .iter()
            .filter_map(|source_id| {
                let output = run.nodes.get(source_id)?.output.as_deref()?;
                Some(format!("{source_id}:\n{output}"))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let targets = effective
            .iter()
            .filter(|edge| matched_sources.contains(&edge.from))
            .map(|edge| edge.to.clone())
            .collect::<BTreeSet<_>>();
        if let Some(edge_state) = run.edges.get_mut(&raw_id) {
            edge_state.retry_count = edge_state.retry_count.saturating_add(1);
        }
        for target in targets {
            retry_context.insert(target.clone(), critique.clone());
            reset_retry_region(run, &target);
        }
        return true;
    }
    false
}

fn apply_legacy_validator_retry(
    run: &mut GraphRunState,
    retry_context: &mut HashMap<String, String>,
) -> bool {
    if run.definition.version != LEGACY_WORK_GRAPH_VERSION {
        return false;
    }
    let validator_ids = run
        .definition
        .nodes
        .iter()
        .filter(|node| node.kind == WorkGraphNodeKind::Validator)
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    for validator_id in validator_ids {
        let Some(validator) = run.nodes.get(&validator_id) else {
            continue;
        };
        if validator.status != GraphNodeRunStatus::Completed
            || validator.verdict != Some(GraphNodeVerdict::Fail)
        {
            continue;
        }
        let incoming = incoming_dependency_edges(&run.definition, &validator_id)
            .into_iter()
            .map(|edge| edge.from)
            .collect::<BTreeSet<_>>();
        if incoming.len() != 1 {
            if let Some(validator) = run.nodes.get_mut(&validator_id) {
                validator.status = GraphNodeRunStatus::Failed;
                validator.error = Some(
                    "legacy validator retry requires exactly one producing dependency".to_string(),
                );
            }
            return false;
        }
        if validator.attempt > LEGACY_VALIDATOR_RETRY_LIMIT {
            if let Some(validator) = run.nodes.get_mut(&validator_id) {
                validator.status = GraphNodeRunStatus::Failed;
                validator.error = Some(format!(
                    "validator failed after {LEGACY_VALIDATOR_RETRY_LIMIT} retries"
                ));
                if let Some(attempt) = validator.attempts.last_mut() {
                    attempt.status = GraphNodeRunStatus::Failed;
                    attempt.error = validator.error.clone();
                }
            }
            return false;
        }
        let target = incoming.into_iter().next().expect("one validator input");
        let valid_target = run.definition.nodes.iter().any(|node| {
            node.id == target
                && matches!(
                    node.kind,
                    WorkGraphNodeKind::Agent | WorkGraphNodeKind::Merge
                )
        });
        if !valid_target {
            if let Some(validator) = run.nodes.get_mut(&validator_id) {
                validator.status = GraphNodeRunStatus::Failed;
                validator.error =
                    Some("legacy validator producer must be an agent or merge node".to_string());
            }
            return false;
        }
        retry_context.insert(target.clone(), validator.output.clone().unwrap_or_default());
        reset_retry_region(run, &target);
        return true;
    }
    false
}

fn terminalize_cancelled(run: &mut GraphRunState) {
    let now = Utc::now();
    for node in run.nodes.values_mut() {
        if matches!(
            node.status,
            GraphNodeRunStatus::Queued | GraphNodeRunStatus::Working | GraphNodeRunStatus::Waiting
        ) {
            node.status = GraphNodeRunStatus::Cancelled;
            node.error = Some("Graph run cancelled".to_string());
            node.completed_at = Some(now);
            if let Some(attempt) = node.attempts.last_mut() {
                if attempt.status == GraphNodeRunStatus::Working {
                    attempt.status = GraphNodeRunStatus::Cancelled;
                    attempt.error = node.error.clone();
                    attempt.completed_at = Some(now);
                }
            }
        }
    }
    run.status = GraphRunStatus::Cancelled;
    run.error = Some("Graph run cancelled".to_string());
    run.completed_at = Some(now);
}

fn terminalize_failed(run: &mut GraphRunState, error: String) {
    let now = Utc::now();
    for node in run.nodes.values_mut() {
        if matches!(
            node.status,
            GraphNodeRunStatus::Queued | GraphNodeRunStatus::Waiting
        ) {
            node.status = GraphNodeRunStatus::Skipped;
            node.error = Some("Graph run cannot reach GOAL".to_string());
            node.completed_at = Some(now);
        }
    }
    run.status = GraphRunStatus::Failed;
    run.error = Some(error);
    run.completed_at = Some(now);
}

fn complete_goal(run: &mut GraphRunState) -> AppResult<()> {
    let sources = selected_incoming_sources(run, WORK_GRAPH_GOAL_ID);
    if sources.is_empty() {
        return Err(AppError::Other(
            "GOAL has no active completed input".to_string(),
        ));
    }
    let output = if sources.len() == 1 {
        node_artifact(run, &sources[0])
    } else {
        sources
            .iter()
            .map(|source| format!("## {source}\n{}", node_artifact(run, source)))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let output = bounded_text(&output, MAX_NODE_PROMPT_CHARS);
    let now = Utc::now();
    let goal = run
        .nodes
        .get_mut(WORK_GRAPH_GOAL_ID)
        .ok_or_else(|| AppError::Other("GOAL state missing".to_string()))?;
    goal.status = GraphNodeRunStatus::Completed;
    goal.output = Some(output.clone());
    goal.started_at = Some(now);
    goal.completed_at = Some(now);
    run.status = GraphRunStatus::Completed;
    run.final_output = Some(output);
    run.error = None;
    run.completed_at = Some(now);
    Ok(())
}

fn first_failed_node(run: &GraphRunState) -> Option<(&str, &str)> {
    run.nodes.iter().find_map(|(node_id, node)| {
        (node.status == GraphNodeRunStatus::Failed).then(|| {
            (
                node_id.as_str(),
                node.error.as_deref().unwrap_or("Graph node failed"),
            )
        })
    })
}

fn execute_graph_run<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    mut run: GraphRunState,
    executor: Arc<dyn GraphNodeExecutor>,
    cancellation: GraphCancellation,
) -> AppResult<GraphRunState> {
    let mut retry_context = HashMap::new();
    loop {
        if cancellation.is_cancelled() {
            terminalize_cancelled(&mut run);
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            return Ok(run);
        }

        if apply_explicit_retry(&mut run, &mut retry_context)
            || apply_legacy_validator_retry(&mut run, &mut retry_context)
        {
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            continue;
        }

        if let Some((node_id, error)) = first_failed_node(&run) {
            let error = format!("Graph node {node_id} failed: {error}");
            terminalize_failed(&mut run, error);
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            return Ok(run);
        }

        settle_skipped_nodes(&mut run);
        if run
            .nodes
            .get(WORK_GRAPH_GOAL_ID)
            .is_some_and(|goal| goal.status == GraphNodeRunStatus::Skipped)
        {
            terminalize_failed(&mut run, "Graph run cannot reach GOAL".to_string());
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            return Ok(run);
        }

        let ready = ready_node_ids(&run);
        if ready.iter().any(|node_id| node_id == WORK_GRAPH_GOAL_ID) {
            if let Err(error) = complete_goal(&mut run) {
                terminalize_failed(&mut run, error.to_string());
            }
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            return Ok(run);
        }

        mark_human_nodes_waiting(&mut run, &ready);
        let batch = select_execution_batch(&run, &ready);
        if !batch.is_empty() {
            mark_batch_working(&mut run, &batch);
            run.status = GraphRunStatus::Running;
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            let results = match execute_batch(
                &run,
                &batch,
                &retry_context,
                executor.clone(),
                cancellation.clone(),
            ) {
                Ok(results) => results,
                Err(error) => {
                    terminalize_failed(&mut run, error.to_string());
                    refresh_edge_states(&mut run);
                    publish_run(app, state, &mut run, true)?;
                    return Ok(run);
                }
            };
            for node_id in &batch {
                retry_context.remove(node_id);
            }
            finish_batch(&mut run, results, cancellation.is_cancelled());
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            continue;
        }

        if run
            .nodes
            .values()
            .any(|node| node.status == GraphNodeRunStatus::Waiting)
        {
            run.status = GraphRunStatus::Waiting;
            refresh_edge_states(&mut run);
            publish_run(app, state, &mut run, true)?;
            return Ok(run);
        }

        terminalize_failed(
            &mut run,
            "Graph run reached a scheduler deadlock".to_string(),
        );
        refresh_edge_states(&mut run);
        publish_run(app, state, &mut run, true)?;
        return Ok(run);
    }
}

fn prompt_group_ids(graph: &WorkGraph) -> Vec<String> {
    graph
        .groups
        .iter()
        .filter(|group| group.generation.mode == WorkGraphGroupGenerationMode::Prompt)
        .map(|group| group.id.clone())
        .collect()
}

#[derive(Debug, Deserialize)]
struct GeneratedGroupTasks {
    tasks: Vec<GeneratedGroupTask>,
}

#[derive(Debug, Deserialize)]
struct GeneratedGroupTask {
    title: String,
    instruction: String,
}

fn compile_group_generation_prompt(
    run: &GraphRunState,
    group_id: &str,
    count: Option<usize>,
    max_nodes: usize,
    prompt: &str,
) -> String {
    let count_contract = count.map_or_else(
        || format!("between 1 and {max_nodes} tasks; choose the smallest useful task count"),
        |count| format!("exactly {count} tasks"),
    );
    format!(
        "<acorn_graph_group_generation version=\"1\" run_id=\"{}\" group_id=\"{group_id}\">\nORIGINAL OBJECTIVE:\n{}\n\nGROUP GENERATION INSTRUCTION:\n{}\n\nReturn only strict JSON with {count_contract}: {{\"tasks\":[{{\"title\":\"short title\",\"instruction\":\"self-contained node instruction\"}}]}}. Do not use Markdown fences. Each title must be non-empty and at most 120 characters; each instruction must be non-empty and at most 1200 characters.\n</acorn_graph_group_generation>",
        run.run_id, run.objective, prompt
    )
}

fn next_materialized_agent_id(reserved_ids: &BTreeSet<String>) -> String {
    for index in 1usize.. {
        let candidate = format!("agent-{index}");
        if !reserved_ids.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("the stable node id space is unbounded")
}

fn apply_generated_group_tasks(
    run: &mut GraphRunState,
    group_id: &str,
    tasks: Vec<GeneratedGroupTask>,
    reserved_ids: &mut BTreeSet<String>,
) -> AppResult<()> {
    let mut definition = run.definition.clone();
    let mut node_states = run.nodes.clone();
    let mut member_ids = definition
        .nodes
        .iter()
        .filter(|node| node.group_id.as_deref() == Some(group_id))
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    member_ids.sort();

    let desired_count = tasks.len();
    let retained_ids = member_ids
        .iter()
        .take(desired_count)
        .cloned()
        .collect::<Vec<_>>();
    let removed_ids = member_ids
        .iter()
        .skip(desired_count)
        .cloned()
        .collect::<BTreeSet<_>>();
    if !removed_ids.is_empty() {
        definition
            .nodes
            .retain(|node| !removed_ids.contains(&node.id));
        for node_id in &removed_ids {
            node_states.remove(node_id);
        }
    }

    let mut materialized_ids = retained_ids;
    while materialized_ids.len() < desired_count {
        let node_id = next_materialized_agent_id(reserved_ids);
        reserved_ids.insert(node_id.clone());
        let task = &tasks[materialized_ids.len()];
        let node = WorkGraphNode {
            id: node_id.clone(),
            kind: WorkGraphNodeKind::Agent,
            title: task.title.clone(),
            instruction: task.instruction.clone(),
            group_id: Some(group_id.to_string()),
            execution_mode: None,
        };
        let insertion_index = definition
            .nodes
            .iter()
            .position(|node| node.kind == WorkGraphNodeKind::GoalSink)
            .unwrap_or(definition.nodes.len());
        definition.nodes.insert(insertion_index, node);
        node_states.insert(node_id.clone(), queued_node_run_state(node_id.clone()));
        materialized_ids.push(node_id);
    }

    for (node_id, task) in materialized_ids.iter().zip(tasks) {
        let node = definition
            .nodes
            .iter_mut()
            .find(|node| node.id == *node_id)
            .expect("known prompt group member");
        node.title = task.title;
        node.instruction = task.instruction;
        node.execution_mode = None;
    }
    definition
        .groups
        .iter_mut()
        .find(|group| group.id == group_id)
        .expect("known prompt group")
        .generation
        .count = Some(desired_count as u32);

    work_graph::validate_work_graph(&definition).map_err(AppError::Other)?;
    run.definition = definition;
    run.nodes = node_states;
    Ok(())
}

fn materialize_prompt_groups(
    run: &mut GraphRunState,
    executor: Arc<dyn GraphNodeExecutor>,
    cancellation: GraphCancellation,
) -> AppResult<bool> {
    let group_ids = prompt_group_ids(&run.definition);
    if group_ids.is_empty() {
        return Ok(false);
    }
    let mut reserved_ids = run
        .definition
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .chain(run.definition.groups.iter().map(|group| group.id.clone()))
        .collect::<BTreeSet<_>>();
    for group_id in group_ids {
        if cancellation.is_cancelled() {
            return Err(AppError::Other("Graph run cancelled".to_string()));
        }
        let group = run
            .definition
            .groups
            .iter()
            .find(|group| group.id == group_id)
            .cloned()
            .ok_or_else(|| AppError::Other(format!("Graph group not found: {group_id}")))?;
        let mut member_ids = run
            .definition
            .nodes
            .iter()
            .filter(|node| node.group_id.as_deref() == Some(group_id.as_str()))
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        member_ids.sort();
        let count = group.generation.count.map(|count| count as usize);
        let max_nodes = group
            .generation
            .max_nodes
            .map(|count| count as usize)
            .unwrap_or(DEFAULT_PROMPT_GROUP_MAX_NODES);
        if let Some(count) = count {
            if count == 0 || count > max_nodes || count != member_ids.len() {
                return Err(AppError::Other(format!(
                    "prompt-generated group {group_id} must have exactly {count} materialized node slots (found {})",
                    member_ids.len()
                )));
            }
        }
        let prompt = group
            .generation
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
            .ok_or_else(|| {
                AppError::Other(format!(
                    "prompt-generated group {group_id} needs a generation prompt"
                ))
            })?;
        let execution = GraphNodeExecution {
            run_id: run.run_id.clone(),
            node_id: format!("group-generation:{group_id}"),
            attempt: 1,
            prompt: compile_group_generation_prompt(run, &group_id, count, max_nodes, prompt),
        };
        let child_key = format!("graph:{}:group:{group_id}:1", run.run_id);
        let child = cancellation.register_child(child_key.clone());
        let raw = executor.execute(execution, child);
        cancellation.finish_child(&child_key);
        let raw = raw?;
        if raw.chars().count() > MAX_NODE_OUTPUT_CHARS {
            return Err(AppError::Other(format!(
                "prompt-generated group {group_id} returned an oversized task payload"
            )));
        }
        let generated =
            serde_json::from_str::<GeneratedGroupTasks>(raw.trim()).map_err(|error| {
                AppError::Other(format!(
                    "prompt-generated group {group_id} returned malformed task JSON: {error}"
                ))
            })?;
        match count {
            Some(count) if generated.tasks.len() != count => {
                return Err(AppError::Other(format!(
                    "prompt-generated group {group_id} returned {} tasks; expected {count}",
                    generated.tasks.len()
                )));
            }
            None if !(1..=max_nodes).contains(&generated.tasks.len()) => {
                return Err(AppError::Other(format!(
                    "prompt-generated group {group_id} returned {} tasks; expected between 1 and {max_nodes}",
                    generated.tasks.len()
                )));
            }
            _ => {}
        }
        let mut tasks = Vec::with_capacity(generated.tasks.len());
        for (index, task) in generated.tasks.into_iter().enumerate() {
            let title = task.title.trim();
            let instruction = task.instruction.trim();
            if title.is_empty()
                || title.chars().count() > 120
                || instruction.is_empty()
                || instruction.chars().count() > 1_200
            {
                return Err(AppError::Other(format!(
                    "prompt-generated group {group_id} returned an invalid task at position {}",
                    index + 1
                )));
            }
            tasks.push(GeneratedGroupTask {
                title: title.to_string(),
                instruction: instruction.to_string(),
            });
        }
        apply_generated_group_tasks(run, &group_id, tasks, &mut reserved_ids)?;
    }
    work_graph::validate_work_graph(&run.definition).map_err(AppError::Other)?;
    Ok(true)
}

pub fn start_graph_run<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    graph: SessionGraph,
    executor: Arc<dyn GraphNodeExecutor>,
) -> AppResult<GraphRunState> {
    work_graph::validate_work_graph(&graph.definition).map_err(AppError::Other)?;
    if let Some(existing) = load_graph_run_state(state, &session)? {
        if matches!(
            existing.status,
            GraphRunStatus::Running | GraphRunStatus::Waiting
        ) {
            return Err(AppError::Other(
                "Graph session already has an active or waiting run".to_string(),
            ));
        }
    }
    let mut run = new_graph_run(&session, graph);
    let cancellation = state
        .chat_runs
        .start_graph(session.id, run.run_id.clone())?;
    let result = (|| {
        publish_run(app, state, &mut run, false)?;
        match materialize_prompt_groups(&mut run, executor.clone(), cancellation.clone()) {
            Ok(true) => publish_run(app, state, &mut run, true)?,
            Ok(false) => {}
            Err(_error) if cancellation.is_cancelled() => {
                terminalize_cancelled(&mut run);
                publish_run(app, state, &mut run, true)?;
                return Ok(run);
            }
            Err(error) => {
                terminalize_failed(&mut run, error.to_string());
                publish_run(app, state, &mut run, true)?;
                return Ok(run);
            }
        }
        execute_graph_run(app, state, run, executor, cancellation.clone())
    })();
    state
        .chat_runs
        .finish_graph(&session.id, cancellation.run_id());
    result
}

fn publish_already_saved_run<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    run: &GraphRunState,
) -> AppResult<()> {
    let session_id = Uuid::parse_str(&run.session_id)
        .map_err(|_| AppError::Other("invalid Graph run session id".to_string()))?;
    state
        .sessions
        .update_status(&session_id, session_status_for_run(run))?;
    if let Err(error) = persistence::save_sessions(&state.sessions) {
        tracing::warn!(error = %error, "failed to persist Graph session status");
    }
    emit_graph_run_state_changed(app, run);
    Ok(())
}

pub fn submit_graph_node_input<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    run_id: String,
    node_id: String,
    input: String,
    verdict: Option<GraphNodeVerdict>,
    expected_revision: u64,
    executor: Arc<dyn GraphNodeExecutor>,
) -> AppResult<GraphRunState> {
    let input = input.trim().to_string();
    if input.is_empty() {
        return Err(AppError::Other(
            "Human node input must not be empty".to_string(),
        ));
    }
    if verdict.is_some_and(|verdict| {
        !matches!(
            verdict,
            GraphNodeVerdict::Approved | GraphNodeVerdict::Rejected
        )
    }) {
        return Err(AppError::Other(
            "Human node verdict must be approved or rejected".to_string(),
        ));
    }
    let cancellation = state.chat_runs.start_graph(session.id, run_id.clone())?;
    let updated = persistence::update_graph_run_state(
        &session.id.to_string(),
        &run_id,
        expected_revision,
        |run| {
            if run.status != GraphRunStatus::Waiting {
                return Err(AppError::Other(
                    "Graph run is not waiting for Human input".to_string(),
                ));
            }
            if run.graph_revision
                != session
                    .graph
                    .as_ref()
                    .map(|graph| graph.revision)
                    .unwrap_or_default()
            {
                return Err(AppError::Other(
                    "Graph design changed before Human input was submitted".to_string(),
                ));
            }
            let definition = run
                .definition
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .ok_or_else(|| AppError::Other(format!("Graph node not found: {node_id}")))?;
            if definition.kind != WorkGraphNodeKind::Human {
                return Err(AppError::Other(
                    "only Human nodes accept direct input".to_string(),
                ));
            }
            let requires_verdict = expand_work_graph_edges(&run.definition).iter().any(|edge| {
                edge.from == node_id
                    && matches!(
                        edge.condition,
                        WorkGraphEdgeCondition::Approved | WorkGraphEdgeCondition::Rejected
                    )
            });
            if requires_verdict && verdict.is_none() {
                return Err(AppError::Other(
                    "this Human node requires an approved or rejected verdict".to_string(),
                ));
            }
            let now = Utc::now();
            let node = run
                .nodes
                .get_mut(&node_id)
                .ok_or_else(|| AppError::Other(format!("Graph node state not found: {node_id}")))?;
            if node.status != GraphNodeRunStatus::Waiting {
                return Err(AppError::Other(
                    "Graph node is not waiting for input".to_string(),
                ));
            }
            node.attempt = node.attempt.saturating_add(1);
            node.status = GraphNodeRunStatus::Completed;
            node.output = Some(bounded_text(&input, MAX_NODE_OUTPUT_CHARS));
            node.error = None;
            node.question = None;
            node.verdict = verdict;
            let started_at = node.started_at.unwrap_or(now);
            node.completed_at = Some(now);
            node.attempts.push(GraphNodeRunAttempt {
                attempt: node.attempt,
                status: GraphNodeRunStatus::Completed,
                output: node.output.clone(),
                error: None,
                critique: None,
                verdict,
                started_at,
                completed_at: Some(now),
            });
            run.status = GraphRunStatus::Running;
            run.error = None;
            run.completed_at = None;
            Ok(())
        },
    );
    let updated = match updated {
        Ok(updated) => updated,
        Err(error) => {
            state
                .chat_runs
                .finish_graph(&session.id, cancellation.run_id());
            return Err(error);
        }
    };
    publish_already_saved_run(app, state, &updated)?;
    let result = execute_graph_run(app, state, updated, executor, cancellation.clone());
    state
        .chat_runs
        .finish_graph(&session.id, cancellation.run_id());
    result
}

fn validate_graph_cancel_identity(
    current: &GraphRunState,
    run_id: &str,
    _expected_revision: u64,
) -> AppResult<()> {
    if current.run_id != run_id {
        return Err(AppError::Other(
            "Graph run changed since this cancellation was requested".to_string(),
        ));
    }
    // A stale UI revision must not prevent a monotonic cancel request. The
    // run id remains the authority, while persistence uses the latest revision.
    Ok(())
}

fn graph_run_is_terminal(run: &GraphRunState) -> bool {
    matches!(
        run.status,
        GraphRunStatus::Completed | GraphRunStatus::Failed | GraphRunStatus::Cancelled
    )
}

fn await_signalled_graph_cancellation(
    state: &AppState,
    session: &Session,
    run_id: &str,
    mut latest: GraphRunState,
) -> AppResult<GraphRunState> {
    for _ in 0..160 {
        std::thread::sleep(std::time::Duration::from_millis(25));
        let Some(updated) = persistence::load_graph_run_state(&session.id.to_string())? else {
            break;
        };
        if updated.run_id != run_id || graph_run_is_terminal(&updated) {
            return Ok(updated);
        }
        latest = updated;
        if latest.status == GraphRunStatus::Waiting && !state.chat_runs.is_active(&session.id) {
            break;
        }
    }
    Ok(latest)
}

fn terminalize_graph_run_with_claim<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: &Session,
    run_id: &str,
) -> AppResult<GraphRunState> {
    let claim = state
        .chat_runs
        .start_graph(session.id, run_id.to_string())?;
    let result = (|| {
        let latest = persistence::load_graph_run_state(&session.id.to_string())?
            .ok_or_else(|| AppError::Other("Graph run state not found".to_string()))?;
        if latest.run_id != run_id {
            return Err(AppError::Other(
                "Graph run changed since this cancellation was requested".to_string(),
            ));
        }
        if graph_run_is_terminal(&latest) {
            return Ok(latest);
        }
        let cancelled = persistence::update_graph_run_state(
            &session.id.to_string(),
            run_id,
            latest.revision,
            |run| {
                terminalize_cancelled(run);
                refresh_edge_states(run);
                Ok(())
            },
        )?;
        publish_already_saved_run(app, state, &cancelled)?;
        Ok(cancelled)
    })();
    state.chat_runs.finish_graph(&session.id, claim.run_id());
    result
}

pub fn cancel_graph_run<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    run_id: String,
    expected_revision: u64,
) -> AppResult<GraphRunState> {
    let current = persistence::load_graph_run_state(&session.id.to_string())?
        .ok_or_else(|| AppError::Other("Graph run state not found".to_string()))?;
    validate_graph_cancel_identity(&current, &run_id, expected_revision)?;
    if graph_run_is_terminal(&current) {
        return Ok(current);
    }
    let mut latest = current;
    let mut last_claim_error = None;
    for _ in 0..4 {
        if state.chat_runs.cancel_graph(&session.id, &run_id).is_some() {
            latest = await_signalled_graph_cancellation(state, &session, &run_id, latest)?;
            if graph_run_is_terminal(&latest) || latest.status == GraphRunStatus::Running {
                return Ok(latest);
            }
        }
        match terminalize_graph_run_with_claim(app, state, &session, &run_id) {
            Ok(cancelled) => return Ok(cancelled),
            Err(error) => last_claim_error = Some(error),
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
        latest = persistence::load_graph_run_state(&session.id.to_string())?
            .ok_or_else(|| AppError::Other("Graph run state not found".to_string()))?;
        validate_graph_cancel_identity(&latest, &run_id, expected_revision)?;
        if graph_run_is_terminal(&latest) {
            return Ok(latest);
        }
    }
    Err(last_claim_error.unwrap_or_else(|| {
        AppError::Other("failed to claim Graph run for cancellation".to_string())
    }))
}

pub fn load_graph_run_state(
    state: &AppState,
    session: &Session,
) -> AppResult<Option<GraphRunState>> {
    let Some(run) = persistence::load_graph_run_state(&session.id.to_string())? else {
        return Ok(None);
    };
    if run.status != GraphRunStatus::Running || state.chat_runs.is_active(&session.id) {
        return Ok(Some(run));
    }
    let failed = persistence::update_graph_run_state(
        &session.id.to_string(),
        &run.run_id,
        run.revision,
        |run| {
            let now = Utc::now();
            for node in run.nodes.values_mut() {
                match node.status {
                    GraphNodeRunStatus::Working => {
                        node.status = GraphNodeRunStatus::Failed;
                        node.error = Some("Graph node was interrupted by app restart".to_string());
                        node.completed_at = Some(now);
                        if let Some(attempt) = node.attempts.last_mut() {
                            attempt.status = GraphNodeRunStatus::Failed;
                            attempt.error = node.error.clone();
                            attempt.completed_at = Some(now);
                        }
                    }
                    GraphNodeRunStatus::Queued | GraphNodeRunStatus::Waiting => {
                        node.status = GraphNodeRunStatus::Skipped;
                        node.error = Some("Graph run was interrupted by app restart".to_string());
                        node.completed_at = Some(now);
                    }
                    _ => {}
                }
            }
            run.status = GraphRunStatus::Failed;
            run.error = Some("Graph run was interrupted by app restart".to_string());
            run.completed_at = Some(now);
            refresh_edge_states(run);
            Ok(())
        },
    )?;
    state
        .sessions
        .update_status(&session.id, session_status_for_run(&failed))?;
    if let Err(error) = persistence::save_sessions(&state.sessions) {
        tracing::warn!(error = %error, "failed to persist interrupted Graph session status");
    }
    Ok(Some(failed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use acorn_session::{
        SessionAgentProvider, SessionGraphAgent, WorkGraphEdge, WorkGraphGroup,
        WorkGraphGroupDirection, WorkGraphGroupGeneration, WorkGraphNode,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct ParallelProbeExecutor {
        active: AtomicUsize,
        maximum: AtomicUsize,
    }

    impl GraphNodeExecutor for ParallelProbeExecutor {
        fn execute(
            &self,
            _execution: GraphNodeExecution,
            _cancellation: ChatCancellation,
        ) -> AppResult<String> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(30));
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok("done".to_string())
        }
    }

    struct StaticExecutor {
        response: String,
    }

    impl GraphNodeExecutor for StaticExecutor {
        fn execute(
            &self,
            _execution: GraphNodeExecution,
            _cancellation: ChatCancellation,
        ) -> AppResult<String> {
            Ok(self.response.clone())
        }
    }

    fn edge(id: &str, from: &str, to: &str) -> WorkGraphEdge {
        WorkGraphEdge {
            id: id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            label: None,
            condition: WorkGraphEdgeCondition::Always,
            kind: WorkGraphEdgeKind::Dependency,
            retry_limit: None,
        }
    }

    fn node(id: &str, kind: WorkGraphNodeKind) -> WorkGraphNode {
        WorkGraphNode {
            id: id.to_string(),
            kind,
            title: if kind == WorkGraphNodeKind::GoalSink {
                "GOAL".to_string()
            } else {
                id.to_string()
            },
            instruction: if kind == WorkGraphNodeKind::GoalSink {
                String::new()
            } else {
                format!("run {id}")
            },
            group_id: None,
            execution_mode: None,
        }
    }

    fn run_for(graph: WorkGraph) -> GraphRunState {
        let session = Session::new(
            "Graph".to_string(),
            PathBuf::from("/tmp/acorn-graph-test"),
            PathBuf::from("/tmp/acorn-graph-test"),
            "main".to_string(),
            true,
            acorn_session::SessionKind::Regular,
        );
        new_graph_run(
            &session,
            SessionGraph {
                version: 1,
                objective: "test objective".to_string(),
                agent: SessionGraphAgent {
                    provider: SessionAgentProvider::Codex,
                    model: None,
                    effort: None,
                },
                definition: graph,
                canvas: Default::default(),
                revision: 1,
            },
        )
    }

    fn prompt_group_graph(member_ids: &[&str], count: Option<u32>, max_nodes: u32) -> WorkGraph {
        let mut nodes = member_ids
            .iter()
            .enumerate()
            .map(|(index, id)| WorkGraphNode {
                id: (*id).to_string(),
                kind: WorkGraphNodeKind::Agent,
                title: format!("Placeholder {}", index + 1),
                instruction: "Generate this task at run time.".to_string(),
                group_id: Some("workers".to_string()),
                execution_mode: Some(WorkGraphExecutionMode::Parallel),
            })
            .collect::<Vec<_>>();
        nodes.push(node("goal", WorkGraphNodeKind::GoalSink));
        WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes,
            edges: vec![edge("workers-goal", "workers", "goal")],
            groups: vec![WorkGraphGroup {
                id: "workers".to_string(),
                title: "Workers".to_string(),
                direction: WorkGraphGroupDirection::LeftToRight,
                execution_mode: WorkGraphExecutionMode::Parallel,
                generation: WorkGraphGroupGeneration {
                    mode: WorkGraphGroupGenerationMode::Prompt,
                    count,
                    prompt: Some("Choose the useful implementation tasks.".to_string()),
                    max_nodes: Some(max_nodes),
                },
            }],
        }
    }

    fn materialize_with_response(run: &mut GraphRunState, response: &str) -> AppResult<bool> {
        let registry = crate::chat_runs::ChatRunRegistry::default();
        let session_id = Uuid::parse_str(&run.session_id).expect("session id");
        let cancellation = registry
            .start_graph(session_id, run.run_id.clone())
            .expect("claim graph run");
        materialize_prompt_groups(
            run,
            Arc::new(StaticExecutor {
                response: response.to_string(),
            }),
            cancellation,
        )
    }

    #[test]
    fn independent_entry_nodes_are_ready_together() {
        let mut run = run_for(WorkGraph {
            version: 1,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                node("a", WorkGraphNodeKind::Agent),
                node("b", WorkGraphNodeKind::Agent),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![edge("a-goal", "a", "goal"), edge("b-goal", "b", "goal")],
            groups: Vec::new(),
        });
        assert_eq!(ready_node_ids(&run), vec!["a", "b"]);

        let batch = select_execution_batch(&run, &ready_node_ids(&run));
        mark_batch_working(&mut run, &batch);
        let executor = Arc::new(ParallelProbeExecutor {
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
        });
        let registry = crate::chat_runs::ChatRunRegistry::default();
        let session_id = Uuid::parse_str(&run.session_id).expect("session id");
        let cancellation = registry
            .start_graph(session_id, run.run_id.clone())
            .expect("claim graph run");
        let results = execute_batch(
            &run,
            &batch,
            &HashMap::new(),
            executor.clone(),
            cancellation,
        )
        .expect("parallel batch executes");

        assert_eq!(results.len(), 2);
        assert!(executor.maximum.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn edge_animation_settles_after_the_target_completes() {
        let mut run = run_for(WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                node("build", WorkGraphNodeKind::Agent),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![edge("build-goal", "build", "goal")],
            groups: Vec::new(),
        });
        let build = run.nodes.get_mut("build").expect("build state");
        build.status = GraphNodeRunStatus::Completed;
        build.output = Some("done".to_string());

        refresh_edge_states(&mut run);
        let edge = run.edges.get("build-goal").expect("edge state");
        assert!(edge.active);
        assert!(!edge.traversed);

        run.nodes.get_mut("goal").expect("goal state").status = GraphNodeRunStatus::Completed;
        refresh_edge_states(&mut run);
        let edge = run.edges.get("build-goal").expect("edge state");
        assert!(!edge.active);
        assert!(edge.traversed);
    }

    #[test]
    fn stale_revision_does_not_block_a_cancel_for_the_same_run() {
        let mut run = run_for(WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                node("build", WorkGraphNodeKind::Agent),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![edge("build-goal", "build", "goal")],
            groups: Vec::new(),
        });
        run.revision = 9;

        validate_graph_cancel_identity(&run, &run.run_id, 3)
            .expect("a stale UI revision still identifies the active run");
        assert!(validate_graph_cancel_identity(&run, "another-run", 9).is_err());
    }

    #[test]
    fn dynamic_prompt_group_grows_with_stable_ids_and_boundary_edges() {
        let mut run = run_for(prompt_group_graph(&["agent-1"], None, 4));
        let generation_prompt =
            compile_group_generation_prompt(&run, "workers", None, 4, "Choose useful tasks.");
        assert!(generation_prompt.contains("between 1 and 4 tasks"));

        materialize_with_response(
            &mut run,
            r#"{"tasks":[{"title":"Research","instruction":"Inspect the current flow."},{"title":"Implement","instruction":"Make the requested change."},{"title":"Verify","instruction":"Run focused checks."}]}"#,
        )
        .expect("dynamic group materializes");

        let members = run
            .definition
            .nodes
            .iter()
            .filter(|node| node.group_id.as_deref() == Some("workers"))
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(members, vec!["agent-1", "agent-2", "agent-3"]);
        assert!(members
            .iter()
            .all(|node_id| run.nodes.contains_key(*node_id)));
        assert_eq!(
            run.definition.groups[0].generation.count,
            Some(3),
            "the run snapshot records the chosen count"
        );
        let boundary_edges = expand_work_graph_edges(&run.definition)
            .into_iter()
            .filter(|edge| edge.source_edge_id == "workers-goal")
            .collect::<Vec<_>>();
        assert_eq!(boundary_edges.len(), 3);
        assert_eq!(run.edges.len(), 1, "raw edge state remains group-scoped");
    }

    #[test]
    fn dynamic_prompt_group_removes_unused_slots_and_states() {
        let mut run = run_for(prompt_group_graph(
            &["agent-1", "agent-2", "agent-3"],
            None,
            4,
        ));

        materialize_with_response(
            &mut run,
            r#"{"tasks":[{"title":"Only task","instruction":"Complete the only useful task."}]}"#,
        )
        .expect("dynamic group shrinks");

        let members = run
            .definition
            .nodes
            .iter()
            .filter(|node| node.group_id.as_deref() == Some("workers"))
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(members, vec!["agent-1"]);
        assert!(!run.nodes.contains_key("agent-2"));
        assert!(!run.nodes.contains_key("agent-3"));
        assert_eq!(expand_work_graph_edges(&run.definition).len(), 1);
    }

    #[test]
    fn exact_prompt_group_count_remains_strict() {
        let mut run = run_for(prompt_group_graph(&["agent-1", "agent-2"], Some(2), 4));
        let error = materialize_with_response(
            &mut run,
            r#"{"tasks":[{"title":"Only task","instruction":"Complete one task."}]}"#,
        )
        .expect_err("fixed prompt count rejects a shorter plan");

        assert!(error.to_string().contains("expected 2"));
        assert_eq!(
            run.definition
                .nodes
                .iter()
                .filter(|node| node.group_id.as_deref() == Some("workers"))
                .count(),
            2
        );
        assert_eq!(run.nodes.len(), 3);
    }

    #[test]
    fn dynamic_prompt_group_count_stays_within_its_configured_bounds() {
        let mut empty_run = run_for(prompt_group_graph(&["agent-1"], None, 2));
        let empty_error = materialize_with_response(&mut empty_run, r#"{"tasks":[]}"#)
            .expect_err("a dynamic group needs at least one task");
        assert!(empty_error.to_string().contains("between 1 and 2"));

        let mut oversized_run = run_for(prompt_group_graph(&["agent-1"], None, 2));
        let oversized_error = materialize_with_response(
            &mut oversized_run,
            r#"{"tasks":[{"title":"One","instruction":"Run one."},{"title":"Two","instruction":"Run two."},{"title":"Three","instruction":"Run three."}]}"#,
        )
        .expect_err("a dynamic group cannot exceed max_nodes");
        assert!(oversized_error.to_string().contains("between 1 and 2"));
        assert_eq!(oversized_run.nodes.len(), 2, "the run remains unchanged");
    }

    #[test]
    fn graph_sequential_mode_limits_a_ready_frontier_to_one_node() {
        let run = run_for(WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Sequential,
            nodes: vec![
                node("a", WorkGraphNodeKind::Agent),
                node("b", WorkGraphNodeKind::Agent),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![edge("a-goal", "a", "goal"), edge("b-goal", "b", "goal")],
            groups: Vec::new(),
        });

        assert_eq!(
            select_execution_batch(&run, &ready_node_ids(&run)),
            vec!["a"]
        );
    }

    #[test]
    fn sequential_graph_runs_one_parallel_group_as_a_single_execution_unit() {
        let mut first = node("a", WorkGraphNodeKind::Agent);
        first.group_id = Some("workers".to_string());
        let mut second = node("b", WorkGraphNodeKind::Agent);
        second.group_id = Some("workers".to_string());
        let mut run = run_for(WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Sequential,
            nodes: vec![
                first,
                second,
                node("solo", WorkGraphNodeKind::Agent),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![
                edge("workers-goal", "workers", "goal"),
                edge("solo-goal", "solo", "goal"),
            ],
            groups: vec![WorkGraphGroup {
                id: "workers".to_string(),
                title: "Workers".to_string(),
                direction: WorkGraphGroupDirection::LeftToRight,
                execution_mode: WorkGraphExecutionMode::Parallel,
                generation: WorkGraphGroupGeneration {
                    mode: WorkGraphGroupGenerationMode::Fixed,
                    count: Some(2),
                    prompt: None,
                    max_nodes: Some(12),
                },
            }],
        });

        let ready = ready_node_ids(&run);
        assert_eq!(select_execution_batch(&run, &ready), vec!["a", "b"]);

        run.definition.groups[0].execution_mode = WorkGraphExecutionMode::Sequential;
        assert_eq!(select_execution_batch(&run, &ready), vec!["a"]);
    }

    #[test]
    fn ready_human_node_waits_without_entering_an_execution_batch() {
        let mut run = run_for(WorkGraph {
            version: 1,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                node("approve", WorkGraphNodeKind::Human),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![edge("approve-goal", "approve", "goal")],
            groups: Vec::new(),
        });
        let ready = ready_node_ids(&run);

        assert!(mark_human_nodes_waiting(&mut run, &ready));
        assert!(select_execution_batch(&run, &ready).is_empty());
        assert_eq!(
            run.nodes.get("approve").expect("human state").status,
            GraphNodeRunStatus::Waiting
        );
    }

    #[test]
    fn validator_parser_requires_a_leading_binary_verdict() {
        assert_eq!(
            parse_validator_output("PASS\nLooks good").expect("valid PASS"),
            (GraphNodeVerdict::Pass, "Looks good".to_string())
        );
        assert_eq!(
            parse_validator_output("VERDICT: FAIL\nMissing a test").expect("valid FAIL"),
            (GraphNodeVerdict::Fail, "Missing a test".to_string())
        );
        assert!(parse_validator_output("Maybe\nLooks okay").is_err());
        assert!(parse_validator_output("FAIL").is_err());
    }

    #[test]
    fn legacy_validator_retry_is_bounded() {
        let mut run = run_for(WorkGraph {
            version: 1,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                node("build", WorkGraphNodeKind::Agent),
                node("check", WorkGraphNodeKind::Validator),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![
                edge("build-check", "build", "check"),
                edge("check-goal", "check", "goal"),
            ],
            groups: Vec::new(),
        });
        let check = run.nodes.get_mut("check").expect("check state");
        check.status = GraphNodeRunStatus::Completed;
        check.verdict = Some(GraphNodeVerdict::Fail);
        check.output = Some("FAIL\nfix it".to_string());
        check.attempt = LEGACY_VALIDATOR_RETRY_LIMIT + 1;
        let mut context = HashMap::new();
        assert!(!apply_legacy_validator_retry(&mut run, &mut context));
        assert_eq!(
            run.nodes.get("check").expect("check state").status,
            GraphNodeRunStatus::Failed
        );
    }

    #[test]
    fn explicit_retry_edge_stops_at_its_limit() {
        let mut retry = edge("retry-build", "check", "build");
        retry.kind = WorkGraphEdgeKind::Retry;
        retry.condition = WorkGraphEdgeCondition::Fail;
        retry.retry_limit = Some(2);
        let mut pass = edge("check-goal", "check", "goal");
        pass.condition = WorkGraphEdgeCondition::Pass;
        let mut run = run_for(WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                node("build", WorkGraphNodeKind::Agent),
                node("check", WorkGraphNodeKind::Validator),
                node("goal", WorkGraphNodeKind::GoalSink),
            ],
            edges: vec![edge("build-check", "build", "check"), pass, retry],
            groups: Vec::new(),
        });
        let build = run.nodes.get_mut("build").expect("build state");
        build.status = GraphNodeRunStatus::Completed;
        build.output = Some("built".to_string());
        let check = run.nodes.get_mut("check").expect("check state");
        check.status = GraphNodeRunStatus::Completed;
        check.verdict = Some(GraphNodeVerdict::Fail);
        check.output = Some("FAIL\nstill broken".to_string());
        check.attempt = 3;
        run.edges
            .get_mut("retry-build")
            .expect("retry state")
            .retry_count = 2;

        assert!(!apply_explicit_retry(&mut run, &mut HashMap::new()));
        assert_eq!(
            run.nodes.get("build").expect("build state").status,
            GraphNodeRunStatus::Completed
        );
    }
}
