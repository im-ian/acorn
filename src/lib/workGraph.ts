export const GRAPH_PROMPT_PLAN_VERSION = 1 as const;
export const GRAPH_PROMPT_CONTINUATION_VERSION = 1 as const;
export const WORK_GRAPH_VERSION = 2 as const;
export const LEGACY_WORK_GRAPH_VERSION = 1 as const;
export const WORK_GRAPH_GOAL_ID = "goal" as const;

export const WORK_GRAPH_LIMITS = {
  maxNodes: 24,
  maxEdges: 96,
  maxIdLength: 64,
  maxTitleLength: 120,
  maxInstructionLength: 1_200,
  maxTotalInstructionLength: 8_000,
  maxGroups: 12,
  maxGroupNodes: 12,
  maxRetryLimit: 10,
} as const;

export type WorkGraphVersion =
  | typeof LEGACY_WORK_GRAPH_VERSION
  | typeof WORK_GRAPH_VERSION;

export type WorkGraphExecutionMode = "parallel" | "sequential";
export type WorkGraphGroupDirection = "LR" | "TD";
export type WorkGraphGroupGenerationMode = "fixed" | "prompt";
export type WorkGraphEdgeCondition =
  | "always"
  | "pass"
  | "fail"
  | "approved"
  | "rejected";
export type WorkGraphEdgeKind = "dependency" | "retry";

export type WorkGraphNodeKind =
  | "agent"
  | "validator"
  | "merge"
  | "human"
  | "goal_sink";

const WORK_GRAPH_NODE_KINDS = new Set<WorkGraphNodeKind>([
  "agent",
  "validator",
  "merge",
  "human",
  "goal_sink",
]);

export interface WorkGraphNode {
  id: string;
  kind: WorkGraphNodeKind;
  title: string;
  instruction: string;
  group_id?: string | null;
  execution_mode?: WorkGraphExecutionMode | null;
}

export interface WorkGraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string | null;
  condition?: WorkGraphEdgeCondition;
  kind?: WorkGraphEdgeKind;
  retry_limit?: number | null;
}

export interface WorkGraphGroupGeneration {
  mode: WorkGraphGroupGenerationMode;
  count?: number | null;
  prompt?: string | null;
  max_nodes?: number | null;
}

export interface WorkGraphGroup {
  id: string;
  title: string;
  direction: WorkGraphGroupDirection;
  execution_mode: WorkGraphExecutionMode;
  generation: WorkGraphGroupGeneration;
}

export interface WorkGraph {
  version: WorkGraphVersion;
  execution_mode?: WorkGraphExecutionMode;
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  groups?: WorkGraphGroup[];
}

export interface GraphPromptContinuation {
  version: typeof GRAPH_PROMPT_CONTINUATION_VERSION;
}

export type GraphPromptPlan =
  | {
      version: typeof GRAPH_PROMPT_PLAN_VERSION;
      mode: "automatic";
      continuation?: GraphPromptContinuation;
    }
  | {
      version: typeof GRAPH_PROMPT_PLAN_VERSION;
      mode: "manual";
      graph: WorkGraph;
      continuation?: GraphPromptContinuation;
    };

export interface WorkGraphValidationResult {
  valid: boolean;
  errors: string[];
}

export type WorkGraphNodeConnectivityWarning =
  | "isolated"
  | "no_goal_path";

export const AUTOMATIC_GRAPH_PROMPT_PLAN: GraphPromptPlan = Object.freeze({
  version: GRAPH_PROMPT_PLAN_VERSION,
  mode: "automatic",
});

export function createEmptyWorkGraph(): WorkGraph {
  return {
    version: WORK_GRAPH_VERSION,
    execution_mode: "sequential",
    nodes: [
      {
        id: WORK_GRAPH_GOAL_ID,
        kind: "goal_sink",
        title: "GOAL",
        instruction: "",
      },
    ],
    edges: [],
    groups: [],
  };
}

function validStableId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const WORK_GRAPH_EXECUTION_MODES = new Set<WorkGraphExecutionMode>([
  "parallel",
  "sequential",
]);
const WORK_GRAPH_EDGE_CONDITIONS = new Set<WorkGraphEdgeCondition>([
  "always",
  "pass",
  "fail",
  "approved",
  "rejected",
]);
const WORK_GRAPH_EDGE_KINDS = new Set<WorkGraphEdgeKind>([
  "dependency",
  "retry",
]);

export interface EffectiveWorkGraphEdge extends WorkGraphEdge {
  source_edge_id: string;
}

export function workGraphGroups(graph: WorkGraph): WorkGraphGroup[] {
  return graph.groups ?? [];
}

export function workGraphExecutionMode(
  graph: WorkGraph,
): WorkGraphExecutionMode {
  return graph.execution_mode ?? "parallel";
}

export function workGraphEdgeKind(edge: WorkGraphEdge): WorkGraphEdgeKind {
  return edge.kind ?? "dependency";
}

export function workGraphEdgeCondition(
  edge: WorkGraphEdge,
): WorkGraphEdgeCondition {
  return edge.condition ?? "always";
}

function groupMembers(
  graph: WorkGraph,
  groupId: string,
): WorkGraphNode[] {
  return graph.nodes.filter((node) => node.group_id === groupId);
}

function groupBoundaryMembers(
  graph: WorkGraph,
  groupId: string,
  boundary: "entry" | "exit",
): WorkGraphNode[] {
  const members = groupMembers(graph, groupId);
  const memberIds = new Set(members.map((node) => node.id));
  const internalDependencies = graph.edges.filter(
    (edge) =>
      workGraphEdgeKind(edge) === "dependency" &&
      memberIds.has(edge.from) &&
      memberIds.has(edge.to),
  );
  const connected = new Set(
    internalDependencies.map((edge) =>
      boundary === "entry" ? edge.to : edge.from,
    ),
  );
  return members.filter((node) => !connected.has(node.id));
}

export function expandWorkGraphEdges(graph: WorkGraph): EffectiveWorkGraphEdge[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const groupIds = new Set(workGraphGroups(graph).map((group) => group.id));
  const expanded: EffectiveWorkGraphEdge[] = [];
  for (const edge of graph.edges) {
    const sources = nodeIds.has(edge.from)
      ? [edge.from]
      : groupIds.has(edge.from)
        ? groupBoundaryMembers(graph, edge.from, "exit").map((node) => node.id)
        : [];
    const targets = nodeIds.has(edge.to)
      ? [edge.to]
      : groupIds.has(edge.to)
        ? groupBoundaryMembers(graph, edge.to, "entry").map((node) => node.id)
        : [];
    for (const [sourceIndex, source] of sources.entries()) {
      for (const [targetIndex, target] of targets.entries()) {
        expanded.push({
          ...edge,
          id:
            sources.length === 1 && targets.length === 1
              ? edge.id
              : `${edge.id}-${sourceIndex + 1}-${targetIndex + 1}`,
          from: source,
          to: target,
          source_edge_id: edge.id,
        });
      }
    }
  }
  return expanded;
}

export function workGraphNodeConnectivityWarnings(
  graph: WorkGraph,
): Map<string, WorkGraphNodeConnectivityWarning> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const dependencyEdges = expandWorkGraphEdges(graph).filter(
    (edge) =>
      workGraphEdgeKind(edge) === "dependency" &&
      nodeIds.has(edge.from) &&
      nodeIds.has(edge.to),
  );
  const incident = new Set<string>();
  const reverse = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of dependencyEdges) {
    incident.add(edge.from);
    incident.add(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }

  const reachesGoal = new Set<string>();
  const pending: string[] = graph.nodes.some(
    (node) => node.id === WORK_GRAPH_GOAL_ID,
  )
    ? [WORK_GRAPH_GOAL_ID]
    : [];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachesGoal.has(id)) continue;
    reachesGoal.add(id);
    pending.push(...(reverse.get(id) ?? []));
  }

  const warnings = new Map<string, WorkGraphNodeConnectivityWarning>();
  for (const node of graph.nodes) {
    if (!incident.has(node.id)) {
      warnings.set(node.id, "isolated");
    } else if (
      node.kind !== "goal_sink" &&
      !reachesGoal.has(node.id)
    ) {
      warnings.set(node.id, "no_goal_path");
    }
  }
  return warnings;
}

export function validateWorkGraph(graph: WorkGraph): WorkGraphValidationResult {
  const errors: string[] = [];
  if (
    graph.version !== LEGACY_WORK_GRAPH_VERSION &&
    graph.version !== WORK_GRAPH_VERSION
  ) {
    errors.push(`Unsupported work graph version: ${String(graph.version)}`);
  }
  if (
    graph.execution_mode !== undefined &&
    !WORK_GRAPH_EXECUTION_MODES.has(graph.execution_mode)
  ) {
    errors.push(`Unsupported graph execution mode: ${String(graph.execution_mode)}`);
  }
  if (
    graph.version === LEGACY_WORK_GRAPH_VERSION &&
    (workGraphExecutionMode(graph) !== "parallel" ||
      workGraphGroups(graph).length > 0 ||
      graph.nodes.some(
        (node) =>
          Boolean(node.group_id) ||
          (node.execution_mode !== undefined && node.execution_mode !== null),
      ) ||
      graph.edges.some(
        (edge) =>
          (edge.label !== undefined && edge.label !== null) ||
          workGraphEdgeCondition(edge) !== "always" ||
          workGraphEdgeKind(edge) !== "dependency" ||
          (edge.retry_limit !== undefined && edge.retry_limit !== null),
      ))
  ) {
    errors.push("Work graph version 1 cannot contain version 2 execution fields.");
  }
  if (graph.nodes.length > WORK_GRAPH_LIMITS.maxNodes) {
    errors.push(`A work graph can contain at most ${WORK_GRAPH_LIMITS.maxNodes} nodes.`);
  }
  if (graph.edges.length > WORK_GRAPH_LIMITS.maxEdges) {
    errors.push(`A work graph can contain at most ${WORK_GRAPH_LIMITS.maxEdges} edges.`);
  }

  const groups = workGraphGroups(graph);
  if (groups.length > WORK_GRAPH_LIMITS.maxGroups) {
    errors.push(`A work graph can contain at most ${WORK_GRAPH_LIMITS.maxGroups} groups.`);
  }

  const groupIds = new Set<string>();
  for (const group of groups) {
    if (
      !group.id ||
      characterCount(group.id) > WORK_GRAPH_LIMITS.maxIdLength ||
      !validStableId(group.id)
    ) {
      errors.push(`Invalid stable group id: ${group.id}`);
    }
    if (groupIds.has(group.id)) errors.push(`Duplicate group id: ${group.id}`);
    groupIds.add(group.id);
    if (!group.title.trim()) errors.push(`Group ${group.id || "(unnamed)"} needs a title.`);
    if (characterCount(group.title.trim()) > WORK_GRAPH_LIMITS.maxTitleLength) {
      errors.push(`Group ${group.id} title is too long.`);
    }
    if (group.direction !== "LR" && group.direction !== "TD") {
      errors.push(`Unsupported group direction for ${group.id}: ${String(group.direction)}`);
    }
    if (!WORK_GRAPH_EXECUTION_MODES.has(group.execution_mode)) {
      errors.push(
        `Unsupported group execution mode for ${group.id}: ${String(group.execution_mode)}`,
      );
    }
    if (group.generation.mode !== "fixed" && group.generation.mode !== "prompt") {
      errors.push(
        `Unsupported group generation mode for ${group.id}: ${String(group.generation.mode)}`,
      );
    }
    const count = group.generation.count;
    if (
      count !== undefined &&
      count !== null &&
      (!Number.isInteger(count) || count < 1 || count > WORK_GRAPH_LIMITS.maxGroupNodes)
    ) {
      errors.push(
        `Group ${group.id} count must be between 1 and ${WORK_GRAPH_LIMITS.maxGroupNodes}.`,
      );
    }
    const maxNodes = group.generation.max_nodes;
    if (
      maxNodes !== undefined &&
      maxNodes !== null &&
      (!Number.isInteger(maxNodes) ||
        maxNodes < 1 ||
        maxNodes > WORK_GRAPH_LIMITS.maxGroupNodes)
    ) {
      errors.push(
        `Group ${group.id} max nodes must be between 1 and ${WORK_GRAPH_LIMITS.maxGroupNodes}.`,
      );
    }
    if (
      group.generation.mode === "prompt" &&
      !group.generation.prompt?.trim()
    ) {
      errors.push(`Prompt-generated group ${group.id} needs a generation prompt.`);
    }
    if (
      group.generation.count !== undefined &&
      group.generation.count !== null &&
      group.generation.max_nodes !== undefined &&
      group.generation.max_nodes !== null &&
      group.generation.count > group.generation.max_nodes
    ) {
      errors.push(`Group ${group.id} count cannot exceed max nodes.`);
    }
    if (
      group.generation.prompt &&
      characterCount(group.generation.prompt.trim()) >
        WORK_GRAPH_LIMITS.maxInstructionLength
    ) {
      errors.push(`Group ${group.id} generation prompt is too long.`);
    }
  }

  const nodeIds = new Set<string>();
  let totalInstructionLength = 0;
  for (const node of graph.nodes) {
    if (
      !node.id ||
      characterCount(node.id) > WORK_GRAPH_LIMITS.maxIdLength ||
      !validStableId(node.id)
    ) {
      errors.push(
        `Node id "${node.id}" must start with a letter and contain only letters, numbers, _ or - (${WORK_GRAPH_LIMITS.maxIdLength} characters max).`,
      );
    }
    if (nodeIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    if (groupIds.has(node.id)) {
      errors.push(`Node and group ids must be unique: ${node.id}`);
    }

    if (!WORK_GRAPH_NODE_KINDS.has(node.kind)) {
      errors.push(`Unsupported node kind for ${node.id || "(unnamed)"}: ${String(node.kind)}`);
      continue;
    }

    if (node.kind === "goal_sink") {
      if (
        node.id !== WORK_GRAPH_GOAL_ID ||
        node.title !== "GOAL" ||
        node.instruction !== ""
      ) {
        errors.push("The GOAL node must use the fixed goal sink contract.");
      }
      if (node.group_id) errors.push("The GOAL node cannot belong to a group.");
      continue;
    }

    if (node.group_id && !groupIds.has(node.group_id)) {
      errors.push(`Node ${node.id} belongs to unknown group: ${node.group_id}`);
    }
    if (
      node.execution_mode !== undefined &&
      node.execution_mode !== null &&
      !WORK_GRAPH_EXECUTION_MODES.has(node.execution_mode)
    ) {
      errors.push(
        `Unsupported node execution mode for ${node.id}: ${String(node.execution_mode)}`,
      );
    }

    const title = node.title.trim();
    const instruction = node.instruction.trim();
    if (!title) errors.push(`Node ${node.id || "(unnamed)"} needs a title.`);
    if (characterCount(title) > WORK_GRAPH_LIMITS.maxTitleLength) {
      errors.push(`Node ${node.id} title is too long.`);
    }
    if (!instruction) {
      errors.push(`Node ${node.id || "(unnamed)"} needs an instruction.`);
    }
    if (characterCount(instruction) > WORK_GRAPH_LIMITS.maxInstructionLength) {
      errors.push(`Node ${node.id} instruction is too long.`);
    }
    totalInstructionLength += characterCount(instruction);
  }
  if (totalInstructionLength > WORK_GRAPH_LIMITS.maxTotalInstructionLength) {
    errors.push("The combined node instructions are too long.");
  }

  const goalNodes = graph.nodes.filter((node) => node.kind === "goal_sink");
  if (goalNodes.length !== 1) errors.push("A work graph must contain exactly one GOAL node.");
  const executableNodes = graph.nodes.filter((node) => node.kind !== "goal_sink");
  if (executableNodes.length === 0) {
    errors.push("A manual work graph needs at least one executable node.");
  }
  if (graph.edges.length === 0) {
    errors.push("A manual work graph needs at least one execution edge.");
  }

  for (const group of groups) {
    const members = groupMembers(graph, group.id);
    if (members.length === 0) errors.push(`Group ${group.id} needs at least one node.`);
    if (members.length > WORK_GRAPH_LIMITS.maxGroupNodes) {
      errors.push(
        `Group ${group.id} can contain at most ${WORK_GRAPH_LIMITS.maxGroupNodes} nodes.`,
      );
    }
    if (group.generation.mode === "prompt") {
      const memberIds = new Set(members.map((node) => node.id));
      if (
        graph.edges.some(
          (edge) => memberIds.has(edge.from) || memberIds.has(edge.to),
        )
      ) {
        errors.push(
          `Prompt-generated group ${group.id} must connect through its group boundary.`,
        );
      }
    }
  }

  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  const endpointIds = new Set([...nodeIds, ...groupIds]);

  for (const edge of graph.edges) {
    if (
      !edge.id ||
      characterCount(edge.id) > WORK_GRAPH_LIMITS.maxIdLength ||
      !validStableId(edge.id)
    ) {
      errors.push(
        `Edge id "${edge.id}" must start with a letter and contain only letters, numbers, _ or - (${WORK_GRAPH_LIMITS.maxIdLength} characters max).`,
      );
    }
    if (edgeIds.has(edge.id)) errors.push(`Duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!endpointIds.has(edge.from)) {
      errors.push(`Edge ${edge.id} has unknown source: ${edge.from}`);
    }
    if (!endpointIds.has(edge.to)) {
      errors.push(`Edge ${edge.id} has unknown target: ${edge.to}`);
    }
    if (edge.from === edge.to) errors.push(`Edge ${edge.id} cannot connect a node to itself.`);
    if (edge.from === WORK_GRAPH_GOAL_ID) errors.push("GOAL cannot have outgoing edges.");
    const kind = workGraphEdgeKind(edge);
    const condition = workGraphEdgeCondition(edge);
    if (!WORK_GRAPH_EDGE_KINDS.has(kind)) {
      errors.push(`Unsupported edge kind for ${edge.id}: ${String(kind)}`);
    }
    if (!WORK_GRAPH_EDGE_CONDITIONS.has(condition)) {
      errors.push(`Unsupported edge condition for ${edge.id}: ${String(condition)}`);
    }
    if (edge.label && characterCount(edge.label.trim()) > WORK_GRAPH_LIMITS.maxTitleLength) {
      errors.push(`Edge ${edge.id} label is too long.`);
    }
    if (kind === "retry") {
      const retryLimit = edge.retry_limit ?? 3;
      if (
        !Number.isInteger(retryLimit) ||
        retryLimit < 1 ||
        retryLimit > WORK_GRAPH_LIMITS.maxRetryLimit
      ) {
        errors.push(
          `Retry edge ${edge.id} limit must be between 1 and ${WORK_GRAPH_LIMITS.maxRetryLimit}.`,
        );
      }
    }
    const pair = `${kind}\u0000${edge.from}\u0000${edge.to}\u0000${condition}`;
    if (endpointPairs.has(pair)) errors.push(`Duplicate execution edge: ${edge.from} → ${edge.to}`);
    endpointPairs.add(pair);
  }

  const effectiveEdges = expandWorkGraphEdges(graph);
  const dependencyEdges = effectiveEdges.filter(
    (edge) => workGraphEdgeKind(edge) === "dependency",
  );
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of dependencyEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const degree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  if (visited !== graph.nodes.length) errors.push("The work graph must be a DAG (cycles are not allowed).");

  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes) reverse.set(node.id, []);
  for (const edge of dependencyEdges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      reverse.get(edge.to)?.push(edge.from);
    }
  }
  const reachesGoal = new Set<string>();
  const stack = goalNodes.length === 1 ? [goalNodes[0].id] : [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachesGoal.has(id)) continue;
    reachesGoal.add(id);
    stack.push(...(reverse.get(id) ?? []));
  }
  for (const node of executableNodes) {
    if (!reachesGoal.has(node.id)) {
      errors.push(`Node ${node.id || "(unnamed)"} has no path to GOAL.`);
    }
  }

  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  for (const edge of dependencyEdges) {
    const sourceKind = kinds.get(edge.from);
    const condition = workGraphEdgeCondition(edge);
    const compatible =
      condition === "always" ||
      ((condition === "pass" || condition === "fail") &&
        sourceKind === "validator") ||
      ((condition === "approved" || condition === "rejected") &&
        sourceKind === "human");
    if (!compatible) {
      errors.push(
        `Edge ${edge.source_edge_id} condition is incompatible with source node ${edge.from}.`,
      );
    }
  }

  const retrySources = new Map<string, string>();
  for (const edge of effectiveEdges.filter(
    (candidate) => workGraphEdgeKind(candidate) === "retry",
  )) {
    const sourceKind = kinds.get(edge.from);
    if (sourceKind !== "validator" && sourceKind !== "human") {
      errors.push(
        `Retry edge ${edge.source_edge_id} must start at a validator or human node.`,
      );
    }
    const expectedCondition =
      sourceKind === "validator"
        ? "fail"
        : sourceKind === "human"
          ? "rejected"
          : null;
    if (expectedCondition && workGraphEdgeCondition(edge) !== expectedCondition) {
      errors.push(
        `Retry edge ${edge.source_edge_id} from ${edge.from} must use the ${expectedCondition} condition.`,
      );
    }
    const previousRetryEdge = retrySources.get(edge.from);
    if (previousRetryEdge && previousRetryEdge !== edge.source_edge_id) {
      errors.push(`Node ${edge.from} can have only one retry rule.`);
    }
    retrySources.set(edge.from, edge.source_edge_id);
    const targetKind = kinds.get(edge.to);
    if (targetKind !== "agent" && targetKind !== "merge") {
      errors.push(
        `Retry edge ${edge.source_edge_id} must target an agent or merge node.`,
      );
    }
    const visited = new Set<string>();
    const pending = [edge.to];
    let reachesSource = false;
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (id === edge.from) {
        reachesSource = true;
        break;
      }
      pending.push(...(outgoing.get(id) ?? []));
    }
    if (!reachesSource) {
      errors.push(
        `Retry edge ${edge.source_edge_id} target must be an upstream dependency of its source.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

function mermaidText(value: string): string {
  return value
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "<br/>");
}

export function serializeWorkGraphToMermaid(
  graph: WorkGraph,
  direction: WorkGraphGroupDirection = "TD",
): string {
  const validation = validateWorkGraph(graph);
  if (!validation.valid) throw new Error(validation.errors[0]);

  const nodes = [...graph.nodes].sort((a, b) => compareStableId(a.id, b.id));
  const aliases = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = [`flowchart ${direction}`];
  const appendNode = (node: WorkGraphNode, indent = "  ") => {
    const alias = aliases.get(node.id)!;
    if (node.kind === "goal_sink") {
      lines.push(`${indent}${alias}((GOAL))`);
      return;
    }
    const label = [
      mermaidText(node.id),
      `[${node.kind}] ${mermaidText(node.title)}`,
      mermaidText(node.instruction),
    ].join("<br/>");
    lines.push(`${indent}${alias}["${label}"]`);
  };
  for (const node of nodes.filter((candidate) => !candidate.group_id)) {
    appendNode(node);
  }
  for (const [groupIndex, group] of [...workGraphGroups(graph)]
    .sort((a, b) => compareStableId(a.id, b.id))
    .entries()) {
    lines.push(`  subgraph g${groupIndex}["${mermaidText(group.title)}"]`);
    lines.push(`    direction ${group.direction}`);
    for (const node of nodes.filter((candidate) => candidate.group_id === group.id)) {
      appendNode(node, "    ");
    }
    lines.push("  end");
  }
  const edges = expandWorkGraphEdges(graph).sort(
    (a, b) =>
      compareStableId(a.from, b.from) ||
      compareStableId(a.to, b.to) ||
      compareStableId(a.id, b.id),
  );
  const seen = new Set<string>();
  for (const edge of edges) {
    const connector = workGraphEdgeKind(edge) === "retry" ? "-.->" : "-->";
    const condition = workGraphEdgeCondition(edge);
    const label = [edge.label?.trim(), condition === "always" ? null : condition]
      .filter(Boolean)
      .join(" / ");
    const rendered = `  ${aliases.get(edge.from)} ${connector}${label ? `|${mermaidText(label)}|` : ""} ${aliases.get(edge.to)}`;
    if (!seen.has(rendered)) {
      seen.add(rendered);
      lines.push(rendered);
    }
  }
  return lines.join("\n");
}

export function validateGraphPromptPlan(plan: GraphPromptPlan): WorkGraphValidationResult {
  if (plan.version !== GRAPH_PROMPT_PLAN_VERSION) {
    return {
      valid: false,
      errors: [`Unsupported graph prompt plan version: ${String(plan.version)}`],
    };
  }
  if (
    plan.continuation !== undefined &&
    (typeof plan.continuation !== "object" ||
      plan.continuation === null ||
      plan.continuation.version !== GRAPH_PROMPT_CONTINUATION_VERSION)
  ) {
    return {
      valid: false,
      errors: [
        `Unsupported graph prompt continuation version: ${String(
          plan.continuation && typeof plan.continuation === "object"
            ? (plan.continuation as { version?: unknown }).version
            : plan.continuation,
        )}`,
      ],
    };
  }
  if (plan.mode === "automatic") return { valid: true, errors: [] };
  if (plan.mode === "manual") return validateWorkGraph(plan.graph);
  return {
    valid: false,
    errors: [`Unsupported graph prompt mode: ${String((plan as { mode?: unknown }).mode)}`],
  };
}

export function markGraphPromptPlanContinuation(
  plan: GraphPromptPlan,
): GraphPromptPlan {
  return {
    ...plan,
    continuation: { version: GRAPH_PROMPT_CONTINUATION_VERSION },
  };
}

export function isGraphPromptPlanContinuation(plan: GraphPromptPlan): boolean {
  return plan.continuation?.version === GRAPH_PROMPT_CONTINUATION_VERSION;
}
