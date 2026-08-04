import type {
  SessionAgentProvider,
  SessionGraph,
  SessionGraphCanvas,
} from "./types";
import {
  WORK_GRAPH_GOAL_ID,
  createEmptyWorkGraph,
  expandWorkGraphEdges,
  workGraphEdgeKind,
  type WorkGraph,
  type WorkGraphEdge,
  type WorkGraphGroup,
  type WorkGraphGroupDirection,
  type WorkGraphNodeKind,
} from "./workGraph";

export const SESSION_GRAPH_VERSION = 1 as const;
export const SESSION_GRAPH_CANVAS_VERSION = 2 as const;
export const GRAPH_CANVAS_GRID_SIZE = 16;
export const DEFAULT_GRAPH_CANVAS_DIRECTION = "LR" as const;

const GRAPH_CANVAS_ORIGIN = 80;
const GRAPH_CANVAS_HORIZONTAL_PITCH = 256;
const GRAPH_CANVAS_VERTICAL_PITCH = 176;

export function graphCanvasDirection(
  canvas: SessionGraphCanvas,
): WorkGraphGroupDirection {
  return canvas.direction === "TD" ? "TD" : DEFAULT_GRAPH_CANVAS_DIRECTION;
}

export function snapGraphCanvasCoordinate(value: number): number {
  return Math.round(value / GRAPH_CANVAS_GRID_SIZE) * GRAPH_CANVAS_GRID_SIZE;
}

export function snapGraphCanvasPosition(
  position: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: snapGraphCanvasCoordinate(position.x),
    y: snapGraphCanvasCoordinate(position.y),
  };
}

function defaultExecutablePosition(
  index: number,
  direction: WorkGraphGroupDirection,
): { x: number; y: number } {
  const primary = index % 3;
  const cross = Math.floor(index / 3);
  return direction === "TD"
    ? {
        x: GRAPH_CANVAS_ORIGIN + cross * GRAPH_CANVAS_HORIZONTAL_PITCH,
        y: GRAPH_CANVAS_ORIGIN + primary * GRAPH_CANVAS_VERTICAL_PITCH,
      }
    : {
        x: GRAPH_CANVAS_ORIGIN + primary * GRAPH_CANVAS_HORIZONTAL_PITCH,
        y: GRAPH_CANVAS_ORIGIN + cross * GRAPH_CANVAS_VERTICAL_PITCH,
      };
}

export function setGraphCanvasDirection(
  canvas: SessionGraphCanvas,
  graph: WorkGraph,
  direction: WorkGraphGroupDirection,
): SessionGraphCanvas {
  const currentDirection = graphCanvasDirection(canvas);
  const lockedNodeIds = new Set(canvas.locked_node_ids ?? []);
  const topLevelNodeIds = new Set(
    graph.nodes.filter((node) => !node.group_id).map((node) => node.id),
  );
  const orientPosition = (position: { x: number; y: number }) => {
    const snapped = snapGraphCanvasPosition(position);
    return currentDirection === direction
      ? snapped
      : { x: snapped.y, y: snapped.x };
  };

  return {
    ...canvas,
    direction,
    node_positions: Object.fromEntries(
      Object.entries(canvas.node_positions).map(([id, position]) => [
        id,
        topLevelNodeIds.has(id) && !lockedNodeIds.has(id)
          ? orientPosition(position)
          : snapGraphCanvasPosition(position),
      ]),
    ),
    group_positions: Object.fromEntries(
      Object.entries(canvas.group_positions ?? {}).map(([id, position]) => [
        id,
        orientPosition(position),
      ]),
    ),
  };
}

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
      direction: DEFAULT_GRAPH_CANVAS_DIRECTION,
      node_positions: { [WORK_GRAPH_GOAL_ID]: { x: 560, y: 80 } },
      locked_node_ids: [],
      group_positions: {},
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
      groups: graph.definition.groups?.map((group) => ({
        ...group,
        generation: { ...group.generation },
      })),
    },
    canvas: {
      ...graph.canvas,
      node_positions: Object.fromEntries(
        Object.entries(graph.canvas.node_positions).map(([id, position]) => [
          id,
          { ...position },
        ]),
      ),
      locked_node_ids: [...(graph.canvas.locked_node_ids ?? [])],
      group_positions: Object.fromEntries(
        Object.entries(graph.canvas.group_positions ?? {}).map(
          ([id, position]) => [id, { ...position }],
        ),
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
  const direction = graphCanvasDirection(canvas);
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
          execution_mode: null,
        },
        graph.nodes.find((node) => node.kind === "goal_sink")!,
      ],
    },
    canvas: {
      ...canvas,
      node_positions: {
        ...canvas.node_positions,
        [nodeId]: defaultExecutablePosition(executableCount, direction),
      },
    },
    nodeId,
  };
}

export interface AddGraphGroupOptions {
  title?: string;
  count?: number;
  generationMode?: "fixed" | "prompt";
  prompt?: string;
}

export function addGraphGroup(
  graph: WorkGraph,
  canvas: SessionGraphCanvas,
  options: AddGraphGroupOptions = {},
): {
  graph: WorkGraph;
  canvas: SessionGraphCanvas;
  groupId: string;
  nodeIds: string[];
} {
  const taken = new Set([
    ...graph.nodes.map((node) => node.id),
    ...(graph.groups ?? []).map((group) => group.id),
  ]);
  const groupId = nextStableId("group", taken);
  const count = Math.max(1, Math.min(12, Math.floor(options.count ?? 3)));
  const promptGenerated = options.generationMode === "prompt";
  const slotCount = promptGenerated ? 1 : count;
  const prompt = options.prompt?.trim() ?? "";
  const nodeIds: string[] = [];
  const nodes = [...graph.nodes.filter((node) => node.kind !== "goal_sink")];
  for (let index = 0; index < slotCount; index += 1) {
    const nodeId = nextStableId("agent", new Set([...taken, ...nodeIds]));
    nodeIds.push(nodeId);
    nodes.push({
      id: nodeId,
      kind: "agent",
      title: `Session ${index + 1}`,
      instruction:
        prompt ||
        (promptGenerated
          ? "Generate this task from the dynamic group prompt."
          : ""),
      group_id: groupId,
      execution_mode: null,
    });
  }
  const group: WorkGraphGroup = {
    id: groupId,
    title: options.title?.trim() || "Dynamic group",
    direction: "LR",
    execution_mode: "parallel",
    generation: {
      mode: options.generationMode ?? "fixed",
      count: promptGenerated ? null : count,
      prompt: prompt || null,
      max_nodes: 12,
    },
  };
  const node_positions = { ...canvas.node_positions };
  for (const [index, nodeId] of nodeIds.entries()) {
    node_positions[nodeId] = { x: 48 + index * 256, y: 80 };
  }
  const groupCount = graph.groups?.length ?? 0;
  return {
    graph: {
      ...graph,
      version: 2,
      execution_mode: "sequential",
      nodes: [
        ...nodes,
        graph.nodes.find((node) => node.kind === "goal_sink")!,
      ],
      groups: [...(graph.groups ?? []), group],
    },
    canvas: {
      ...canvas,
      version: 2,
      node_positions,
      group_positions: {
        ...(canvas.group_positions ?? {}),
        [groupId]: { x: 80, y: 80 + groupCount * 288 },
      },
    },
    groupId,
    nodeIds,
  };
}

export interface GraphGroupTask {
  title: string;
  instruction: string;
}

export function materializeGraphGroup(
  graph: WorkGraph,
  canvas: SessionGraphCanvas,
  groupId: string,
  tasks: readonly GraphGroupTask[],
): { graph: WorkGraph; canvas: SessionGraphCanvas; nodeIds: string[] } | null {
  const group = graph.groups?.find((candidate) => candidate.id === groupId);
  if (!group || tasks.length === 0 || tasks.length > 12) return null;
  const removed = new Set(
    graph.nodes
      .filter((node) => node.group_id === groupId)
      .map((node) => node.id),
  );
  const retainedNodes = graph.nodes.filter(
    (node) => !removed.has(node.id) && node.kind !== "goal_sink",
  );
  const taken = new Set([
    ...retainedNodes.map((node) => node.id),
    ...(graph.groups ?? []).map((candidate) => candidate.id),
  ]);
  const nodeIds: string[] = [];
  const nextNodes = tasks.map((task, index) => {
    const id = nextStableId("agent", new Set([...taken, ...nodeIds]));
    nodeIds.push(id);
    return {
      id,
      kind: "agent" as const,
      title: task.title.trim() || `Session ${index + 1}`,
      instruction: task.instruction.trim(),
      group_id: groupId,
      execution_mode: null,
    };
  });
  const node_positions = { ...canvas.node_positions };
  for (const id of removed) delete node_positions[id];
  const locked_node_ids = (canvas.locked_node_ids ?? []).filter(
    (id) => !removed.has(id),
  );
  for (const [index, id] of nodeIds.entries()) {
    node_positions[id] = { x: 48 + index * 256, y: 80 };
  }
  return {
    graph: {
      ...graph,
      version: 2,
      nodes: [
        ...retainedNodes,
        ...nextNodes,
        graph.nodes.find((node) => node.kind === "goal_sink")!,
      ],
      edges: graph.edges.filter(
        (edge) => !removed.has(edge.from) && !removed.has(edge.to),
      ),
      groups: graph.groups?.map((candidate) =>
        candidate.id === groupId
          ? {
              ...candidate,
              generation: { ...candidate.generation, count: tasks.length },
            }
          : candidate,
      ),
    },
    canvas: { ...canvas, version: 2, node_positions, locked_node_ids },
    nodeIds,
  };
}

export function removeGraphGroup(
  graph: WorkGraph,
  canvas: SessionGraphCanvas,
  groupId: string,
): { graph: WorkGraph; canvas: SessionGraphCanvas } {
  const removed = new Set(
    graph.nodes
      .filter((node) => node.group_id === groupId)
      .map((node) => node.id),
  );
  const node_positions = { ...canvas.node_positions };
  for (const id of removed) delete node_positions[id];
  const locked_node_ids = (canvas.locked_node_ids ?? []).filter(
    (id) => !removed.has(id),
  );
  const group_positions = { ...(canvas.group_positions ?? {}) };
  delete group_positions[groupId];
  return {
    graph: {
      ...graph,
      nodes: graph.nodes.filter((node) => !removed.has(node.id)),
      edges: graph.edges.filter(
        (edge) =>
          edge.from !== groupId &&
          edge.to !== groupId &&
          !removed.has(edge.from) &&
          !removed.has(edge.to),
      ),
      groups: graph.groups?.filter((group) => group.id !== groupId),
    },
    canvas: { ...canvas, node_positions, locked_node_ids, group_positions },
  };
}

export function updateGraphGroup(
  graph: WorkGraph,
  groupId: string,
  patch: Partial<Omit<WorkGraphGroup, "id" | "generation">> & {
    generation?: Partial<WorkGraphGroup["generation"]>;
  },
): WorkGraph {
  const groups = graph.groups?.map((group) =>
    group.id === groupId
      ? {
          ...group,
          ...patch,
          generation: {
            ...group.generation,
            ...(patch.generation ?? {}),
          },
        }
      : group,
  );
  const updatedGroup = groups?.find((group) => group.id === groupId);
  const generationPrompt = updatedGroup?.generation.mode === "prompt"
    ? updatedGroup.generation.prompt?.trim()
    : null;
  return {
    ...graph,
    execution_mode: "sequential",
    nodes: graph.nodes.map((node) =>
      node.group_id === groupId
        ? {
            ...node,
            execution_mode: null,
            instruction: generationPrompt || node.instruction,
          }
        : node,
    ),
    groups,
  };
}

export function resizeFixedGraphGroup(
  graph: WorkGraph,
  canvas: SessionGraphCanvas,
  groupId: string,
  count: number,
): { graph: WorkGraph; canvas: SessionGraphCanvas; nodeIds: string[] } | null {
  const group = graph.groups?.find((candidate) => candidate.id === groupId);
  if (!group || !Number.isInteger(count) || count < 1 || count > 12) return null;
  const current = graph.nodes.filter((node) => node.group_id === groupId);
  const fallbackInstruction =
    group.generation.prompt?.trim() ||
    current.find((node) => node.instruction.trim())?.instruction ||
    "Complete this branch of the group and return a concise artifact.";
  const tasks = Array.from({ length: count }, (_, index) => ({
    title: current[index]?.title || `Session ${index + 1}`,
    instruction: current[index]?.instruction || fallbackInstruction,
  }));
  const materialized = materializeGraphGroup(graph, canvas, groupId, tasks);
  if (!materialized) return null;
  return {
    ...materialized,
    graph: updateGraphGroup(materialized.graph, groupId, {
      generation: { mode: "fixed", count },
    }),
  };
}

export function alignGraphNodePositions(
  canvas: SessionGraphCanvas,
  nodeIds: readonly string[],
  axis: "x" | "y",
  anchorId: string,
): SessionGraphCanvas {
  const anchor = canvas.node_positions[anchorId];
  if (!anchor || nodeIds.length < 2) return canvas;
  const lockedNodeIds = new Set(canvas.locked_node_ids ?? []);
  const node_positions = { ...canvas.node_positions };
  for (const nodeId of nodeIds) {
    if (lockedNodeIds.has(nodeId)) continue;
    const position = node_positions[nodeId];
    if (!position) continue;
    node_positions[nodeId] = snapGraphCanvasPosition({
      ...position,
      [axis]: anchor[axis],
    });
  }
  return { ...canvas, node_positions };
}

export function setGraphNodePositionLocks(
  canvas: SessionGraphCanvas,
  nodeIds: readonly string[],
  locked: boolean,
): SessionGraphCanvas {
  const nextLockedNodeIds = new Set(canvas.locked_node_ids ?? []);
  for (const nodeId of nodeIds) {
    if (locked) nextLockedNodeIds.add(nodeId);
    else nextLockedNodeIds.delete(nodeId);
  }
  return {
    ...canvas,
    locked_node_ids: [...nextLockedNodeIds].sort(),
  };
}

function dependencyGraphHasCycle(graph: WorkGraph): boolean {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of expandWorkGraphEdges(graph)) {
    if (workGraphEdgeKind(edge) === "dependency") {
      outgoing.get(edge.from)?.push(edge.to);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const node of graph.nodes) {
    if (visit(node.id)) return true;
  }
  return false;
}

export type GraphConnectionError =
  | "missingEndpoint"
  | "unknownNode"
  | "selfConnection"
  | "goalOutgoing"
  | "dynamicGroupBoundary"
  | "duplicate"
  | "cycle";

export function validateProspectiveGraphEdge(
  graph: WorkGraph,
  source: string | null | undefined,
  target: string | null | undefined,
): GraphConnectionError | null {
  if (!source || !target) return "missingEndpoint";
  const endpointIds = new Set([
    ...graph.nodes.map((node) => node.id),
    ...(graph.groups ?? []).map((group) => group.id),
  ]);
  if (!endpointIds.has(source) || !endpointIds.has(target)) {
    return "unknownNode";
  }
  if (source === target) return "selfConnection";
  if (source === WORK_GRAPH_GOAL_ID) return "goalOutgoing";
  const promptMemberIds = new Set(
    graph.nodes
      .filter((node) =>
        graph.groups?.some(
          (group) =>
            group.id === node.group_id && group.generation.mode === "prompt",
        ),
      )
      .map((node) => node.id),
  );
  if (promptMemberIds.has(source) || promptMemberIds.has(target)) {
    return "dynamicGroupBoundary";
  }
  if (graph.edges.some((edge) => edge.from === source && edge.to === target)) {
    return "duplicate";
  }
  const probe: WorkGraph = {
    ...graph,
    edges: [
      ...graph.edges,
      { id: "probe-edge", from: source, to: target, kind: "dependency" },
    ],
  };
  if (dependencyGraphHasCycle(probe)) return "cycle";
  return null;
}

export function connectGraphNodes(
  graph: WorkGraph,
  source: string | null | undefined,
  target: string | null | undefined,
  options: Partial<
    Pick<WorkGraphEdge, "label" | "condition" | "kind" | "retry_limit">
  > = {},
): WorkGraph | null {
  if (
    options.kind !== "retry" &&
    validateProspectiveGraphEdge(graph, source, target)
  ) {
    return null;
  }
  if (options.kind === "retry") {
    const sourceNode = graph.nodes.find((node) => node.id === source);
    const targetNode = graph.nodes.find((node) => node.id === target);
    const expectedCondition =
      sourceNode?.kind === "human"
        ? "rejected"
        : sourceNode?.kind === "validator"
          ? "fail"
          : null;
    if (
      !source ||
      !target ||
      !sourceNode ||
      !targetNode ||
      !expectedCondition ||
      (options.condition !== undefined &&
        options.condition !== expectedCondition) ||
      graph.groups?.some(
        (group) =>
          group.generation.mode === "prompt" &&
          (group.id === sourceNode.group_id || group.id === targetNode.group_id),
      ) ||
      source === target ||
      source === WORK_GRAPH_GOAL_ID ||
      (sourceNode.kind !== "validator" && sourceNode.kind !== "human") ||
      (targetNode.kind !== "agent" && targetNode.kind !== "merge") ||
      graph.edges.some(
        (edge) =>
          workGraphEdgeKind(edge) === "retry" &&
          edge.from === source,
      )
    ) {
      return null;
    }
    const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
    for (const edge of expandWorkGraphEdges(graph)) {
      if (workGraphEdgeKind(edge) === "dependency") {
        outgoing.get(edge.from)?.push(edge.to);
      }
    }
    const visited = new Set<string>();
    const pending = [target];
    let reachesSource = false;
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      if (nodeId === source) {
        reachesSource = true;
        break;
      }
      pending.push(...(outgoing.get(nodeId) ?? []));
    }
    if (!reachesSource) return null;
  }
  const taken = new Set(graph.edges.map((edge) => edge.id));
  return {
    ...graph,
    edges: [
      ...graph.edges,
      {
        id: nextStableId("edge", taken),
        from: source!,
        to: target!,
        ...options,
        condition:
          options.kind === "retry"
            ? graph.nodes.find((node) => node.id === source)?.kind === "human"
              ? "rejected"
              : "fail"
            : options.condition,
      },
    ],
  };
}
