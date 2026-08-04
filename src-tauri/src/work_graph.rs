use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[cfg(test)]
pub use acorn_session::{GraphPromptContinuation, WorkGraphEdge, WorkGraphNode};
pub use acorn_session::{
    GraphPromptPlan, WorkGraph, WorkGraphEdgeCondition, WorkGraphEdgeKind, WorkGraphExecutionMode,
    WorkGraphGroupDirection, WorkGraphGroupGenerationMode, WorkGraphNodeKind,
    GRAPH_PROMPT_CONTINUATION_VERSION, GRAPH_PROMPT_PLAN_VERSION, LEGACY_WORK_GRAPH_VERSION,
    WORK_GRAPH_GOAL_ID, WORK_GRAPH_VERSION,
};
const MAX_NODES: usize = 24;
const MAX_EDGES: usize = 96;
const MAX_GROUPS: usize = 12;
const MAX_GROUP_NODES: usize = 12;
pub const DEFAULT_RETRY_LIMIT: u32 = 3;
pub const MAX_RETRY_LIMIT: u32 = 10;
const MAX_ID_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 120;
const MAX_INSTRUCTION_CHARS: usize = 1_200;
const MAX_TOTAL_INSTRUCTION_CHARS: usize = 8_000;
const MAX_CONTINUATION_CHECKPOINT_CHARS: usize = 8_000;

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

#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveWorkGraphEdge {
    pub id: String,
    pub source_edge_id: String,
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub condition: WorkGraphEdgeCondition,
    pub kind: WorkGraphEdgeKind,
    pub retry_limit: Option<u32>,
}

pub fn effective_retry_limit(edge: &EffectiveWorkGraphEdge) -> u32 {
    edge.retry_limit.unwrap_or(DEFAULT_RETRY_LIMIT)
}

fn group_members<'a>(
    graph: &'a WorkGraph,
    group_id: &str,
) -> Vec<&'a acorn_session::WorkGraphNode> {
    graph
        .nodes
        .iter()
        .filter(|node| node.group_id.as_deref() == Some(group_id))
        .collect()
}

fn group_boundary_members<'a>(
    graph: &'a WorkGraph,
    group_id: &str,
    entry: bool,
) -> Vec<&'a acorn_session::WorkGraphNode> {
    let members = group_members(graph, group_id);
    let member_ids = members
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    let connected = graph
        .edges
        .iter()
        .filter(|edge| {
            edge.kind == WorkGraphEdgeKind::Dependency
                && member_ids.contains(edge.from.as_str())
                && member_ids.contains(edge.to.as_str())
        })
        .map(|edge| {
            if entry {
                edge.to.as_str()
            } else {
                edge.from.as_str()
            }
        })
        .collect::<BTreeSet<_>>();
    members
        .into_iter()
        .filter(|node| !connected.contains(node.id.as_str()))
        .collect()
}

pub fn expand_work_graph_edges(graph: &WorkGraph) -> Vec<EffectiveWorkGraphEdge> {
    let node_ids = graph
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    let group_ids = graph
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut expanded = Vec::new();
    for edge in &graph.edges {
        let sources = if node_ids.contains(edge.from.as_str()) {
            vec![edge.from.as_str()]
        } else if group_ids.contains(edge.from.as_str()) {
            group_boundary_members(graph, &edge.from, false)
                .into_iter()
                .map(|node| node.id.as_str())
                .collect()
        } else {
            Vec::new()
        };
        let targets = if node_ids.contains(edge.to.as_str()) {
            vec![edge.to.as_str()]
        } else if group_ids.contains(edge.to.as_str()) {
            group_boundary_members(graph, &edge.to, true)
                .into_iter()
                .map(|node| node.id.as_str())
                .collect()
        } else {
            Vec::new()
        };
        for (source_index, source) in sources.iter().enumerate() {
            for (target_index, target) in targets.iter().enumerate() {
                let id = if sources.len() == 1 && targets.len() == 1 {
                    edge.id.clone()
                } else {
                    format!("{}-{}-{}", edge.id, source_index + 1, target_index + 1)
                };
                expanded.push(EffectiveWorkGraphEdge {
                    id,
                    source_edge_id: edge.id.clone(),
                    from: (*source).to_string(),
                    to: (*target).to_string(),
                    label: edge.label.clone(),
                    condition: edge.condition,
                    kind: edge.kind,
                    retry_limit: edge.retry_limit,
                });
            }
        }
    }
    expanded
}

pub fn validate_work_graph(graph: &WorkGraph) -> Result<(), String> {
    if !matches!(
        graph.version,
        LEGACY_WORK_GRAPH_VERSION | WORK_GRAPH_VERSION
    ) {
        return Err(format!("unsupported work graph version: {}", graph.version));
    }
    if graph.version == LEGACY_WORK_GRAPH_VERSION
        && (graph.execution_mode != WorkGraphExecutionMode::Parallel
            || !graph.groups.is_empty()
            || graph
                .nodes
                .iter()
                .any(|node| node.group_id.is_some() || node.execution_mode.is_some())
            || graph.edges.iter().any(|edge| {
                edge.label.is_some()
                    || edge.condition != WorkGraphEdgeCondition::Always
                    || edge.kind != WorkGraphEdgeKind::Dependency
                    || edge.retry_limit.is_some()
            }))
    {
        return Err("work graph version 1 cannot contain version 2 execution fields".to_string());
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
    if graph.groups.len() > MAX_GROUPS {
        return Err(format!(
            "a work graph can contain at most {MAX_GROUPS} groups"
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

    let mut group_ids = BTreeSet::new();
    for group in &graph.groups {
        let id_chars = group.id.chars().count();
        if id_chars == 0 || id_chars > MAX_ID_CHARS || !valid_stable_id(&group.id) {
            return Err(format!("invalid stable group id: {}", group.id));
        }
        if node_ids.contains(&group.id) {
            return Err(format!("node and group ids must be unique: {}", group.id));
        }
        if !group_ids.insert(group.id.clone()) {
            return Err(format!("duplicate group id: {}", group.id));
        }
        let title_chars = group.title.trim().chars().count();
        if title_chars == 0 || title_chars > MAX_TITLE_CHARS {
            return Err(format!("invalid title for group {}", group.id));
        }
        if let Some(count) = group.generation.count {
            if !(1..=MAX_GROUP_NODES as u32).contains(&count) {
                return Err(format!(
                    "group {} count must be between 1 and {MAX_GROUP_NODES}",
                    group.id
                ));
            }
        }
        if let Some(max_nodes) = group.generation.max_nodes {
            if !(1..=MAX_GROUP_NODES as u32).contains(&max_nodes) {
                return Err(format!(
                    "group {} max_nodes must be between 1 and {MAX_GROUP_NODES}",
                    group.id
                ));
            }
        }
        if group
            .generation
            .count
            .zip(group.generation.max_nodes)
            .is_some_and(|(count, max_nodes)| count > max_nodes)
        {
            return Err(format!("group {} count cannot exceed max_nodes", group.id));
        }
        if group.generation.mode == WorkGraphGroupGenerationMode::Prompt
            && group
                .generation
                .prompt
                .as_deref()
                .is_none_or(|prompt| prompt.trim().is_empty())
        {
            return Err(format!(
                "prompt-generated group {} needs a generation prompt",
                group.id
            ));
        }
        if group
            .generation
            .prompt
            .as_deref()
            .is_some_and(|prompt| prompt.trim().chars().count() > MAX_INSTRUCTION_CHARS)
        {
            return Err(format!("group {} generation prompt is too long", group.id));
        }
    }
    for node in &graph.nodes {
        if node.kind == WorkGraphNodeKind::GoalSink && node.group_id.is_some() {
            return Err("the GOAL node cannot belong to a group".to_string());
        }
        if let Some(group_id) = node.group_id.as_deref() {
            if !group_ids.contains(group_id) {
                return Err(format!(
                    "node {} belongs to unknown group: {group_id}",
                    node.id
                ));
            }
        }
    }
    for group in &graph.groups {
        let members = group_members(graph, &group.id);
        let member_count = members.len();
        if member_count == 0 {
            return Err(format!("group {} needs at least one node", group.id));
        }
        if member_count > MAX_GROUP_NODES {
            return Err(format!(
                "group {} can contain at most {MAX_GROUP_NODES} nodes",
                group.id
            ));
        }
        if group.generation.mode == WorkGraphGroupGenerationMode::Prompt {
            let member_ids = members
                .into_iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>();
            if graph.edges.iter().any(|edge| {
                member_ids.contains(edge.from.as_str()) || member_ids.contains(edge.to.as_str())
            }) {
                return Err(format!(
                    "prompt-generated group {} must connect through its group boundary",
                    group.id
                ));
            }
        }
    }

    let mut edge_ids = BTreeSet::new();
    let mut endpoint_pairs = BTreeSet::new();
    let endpoint_ids = node_ids
        .iter()
        .chain(group_ids.iter())
        .map(String::as_str)
        .collect::<BTreeSet<_>>();

    for edge in &graph.edges {
        let id_chars = edge.id.chars().count();
        if id_chars == 0 || id_chars > MAX_ID_CHARS || !valid_stable_id(&edge.id) {
            return Err(format!("invalid stable edge id: {}", edge.id));
        }
        if !edge_ids.insert(edge.id.clone()) {
            return Err(format!("duplicate edge id: {}", edge.id));
        }
        if !endpoint_ids.contains(edge.from.as_str()) {
            return Err(format!(
                "edge {} has unknown source: {}",
                edge.id, edge.from
            ));
        }
        if !endpoint_ids.contains(edge.to.as_str()) {
            return Err(format!("edge {} has unknown target: {}", edge.id, edge.to));
        }
        if edge.from == edge.to {
            return Err(format!("edge {} cannot connect a node to itself", edge.id));
        }
        if edge.from == WORK_GRAPH_GOAL_ID {
            return Err("GOAL cannot have outgoing edges".to_string());
        }
        if !endpoint_pairs.insert((
            edge.kind,
            edge.from.as_str(),
            edge.to.as_str(),
            edge.condition,
        )) {
            return Err(format!(
                "duplicate execution edge: {} -> {}",
                edge.from, edge.to
            ));
        }
        if let Some(label) = edge.label.as_deref() {
            if label.trim().chars().count() > MAX_TITLE_CHARS {
                return Err(format!("edge {} label is too long", edge.id));
            }
        }
        if edge.kind == WorkGraphEdgeKind::Retry {
            let retry_limit = edge.retry_limit.unwrap_or(DEFAULT_RETRY_LIMIT);
            if !(1..=MAX_RETRY_LIMIT).contains(&retry_limit) {
                return Err(format!(
                    "retry edge {} limit must be between 1 and {MAX_RETRY_LIMIT}",
                    edge.id
                ));
            }
        }
    }

    let effective_edges = expand_work_graph_edges(graph);
    let dependency_edges = effective_edges
        .iter()
        .filter(|edge| edge.kind == WorkGraphEdgeKind::Dependency)
        .collect::<Vec<_>>();
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
    for edge in &dependency_edges {
        outgoing
            .get_mut(edge.from.as_str())
            .expect("known effective edge source")
            .push(edge.to.as_str());
        reverse
            .get_mut(edge.to.as_str())
            .expect("known effective edge target")
            .push(edge.from.as_str());
        *indegree
            .get_mut(edge.to.as_str())
            .expect("known effective edge target") += 1;
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

    let kinds = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.kind))
        .collect::<BTreeMap<_, _>>();
    let mut retry_sources = BTreeMap::new();
    for edge in effective_edges
        .iter()
        .filter(|edge| edge.kind == WorkGraphEdgeKind::Dependency)
    {
        let source_kind = kinds
            .get(edge.from.as_str())
            .copied()
            .expect("known dependency source");
        let condition_is_valid = match edge.condition {
            WorkGraphEdgeCondition::Always => true,
            WorkGraphEdgeCondition::Pass | WorkGraphEdgeCondition::Fail => {
                source_kind == WorkGraphNodeKind::Validator
            }
            WorkGraphEdgeCondition::Approved | WorkGraphEdgeCondition::Rejected => {
                source_kind == WorkGraphNodeKind::Human
            }
        };
        if !condition_is_valid {
            return Err(format!(
                "edge {} condition is incompatible with source node {}",
                edge.source_edge_id, edge.from
            ));
        }
    }
    for edge in effective_edges
        .iter()
        .filter(|edge| edge.kind == WorkGraphEdgeKind::Retry)
    {
        let source_kind = kinds
            .get(edge.from.as_str())
            .copied()
            .expect("known retry source");
        if !matches!(
            source_kind,
            WorkGraphNodeKind::Validator | WorkGraphNodeKind::Human
        ) {
            return Err(format!(
                "retry edge {} must start at a validator or human node",
                edge.source_edge_id
            ));
        }
        let (expected_condition, expected_condition_name) = match source_kind {
            WorkGraphNodeKind::Validator => (WorkGraphEdgeCondition::Fail, "fail"),
            WorkGraphNodeKind::Human => (WorkGraphEdgeCondition::Rejected, "rejected"),
            _ => unreachable!("retry source kind was validated above"),
        };
        if edge.condition != expected_condition {
            return Err(format!(
                "retry edge {} from {} must use the {} condition",
                edge.source_edge_id, edge.from, expected_condition_name
            ));
        }
        if let Some(previous) =
            retry_sources.insert(edge.from.as_str(), edge.source_edge_id.as_str())
        {
            if previous != edge.source_edge_id {
                return Err(format!("node {} can have only one retry rule", edge.from));
            }
        }
        let target_kind = kinds
            .get(edge.to.as_str())
            .copied()
            .expect("known retry target");
        if !matches!(
            target_kind,
            WorkGraphNodeKind::Agent | WorkGraphNodeKind::Merge
        ) {
            return Err(format!(
                "retry edge {} must target an agent or merge node",
                edge.source_edge_id
            ));
        }
        let mut stack = vec![edge.to.as_str()];
        let mut visited = BTreeSet::new();
        let mut reaches_source = false;
        while let Some(id) = stack.pop() {
            if !visited.insert(id) {
                continue;
            }
            if id == edge.from.as_str() {
                reaches_source = true;
                break;
            }
            stack.extend(outgoing.get(id).into_iter().flatten().copied());
        }
        if !reaches_source {
            return Err(format!(
                "retry edge {} target must be an upstream dependency of its source",
                edge.source_edge_id
            ));
        }
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
    let append_node =
        |lines: &mut Vec<String>, node: &acorn_session::WorkGraphNode, indent: &str| {
            let alias = aliases.get(node.id.as_str()).expect("node alias");
            if node.kind == WorkGraphNodeKind::GoalSink {
                lines.push(format!("{indent}{alias}((GOAL))"));
                return;
            }
            let label = format!(
                "{}<br/>[{}] {}<br/>{}",
                mermaid_text(&node.id),
                node_kind_label(node.kind),
                mermaid_text(&node.title),
                mermaid_text(&node.instruction)
            );
            lines.push(format!("{indent}{alias}[\"{label}\"]"));
        };
    for node in nodes.iter().copied().filter(|node| node.group_id.is_none()) {
        append_node(&mut lines, node, "  ");
    }
    let mut groups = graph.groups.iter().collect::<Vec<_>>();
    groups.sort_by(|a, b| a.id.cmp(&b.id));
    for (index, group) in groups.into_iter().enumerate() {
        lines.push(format!(
            "  subgraph g{index}[\"{}\"]",
            mermaid_text(&group.title)
        ));
        let direction = match group.direction {
            WorkGraphGroupDirection::LeftToRight => "LR",
            WorkGraphGroupDirection::TopDown => "TD",
        };
        lines.push(format!("    direction {direction}"));
        for node in nodes
            .iter()
            .copied()
            .filter(|node| node.group_id.as_deref() == Some(group.id.as_str()))
        {
            append_node(&mut lines, node, "    ");
        }
        lines.push("  end".to_string());
    }
    let mut edges = expand_work_graph_edges(graph);
    edges.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then_with(|| a.to.cmp(&b.to))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut seen = BTreeSet::new();
    for edge in edges {
        let connector = if edge.kind == WorkGraphEdgeKind::Retry {
            "-.->"
        } else {
            "-->"
        };
        let condition = match edge.condition {
            WorkGraphEdgeCondition::Always => None,
            WorkGraphEdgeCondition::Pass => Some("pass"),
            WorkGraphEdgeCondition::Fail => Some("fail"),
            WorkGraphEdgeCondition::Approved => Some("approved"),
            WorkGraphEdgeCondition::Rejected => Some("rejected"),
        };
        let label = [edge.label.as_deref().map(str::trim), condition]
            .into_iter()
            .flatten()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" / ");
        let connector = if label.is_empty() {
            connector.to_string()
        } else {
            format!("{connector}|{}|", mermaid_text(&label))
        };
        let rendered = format!(
            "  {} {connector} {}",
            aliases.get(edge.from.as_str()).expect("source alias"),
            aliases.get(edge.to.as_str()).expect("target alias")
        );
        if seen.insert(rendered.clone()) {
            lines.push(rendered);
        }
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
    use acorn_session::{WorkGraphGroup, WorkGraphGroupGeneration, WorkGraphGroupGenerationMode};

    fn valid_graph() -> WorkGraph {
        WorkGraph {
            version: 1,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                WorkGraphNode {
                    id: "goal".to_string(),
                    kind: WorkGraphNodeKind::GoalSink,
                    title: "GOAL".to_string(),
                    instruction: String::new(),
                    group_id: None,
                    execution_mode: None,
                },
                WorkGraphNode {
                    id: "build".to_string(),
                    kind: WorkGraphNodeKind::Agent,
                    title: "Build feature".to_string(),
                    instruction: "Implement the requested feature.".to_string(),
                    group_id: None,
                    execution_mode: None,
                },
                WorkGraphNode {
                    id: "check".to_string(),
                    kind: WorkGraphNodeKind::Validator,
                    title: "Verify".to_string(),
                    instruction: "Return PASS or FAIL with a concrete critique.".to_string(),
                    group_id: None,
                    execution_mode: None,
                },
            ],
            edges: vec![
                WorkGraphEdge {
                    id: "check-goal".to_string(),
                    from: "check".to_string(),
                    to: "goal".to_string(),
                    label: None,
                    condition: WorkGraphEdgeCondition::Always,
                    kind: WorkGraphEdgeKind::Dependency,
                    retry_limit: None,
                },
                WorkGraphEdge {
                    id: "build-check".to_string(),
                    from: "build".to_string(),
                    to: "check".to_string(),
                    label: None,
                    condition: WorkGraphEdgeCondition::Always,
                    kind: WorkGraphEdgeKind::Dependency,
                    retry_limit: None,
                },
            ],
            groups: Vec::new(),
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
            label: None,
            condition: WorkGraphEdgeCondition::Always,
            kind: WorkGraphEdgeKind::Dependency,
            retry_limit: None,
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
            group_id: None,
            execution_mode: None,
        });
        assert!(validate_work_graph(&orphan)
            .expect_err("orphan rejected")
            .contains("no path to GOAL"));
    }

    #[test]
    fn v2_group_boundary_edges_expand_deterministically() {
        let graph = WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                WorkGraphNode {
                    id: "agent-a".to_string(),
                    kind: WorkGraphNodeKind::Agent,
                    title: "A".to_string(),
                    instruction: "Run A".to_string(),
                    group_id: Some("workers".to_string()),
                    execution_mode: None,
                },
                WorkGraphNode {
                    id: "agent-b".to_string(),
                    kind: WorkGraphNodeKind::Agent,
                    title: "B".to_string(),
                    instruction: "Run B".to_string(),
                    group_id: Some("workers".to_string()),
                    execution_mode: None,
                },
                WorkGraphNode {
                    id: "goal".to_string(),
                    kind: WorkGraphNodeKind::GoalSink,
                    title: "GOAL".to_string(),
                    instruction: String::new(),
                    group_id: None,
                    execution_mode: None,
                },
            ],
            edges: vec![WorkGraphEdge {
                id: "workers-goal".to_string(),
                from: "workers".to_string(),
                to: "goal".to_string(),
                label: None,
                condition: WorkGraphEdgeCondition::Always,
                kind: WorkGraphEdgeKind::Dependency,
                retry_limit: None,
            }],
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
        };

        validate_work_graph(&graph).expect("v2 group graph validates");
        let edges = expand_work_graph_edges(&graph);
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].id, "workers-goal-1-1");
        assert_eq!(edges[0].from, "agent-a");
        assert_eq!(edges[1].id, "workers-goal-2-1");
        assert_eq!(edges[1].from, "agent-b");
    }

    #[test]
    fn prompt_generated_group_rejects_direct_member_edges() {
        let mut graph = WorkGraph {
            version: 2,
            execution_mode: WorkGraphExecutionMode::Parallel,
            nodes: vec![
                WorkGraphNode {
                    id: "agent-1".to_string(),
                    kind: WorkGraphNodeKind::Agent,
                    title: "Placeholder".to_string(),
                    instruction: "Generate this task at run time.".to_string(),
                    group_id: Some("workers".to_string()),
                    execution_mode: Some(WorkGraphExecutionMode::Parallel),
                },
                WorkGraphNode {
                    id: "goal".to_string(),
                    kind: WorkGraphNodeKind::GoalSink,
                    title: "GOAL".to_string(),
                    instruction: String::new(),
                    group_id: None,
                    execution_mode: None,
                },
            ],
            edges: vec![WorkGraphEdge {
                id: "workers-goal".to_string(),
                from: "workers".to_string(),
                to: "goal".to_string(),
                label: None,
                condition: WorkGraphEdgeCondition::Always,
                kind: WorkGraphEdgeKind::Dependency,
                retry_limit: None,
            }],
            groups: vec![WorkGraphGroup {
                id: "workers".to_string(),
                title: "Workers".to_string(),
                direction: WorkGraphGroupDirection::LeftToRight,
                execution_mode: WorkGraphExecutionMode::Parallel,
                generation: WorkGraphGroupGeneration {
                    mode: WorkGraphGroupGenerationMode::Prompt,
                    count: None,
                    prompt: Some("Choose useful research tasks.".to_string()),
                    max_nodes: Some(4),
                },
            }],
        };

        validate_work_graph(&graph).expect("group-boundary edge validates");
        graph.edges[0].from = "agent-1".to_string();
        assert!(validate_work_graph(&graph)
            .expect_err("direct prompt member edge must be rejected")
            .contains("must connect through its group boundary"));
    }

    #[test]
    fn v2_retry_edge_is_bounded_and_excluded_from_dependency_cycle_check() {
        let mut graph = valid_graph();
        graph.version = 2;
        graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "check-goal")
            .expect("validator edge")
            .condition = WorkGraphEdgeCondition::Pass;
        graph.edges.push(WorkGraphEdge {
            id: "retry-build".to_string(),
            from: "check".to_string(),
            to: "build".to_string(),
            label: Some("retry".to_string()),
            condition: WorkGraphEdgeCondition::Fail,
            kind: WorkGraphEdgeKind::Retry,
            retry_limit: Some(2),
        });

        validate_work_graph(&graph).expect("bounded retry transition validates");
        let retry = expand_work_graph_edges(&graph)
            .into_iter()
            .find(|edge| edge.kind == WorkGraphEdgeKind::Retry)
            .expect("retry edge expands");
        assert_eq!(effective_retry_limit(&retry), 2);
    }

    #[test]
    fn retry_edges_require_the_negative_gate_outcome() {
        let mut validator_graph = valid_graph();
        validator_graph.version = 2;
        validator_graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "check-goal")
            .expect("validator edge")
            .condition = WorkGraphEdgeCondition::Pass;
        validator_graph.edges.push(WorkGraphEdge {
            id: "retry-build".to_string(),
            from: "check".to_string(),
            to: "build".to_string(),
            label: None,
            condition: WorkGraphEdgeCondition::Pass,
            kind: WorkGraphEdgeKind::Retry,
            retry_limit: Some(2),
        });
        assert!(validate_work_graph(&validator_graph)
            .expect_err("PASS cannot trigger a validator retry")
            .contains("must use the fail condition"));

        let mut human_graph = valid_graph();
        human_graph.version = 2;
        human_graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "check")
            .expect("gate node")
            .kind = WorkGraphNodeKind::Human;
        human_graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "check-goal")
            .expect("human edge")
            .condition = WorkGraphEdgeCondition::Approved;
        human_graph.edges.push(WorkGraphEdge {
            id: "retry-build".to_string(),
            from: "check".to_string(),
            to: "build".to_string(),
            label: None,
            condition: WorkGraphEdgeCondition::Approved,
            kind: WorkGraphEdgeKind::Retry,
            retry_limit: Some(2),
        });
        assert!(validate_work_graph(&human_graph)
            .expect_err("approval cannot trigger a Human retry")
            .contains("must use the rejected condition"));
    }

    #[test]
    fn one_retry_rule_can_expand_across_a_group_boundary() {
        let mut graph = valid_graph();
        graph.version = 2;
        let build = graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "build")
            .expect("build node");
        build.group_id = Some("workers".to_string());
        graph.nodes.push(WorkGraphNode {
            id: "build-b".to_string(),
            kind: WorkGraphNodeKind::Agent,
            title: "Build B".to_string(),
            instruction: "Implement branch B.".to_string(),
            group_id: Some("workers".to_string()),
            execution_mode: None,
        });
        graph.groups.push(WorkGraphGroup {
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
        });
        graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "build-check")
            .expect("build dependency")
            .from = "workers".to_string();
        graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "check-goal")
            .expect("validator edge")
            .condition = WorkGraphEdgeCondition::Pass;
        graph.edges.push(WorkGraphEdge {
            id: "retry-workers".to_string(),
            from: "check".to_string(),
            to: "workers".to_string(),
            label: None,
            condition: WorkGraphEdgeCondition::Fail,
            kind: WorkGraphEdgeKind::Retry,
            retry_limit: Some(2),
        });

        validate_work_graph(&graph).expect("one raw retry rule may fan out to a group");
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
