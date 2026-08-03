export const GRAPH_PROMPT_PLAN_VERSION = 1 as const;
export const GRAPH_PROMPT_CONTINUATION_VERSION = 1 as const;
export const WORK_GRAPH_VERSION = 1 as const;
export const WORK_GRAPH_GOAL_ID = "goal" as const;

export const WORK_GRAPH_LIMITS = {
  maxNodes: 24,
  maxEdges: 96,
  maxIdLength: 64,
  maxTitleLength: 120,
  maxInstructionLength: 1_200,
  maxTotalInstructionLength: 8_000,
} as const;

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
}

export interface WorkGraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface WorkGraph {
  version: typeof WORK_GRAPH_VERSION;
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
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

export const AUTOMATIC_GRAPH_PROMPT_PLAN: GraphPromptPlan = Object.freeze({
  version: GRAPH_PROMPT_PLAN_VERSION,
  mode: "automatic",
});

export function createEmptyWorkGraph(): WorkGraph {
  return {
    version: WORK_GRAPH_VERSION,
    nodes: [
      {
        id: WORK_GRAPH_GOAL_ID,
        kind: "goal_sink",
        title: "GOAL",
        instruction: "",
      },
    ],
    edges: [],
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

export function validateWorkGraph(graph: WorkGraph): WorkGraphValidationResult {
  const errors: string[] = [];
  if (graph.version !== WORK_GRAPH_VERSION) {
    errors.push(`Unsupported work graph version: ${String(graph.version)}`);
  }
  if (graph.nodes.length > WORK_GRAPH_LIMITS.maxNodes) {
    errors.push(`A work graph can contain at most ${WORK_GRAPH_LIMITS.maxNodes} nodes.`);
  }
  if (graph.edges.length > WORK_GRAPH_LIMITS.maxEdges) {
    errors.push(`A work graph can contain at most ${WORK_GRAPH_LIMITS.maxEdges} edges.`);
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
      continue;
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

  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const node of graph.nodes) outgoing.set(node.id, []);

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
    if (!nodeIds.has(edge.from)) errors.push(`Edge ${edge.id} has unknown source: ${edge.from}`);
    if (!nodeIds.has(edge.to)) errors.push(`Edge ${edge.id} has unknown target: ${edge.to}`);
    if (edge.from === edge.to) errors.push(`Edge ${edge.id} cannot connect a node to itself.`);
    if (edge.from === WORK_GRAPH_GOAL_ID) errors.push("GOAL cannot have outgoing edges.");
    const pair = `${edge.from}\u0000${edge.to}`;
    if (endpointPairs.has(pair)) errors.push(`Duplicate execution edge: ${edge.from} → ${edge.to}`);
    endpointPairs.add(pair);

    if (nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to) {
      outgoing.get(edge.from)?.push(edge.to);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
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
  for (const edge of graph.edges) {
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

export function serializeWorkGraphToMermaid(graph: WorkGraph): string {
  const validation = validateWorkGraph(graph);
  if (!validation.valid) throw new Error(validation.errors[0]);

  const nodes = [...graph.nodes].sort((a, b) => compareStableId(a.id, b.id));
  const aliases = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["flowchart TD"];
  for (const node of nodes) {
    const alias = aliases.get(node.id)!;
    if (node.kind === "goal_sink") {
      lines.push(`  ${alias}((GOAL))`);
      continue;
    }
    const label = [
      mermaidText(node.id),
      `[${node.kind}] ${mermaidText(node.title)}`,
      mermaidText(node.instruction),
    ].join("<br/>");
    lines.push(`  ${alias}["${label}"]`);
  }
  const edges = [...graph.edges].sort(
    (a, b) =>
      compareStableId(a.from, b.from) ||
      compareStableId(a.to, b.to) ||
      compareStableId(a.id, b.id),
  );
  for (const edge of edges) {
    lines.push(`  ${aliases.get(edge.from)} --> ${aliases.get(edge.to)}`);
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
