import type {
  SessionAgentProvider,
  SessionGraph,
  SessionGraphCanvas,
} from "./types";
import {
  WORK_GRAPH_GOAL_ID,
  createEmptyWorkGraph,
  type WorkGraph,
  type WorkGraphNodeKind,
} from "./workGraph";

export const SESSION_GRAPH_VERSION = 1 as const;
export const SESSION_GRAPH_CANVAS_VERSION = 1 as const;

export function createGraphSessionDraft(
  provider: SessionAgentProvider = "claude",
): SessionGraph {
  return {
    version: SESSION_GRAPH_VERSION,
    objective: "",
    agent: { provider },
    definition: createEmptyWorkGraph(),
    canvas: {
      version: SESSION_GRAPH_CANVAS_VERSION,
      node_positions: { [WORK_GRAPH_GOAL_ID]: { x: 560, y: 220 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    revision: 1,
  };
}

export function cloneSessionGraph(graph: SessionGraph): SessionGraph {
  return {
    ...graph,
    agent: { ...graph.agent },
    definition: {
      ...graph.definition,
      nodes: graph.definition.nodes.map((node) => ({ ...node })),
      edges: graph.definition.edges.map((edge) => ({ ...edge })),
    },
    canvas: {
      ...graph.canvas,
      node_positions: Object.fromEntries(
        Object.entries(graph.canvas.node_positions).map(([id, position]) => [
          id,
          { ...position },
        ]),
      ),
      viewport: graph.canvas.viewport ? { ...graph.canvas.viewport } : null,
    },
  };
}

function nextStableId(prefix: string, taken: ReadonlySet<string>): string {
  let index = 1;
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function addGraphNode(
  graph: WorkGraph,
  canvas: SessionGraphCanvas,
  kind: Exclude<WorkGraphNodeKind, "goal_sink">,
): { graph: WorkGraph; canvas: SessionGraphCanvas; nodeId: string } {
  const nodeId = nextStableId(kind, new Set(graph.nodes.map((node) => node.id)));
  const executableCount = graph.nodes.filter(
    (node) => node.kind !== "goal_sink",
  ).length;
  return {
    graph: {
      ...graph,
      nodes: [
        ...graph.nodes.filter((node) => node.kind !== "goal_sink"),
        {
          id: nodeId,
          kind,
          title: kind[0].toUpperCase() + kind.slice(1),
          instruction: "",
        },
        graph.nodes.find((node) => node.kind === "goal_sink")!,
      ],
    },
    canvas: {
      ...canvas,
      node_positions: {
        ...canvas.node_positions,
        [nodeId]: {
          x: 80 + (executableCount % 3) * 230,
          y: 80 + Math.floor(executableCount / 3) * 160,
        },
      },
    },
    nodeId,
  };
}

function pathExists(graph: WorkGraph, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge.to);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

export type GraphConnectionError =
  | "missingEndpoint"
  | "unknownNode"
  | "selfConnection"
  | "goalOutgoing"
  | "duplicate"
  | "cycle";

export function validateProspectiveGraphEdge(
  graph: WorkGraph,
  source: string | null | undefined,
  target: string | null | undefined,
): GraphConnectionError | null {
  if (!source || !target) return "missingEndpoint";
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (!nodeIds.has(source) || !nodeIds.has(target)) {
    return "unknownNode";
  }
  if (source === target) return "selfConnection";
  if (source === WORK_GRAPH_GOAL_ID) return "goalOutgoing";
  if (graph.edges.some((edge) => edge.from === source && edge.to === target)) {
    return "duplicate";
  }
  if (pathExists(graph, target, source)) return "cycle";
  return null;
}

export function connectGraphNodes(
  graph: WorkGraph,
  source: string | null | undefined,
  target: string | null | undefined,
): WorkGraph | null {
  if (validateProspectiveGraphEdge(graph, source, target)) return null;
  const taken = new Set(graph.edges.map((edge) => edge.id));
  return {
    ...graph,
    edges: [
      ...graph.edges,
      {
        id: nextStableId("edge", taken),
        from: source!,
        to: target!,
      },
    ],
  };
}
