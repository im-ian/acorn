import type {
  SessionGraph,
  SessionGraphCanvas,
  SessionGraphNodePosition,
  SessionGraphViewport,
} from "./types";
import {
  DEFAULT_GRAPH_CANVAS_DIRECTION,
  graphCanvasDirection,
  snapGraphCanvasPosition,
} from "./graphSession";
import {
  WORK_GRAPH_GOAL_ID,
  WORK_GRAPH_LIMITS,
  WORK_GRAPH_VERSION,
  validateWorkGraph,
  type WorkGraph,
  type WorkGraphEdge,
  type WorkGraphEdgeCondition,
  type WorkGraphEdgeKind,
  type WorkGraphExecutionMode,
  type WorkGraphGroup,
  type WorkGraphGroupDirection,
  type WorkGraphGroupGenerationMode,
  type WorkGraphNode,
  type WorkGraphNodeKind,
} from "./workGraph";

export const GRAPH_PRESET_STORAGE_KEY = "acorn:graph-presets:v2";
export const LEGACY_GRAPH_PRESET_STORAGE_KEY = "acorn:graph-presets:v1";
export const GRAPH_PRESET_SCHEMA_VERSION = 2 as const;
export const GRAPH_PRESET_SNAPSHOT_VERSION = 1 as const;

export const IMPLEMENT_VERIFY_GRAPH_PRESET_ID =
  "builtin:graph:implement-verify:v1";
export const RESEARCH_BUILD_VERIFY_GRAPH_PRESET_ID =
  "builtin:graph:research-build-verify:v1";
export const APPROVAL_GATE_GRAPH_PRESET_ID =
  "builtin:graph:approval-gate:v1";
export const DEFAULT_GRAPH_PRESET_ID = IMPLEMENT_VERIFY_GRAPH_PRESET_ID;

const MAX_PRESET_ID_LENGTH = 128;
const MAX_PRESET_NAME_LENGTH = 80;
const MAX_CUSTOM_PRESETS = 50;

const EXECUTABLE_NODE_KINDS = new Set<
  Exclude<WorkGraphNodeKind, "goal_sink">
>(["agent", "validator", "merge", "human"]);
const WORK_GRAPH_NODE_KINDS = new Set<WorkGraphNodeKind>([
  ...EXECUTABLE_NODE_KINDS,
  "goal_sink",
]);
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

export type GraphPresetGroupId = "built_in" | "custom";

export interface GraphPresetSnapshot {
  version: typeof GRAPH_PRESET_SNAPSHOT_VERSION;
  definition: WorkGraph;
  canvas: SessionGraphCanvas;
}

export interface BuiltinGraphPreset {
  id: string;
  name: string;
  builtIn: true;
  groupId: "built_in";
  snapshot: GraphPresetSnapshot;
}

export interface CustomGraphPreset {
  id: string;
  name: string;
  builtIn: false;
  groupId: "custom";
  snapshot: GraphPresetSnapshot;
}

export type GraphPreset = BuiltinGraphPreset | CustomGraphPreset;

export interface GraphPresetPreferences {
  schemaVersion: typeof GRAPH_PRESET_SCHEMA_VERSION;
  customPresets: CustomGraphPreset[];
  lastPresetId: string | null;
}

export interface GraphNodePromptPreset {
  id: string;
  name: string;
  groupId: "built_in";
  kind: Exclude<WorkGraphNodeKind, "goal_sink">;
  title: string;
  instruction: string;
}

type GraphPresetSource = Pick<SessionGraph, "definition" | "canvas">;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function position(x: number, y: number): SessionGraphNodePosition {
  return snapGraphCanvasPosition({ x, y });
}

function graphSnapshot(
  nodes: WorkGraphNode[],
  edges: WorkGraphEdge[],
  nodePositions: Record<string, SessionGraphNodePosition>,
  groups: WorkGraphGroup[] = [],
  groupPositions: Record<string, SessionGraphNodePosition> = {},
): GraphPresetSnapshot {
  const snapshot: GraphPresetSnapshot = {
    version: GRAPH_PRESET_SNAPSHOT_VERSION,
    definition: {
      version: WORK_GRAPH_VERSION,
      execution_mode: "sequential",
      nodes,
      edges,
      groups,
    },
    canvas: {
      version: 2,
      direction: DEFAULT_GRAPH_CANVAS_DIRECTION,
      node_positions: nodePositions,
      locked_node_ids: [],
      group_positions: groupPositions,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };
  const validation = validateWorkGraph(snapshot.definition);
  if (!validation.valid) {
    throw new Error(`Invalid built-in graph preset: ${validation.errors[0]}`);
  }
  return snapshot;
}

const GOAL_NODE: WorkGraphNode = {
  id: WORK_GRAPH_GOAL_ID,
  kind: "goal_sink",
  title: "GOAL",
  instruction: "",
};

const RESEARCH_NODE_PROMPT_PRESET: GraphNodePromptPreset = {
  id: "builtin:node:agent-research:v1",
  name: "Research",
  groupId: "built_in",
  kind: "agent",
  title: "Research",
  instruction:
    "Investigate the objective and gather the facts, constraints, and source-backed evidence needed by downstream nodes. Report findings, uncertainties, and recommended next actions.",
};
const IMPLEMENT_NODE_PROMPT_PRESET: GraphNodePromptPreset = {
  id: "builtin:node:agent-implement:v1",
  name: "Implement",
  groupId: "built_in",
  kind: "agent",
  title: "Implement",
  instruction:
    "Implement the requested change using the available context and upstream findings. Preserve existing behavior outside the objective and report changed files and verification results.",
};
const VERIFY_NODE_PROMPT_PRESET: GraphNodePromptPreset = {
  id: "builtin:node:validator-verify:v1",
  name: "Verify",
  groupId: "built_in",
  kind: "validator",
  title: "Verify",
  instruction:
    "Validate the upstream result against the objective and applicable tests. Return PASS or FAIL with concrete evidence and list exact defects or missing work when validation fails.",
};
const SYNTHESIZE_NODE_PROMPT_PRESET: GraphNodePromptPreset = {
  id: "builtin:node:merge-synthesize:v1",
  name: "Synthesize",
  groupId: "built_in",
  kind: "merge",
  title: "Synthesize",
  instruction:
    "Combine all incoming results into one coherent outcome. Resolve conflicts explicitly, retain important evidence, and identify any unresolved issue before forwarding the result.",
};
const HUMAN_APPROVAL_NODE_PROMPT_PRESET: GraphNodePromptPreset = {
  id: "builtin:node:human-approval:v1",
  name: "Human approval",
  groupId: "built_in",
  kind: "human",
  title: "Human approval",
  instruction:
    "Summarize the decision, evidence, risks, and available choices for the user. Pause for explicit approval before allowing the graph to continue.",
};

export const BUILTIN_GRAPH_NODE_PROMPT_PRESETS: readonly GraphNodePromptPreset[] =
  deepFreeze([
    RESEARCH_NODE_PROMPT_PRESET,
    IMPLEMENT_NODE_PROMPT_PRESET,
    VERIFY_NODE_PROMPT_PRESET,
    SYNTHESIZE_NODE_PROMPT_PRESET,
    HUMAN_APPROVAL_NODE_PROMPT_PRESET,
  ]);

export const BUILTIN_GRAPH_PRESETS: readonly BuiltinGraphPreset[] = deepFreeze([
  {
    id: IMPLEMENT_VERIFY_GRAPH_PRESET_ID,
    name: "Implement and verify",
    builtIn: true,
    groupId: "built_in",
    snapshot: graphSnapshot(
      [
        {
          id: "implement",
          kind: "agent",
          title: "Implement",
          instruction: IMPLEMENT_NODE_PROMPT_PRESET.instruction,
        },
        {
          id: "verify",
          kind: "validator",
          title: "Verify",
          instruction: VERIFY_NODE_PROMPT_PRESET.instruction,
        },
        { ...GOAL_NODE },
      ],
      [
        { id: "implement-verify", from: "implement", to: "verify" },
        {
          id: "verify-goal",
          from: "verify",
          to: WORK_GRAPH_GOAL_ID,
          condition: "pass",
        },
        {
          id: "verify-retry-implement",
          from: "verify",
          to: "implement",
          condition: "fail",
          kind: "retry",
          retry_limit: 2,
        },
      ],
      {
        implement: position(80, 220),
        verify: position(340, 220),
        [WORK_GRAPH_GOAL_ID]: position(600, 220),
      },
    ),
  },
  {
    id: RESEARCH_BUILD_VERIFY_GRAPH_PRESET_ID,
    name: "Parallel research, build, and verify",
    builtIn: true,
    groupId: "built_in",
    snapshot: graphSnapshot(
      [
        {
          id: "execute",
          kind: "agent",
          title: "Execute",
          instruction:
            "Turn the objective into a concise research brief, including the questions each parallel research session should answer.",
        },
        {
          id: "research-a",
          kind: "agent",
          title: "Research A",
          instruction: RESEARCH_NODE_PROMPT_PRESET.instruction,
          group_id: "research-group",
          execution_mode: null,
        },
        {
          id: "research-b",
          kind: "agent",
          title: "Research B",
          instruction: RESEARCH_NODE_PROMPT_PRESET.instruction,
          group_id: "research-group",
          execution_mode: null,
        },
        {
          id: "research-c",
          kind: "agent",
          title: "Research C",
          instruction: RESEARCH_NODE_PROMPT_PRESET.instruction,
          group_id: "research-group",
          execution_mode: null,
        },
        {
          id: "merge-research",
          kind: "merge",
          title: "Merge research",
          instruction: SYNTHESIZE_NODE_PROMPT_PRESET.instruction,
        },
        {
          id: "implement",
          kind: "agent",
          title: "Implement",
          instruction: IMPLEMENT_NODE_PROMPT_PRESET.instruction,
        },
        {
          id: "verify",
          kind: "validator",
          title: "Verify",
          instruction: VERIFY_NODE_PROMPT_PRESET.instruction,
        },
        { ...GOAL_NODE },
      ],
      [
        { id: "execute-research", from: "execute", to: "research-group" },
        {
          id: "research-merge",
          from: "research-group",
          to: "merge-research",
        },
        { id: "merge-implement", from: "merge-research", to: "implement" },
        { id: "implement-verify", from: "implement", to: "verify" },
        {
          id: "verify-goal",
          from: "verify",
          to: WORK_GRAPH_GOAL_ID,
          condition: "pass",
        },
        {
          id: "verify-retry-implement",
          from: "verify",
          to: "implement",
          condition: "fail",
          kind: "retry",
          retry_limit: 2,
        },
      ],
      {
        execute: position(40, 260),
        "research-a": position(48, 72),
        "research-b": position(296, 72),
        "research-c": position(544, 72),
        "merge-research": position(1150, 260),
        implement: position(1400, 260),
        verify: position(1650, 260),
        [WORK_GRAPH_GOAL_ID]: position(1900, 260),
      },
      [
        {
          id: "research-group",
          title: "Research",
          direction: "LR",
          execution_mode: "parallel",
          generation: {
            mode: "fixed",
            count: 3,
            prompt: RESEARCH_NODE_PROMPT_PRESET.instruction,
            max_nodes: 12,
          },
        },
      ],
      { "research-group": position(285, 170) },
    ),
  },
  {
    id: APPROVAL_GATE_GRAPH_PRESET_ID,
    name: "Approval gate",
    builtIn: true,
    groupId: "built_in",
    snapshot: graphSnapshot(
      [
        {
          id: "implement",
          kind: "agent",
          title: "Implement",
          instruction: IMPLEMENT_NODE_PROMPT_PRESET.instruction,
        },
        {
          id: "verify",
          kind: "validator",
          title: "Verify",
          instruction: VERIFY_NODE_PROMPT_PRESET.instruction,
        },
        {
          id: "approve",
          kind: "human",
          title: "Human approval",
          instruction: HUMAN_APPROVAL_NODE_PROMPT_PRESET.instruction,
        },
        { ...GOAL_NODE },
      ],
      [
        { id: "implement-verify", from: "implement", to: "verify" },
        {
          id: "verify-approve",
          from: "verify",
          to: "approve",
          label: "Pass",
          condition: "pass",
        },
        {
          id: "verify-retry-implement",
          from: "verify",
          to: "implement",
          label: "Retry",
          condition: "fail",
          kind: "retry",
          retry_limit: 2,
        },
        {
          id: "approve-goal",
          from: "approve",
          to: WORK_GRAPH_GOAL_ID,
          label: "Approved",
          condition: "approved",
        },
        {
          id: "reject-retry-implement",
          from: "approve",
          to: "implement",
          label: "Revise",
          condition: "rejected",
          kind: "retry",
          retry_limit: 2,
        },
      ],
      {
        implement: position(40, 220),
        verify: position(280, 220),
        approve: position(520, 220),
        [WORK_GRAPH_GOAL_ID]: position(760, 220),
      },
    ),
  },
]);

const BUILTIN_GRAPH_PRESET_IDS = new Set(
  BUILTIN_GRAPH_PRESETS.map((preset) => preset.id),
);

function emptyPreferences(): GraphPresetPreferences {
  return {
    schemaVersion: GRAPH_PRESET_SCHEMA_VERSION,
    customPresets: [],
    lastPresetId: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validPresetId(id: string): boolean {
  return (
    characterCount(id) <= MAX_PRESET_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(id)
  );
}

function validPresetName(name: string): boolean {
  return characterCount(name) <= MAX_PRESET_NAME_LENGTH;
}

function sanitizeWorkGraph(value: unknown): WorkGraph | null {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== WORK_GRAPH_VERSION) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length > WORK_GRAPH_LIMITS.maxNodes ||
    value.edges.length > WORK_GRAPH_LIMITS.maxEdges
  ) {
    return null;
  }

  const nodes: WorkGraphNode[] = [];
  for (const candidate of value.nodes) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.kind !== "string" ||
      !WORK_GRAPH_NODE_KINDS.has(candidate.kind as WorkGraphNodeKind) ||
      typeof candidate.title !== "string" ||
      typeof candidate.instruction !== "string"
    ) {
      return null;
    }
    nodes.push({
      id: candidate.id,
      kind: candidate.kind as WorkGraphNodeKind,
      title: candidate.title,
      instruction: candidate.instruction,
      group_id:
        candidate.group_id === undefined || candidate.group_id === null
          ? null
          : typeof candidate.group_id === "string"
            ? candidate.group_id
            : undefined,
      execution_mode:
        candidate.execution_mode === undefined ||
        candidate.execution_mode === null
          ? null
          : typeof candidate.execution_mode === "string" &&
              WORK_GRAPH_EXECUTION_MODES.has(
                candidate.execution_mode as WorkGraphExecutionMode,
              )
            ? (candidate.execution_mode as WorkGraphExecutionMode)
            : undefined,
    });
    if (
      candidate.group_id !== undefined &&
      candidate.group_id !== null &&
      typeof candidate.group_id !== "string"
    ) {
      return null;
    }
    if (
      candidate.execution_mode !== undefined &&
      candidate.execution_mode !== null &&
      !WORK_GRAPH_EXECUTION_MODES.has(
        candidate.execution_mode as WorkGraphExecutionMode,
      )
    ) {
      return null;
    }
  }

  const edges: WorkGraphEdge[] = [];
  for (const candidate of value.edges) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.from !== "string" ||
      typeof candidate.to !== "string"
    ) {
      return null;
    }
    const condition = candidate.condition;
    const kind = candidate.kind;
    if (
      condition !== undefined &&
      !WORK_GRAPH_EDGE_CONDITIONS.has(condition as WorkGraphEdgeCondition)
    ) {
      return null;
    }
    if (
      kind !== undefined &&
      !WORK_GRAPH_EDGE_KINDS.has(kind as WorkGraphEdgeKind)
    ) {
      return null;
    }
    if (
      candidate.label !== undefined &&
      candidate.label !== null &&
      typeof candidate.label !== "string"
    ) {
      return null;
    }
    if (
      candidate.retry_limit !== undefined &&
      candidate.retry_limit !== null &&
      typeof candidate.retry_limit !== "number"
    ) {
      return null;
    }
    edges.push({
      id: candidate.id,
      from: candidate.from,
      to: candidate.to,
      label:
        typeof candidate.label === "string" ? candidate.label : null,
      condition: condition as WorkGraphEdgeCondition | undefined,
      kind: kind as WorkGraphEdgeKind | undefined,
      retry_limit:
        typeof candidate.retry_limit === "number"
          ? candidate.retry_limit
          : null,
    });
  }

  const groups: WorkGraphGroup[] = [];
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > WORK_GRAPH_LIMITS.maxGroups) {
      return null;
    }
    for (const candidate of value.groups) {
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== "string" ||
        typeof candidate.title !== "string" ||
        (candidate.direction !== "LR" && candidate.direction !== "TD") ||
        !WORK_GRAPH_EXECUTION_MODES.has(
          candidate.execution_mode as WorkGraphExecutionMode,
        ) ||
        !isRecord(candidate.generation) ||
        (candidate.generation.mode !== "fixed" &&
          candidate.generation.mode !== "prompt")
      ) {
        return null;
      }
      groups.push({
        id: candidate.id,
        title: candidate.title,
        direction: candidate.direction as WorkGraphGroupDirection,
        execution_mode: candidate.execution_mode as WorkGraphExecutionMode,
        generation: {
          mode: candidate.generation.mode as WorkGraphGroupGenerationMode,
          count:
            typeof candidate.generation.count === "number"
              ? candidate.generation.count
              : null,
          prompt:
            typeof candidate.generation.prompt === "string"
              ? candidate.generation.prompt
              : null,
          max_nodes:
            typeof candidate.generation.max_nodes === "number"
              ? candidate.generation.max_nodes
              : null,
        },
      });
    }
  }
  const executionMode = value.execution_mode;
  if (
    executionMode !== undefined &&
    !WORK_GRAPH_EXECUTION_MODES.has(executionMode as WorkGraphExecutionMode)
  ) {
    return null;
  }
  const graph: WorkGraph = {
    version: WORK_GRAPH_VERSION,
    execution_mode: "sequential",
    nodes,
    edges,
    groups,
  };
  return validateWorkGraph(graph).valid ? graph : null;
}

function finitePosition(value: unknown): SessionGraphNodePosition | null {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    return null;
  }
  return snapGraphCanvasPosition({ x: value.x, y: value.y });
}

function finiteViewport(value: unknown): SessionGraphViewport | null {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.zoom !== "number" ||
    !Number.isFinite(value.zoom) ||
    value.zoom <= 0
  ) {
    return null;
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

function defaultNodePosition(
  node: WorkGraphNode,
  executableIndex: number,
  direction: WorkGraphGroupDirection,
): SessionGraphNodePosition {
  const horizontal = node.kind === "goal_sink"
    ? position(560, 80)
    : position(
        80 + (executableIndex % 3) * 256,
        80 + Math.floor(executableIndex / 3) * 176,
      );
  return direction === "TD"
    ? { x: horizontal.y, y: horizontal.x }
    : horizontal;
}

function sanitizeCanvas(
  value: unknown,
  graph: WorkGraph,
): SessionGraphCanvas | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return null;
  const direction: WorkGraphGroupDirection =
    value.direction === "TD" ? "TD" : DEFAULT_GRAPH_CANVAS_DIRECTION;
  const persistedPositions = isRecord(value.node_positions)
    ? value.node_positions
    : {};
  const nodePositions: Record<string, SessionGraphNodePosition> = {};
  let executableIndex = 0;
  for (const node of graph.nodes) {
    nodePositions[node.id] =
      finitePosition(persistedPositions[node.id]) ??
      defaultNodePosition(node, executableIndex, direction);
    if (node.kind !== "goal_sink") executableIndex += 1;
  }
  const persistedGroupPositions = isRecord(value.group_positions)
    ? value.group_positions
    : {};
  const groupPositions: Record<string, SessionGraphNodePosition> = {};
  for (const group of graph.groups ?? []) {
    groupPositions[group.id] =
      finitePosition(persistedGroupPositions[group.id]) ?? position(80, 80);
  }
  const persistedLockedNodeIds = new Set(
    Array.isArray(value.locked_node_ids)
      ? value.locked_node_ids.filter(
          (nodeId): nodeId is string => typeof nodeId === "string",
        )
      : [],
  );
  return {
    version: 2,
    direction,
    node_positions: nodePositions,
    locked_node_ids: graph.nodes
      .map((node) => node.id)
      .filter((nodeId) => persistedLockedNodeIds.has(nodeId)),
    group_positions: groupPositions,
    viewport:
      value.viewport === undefined || value.viewport === null
        ? null
        : finiteViewport(value.viewport),
  };
}

function sanitizeGraphPresetSnapshot(
  value: unknown,
): GraphPresetSnapshot | null {
  if (!isRecord(value) || value.version !== GRAPH_PRESET_SNAPSHOT_VERSION) {
    return null;
  }
  const definition = sanitizeWorkGraph(value.definition);
  if (!definition) return null;
  const canvas = sanitizeCanvas(value.canvas, definition);
  if (!canvas) return null;
  return {
    version: GRAPH_PRESET_SNAPSHOT_VERSION,
    definition,
    canvas,
  };
}

function sanitizeCustomPreset(
  value: unknown,
  legacy: boolean,
): CustomGraphPreset | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (
    !id ||
    !name ||
    !validPresetId(id) ||
    !validPresetName(name) ||
    BUILTIN_GRAPH_PRESET_IDS.has(id)
  ) {
    return null;
  }

  const snapshotValue = legacy
    ? isRecord(value.graph)
      ? {
          version: GRAPH_PRESET_SNAPSHOT_VERSION,
          definition: value.graph.definition,
          canvas: value.graph.canvas,
        }
      : null
    : value.snapshot;
  const snapshot = sanitizeGraphPresetSnapshot(snapshotValue);
  if (!snapshot) return null;
  return { id, name, builtIn: false, groupId: "custom", snapshot };
}

function sanitizePreferences(
  value: unknown,
  expectedLegacy: boolean | null = null,
): GraphPresetPreferences {
  if (!isRecord(value)) return emptyPreferences();
  const legacy =
    expectedLegacy ?? value.schemaVersion === 1;
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== (legacy ? 1 : GRAPH_PRESET_SCHEMA_VERSION)
  ) {
    return emptyPreferences();
  }

  const customPresets: CustomGraphPreset[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(value.customPresets)) {
    for (const candidate of value.customPresets) {
      if (customPresets.length >= MAX_CUSTOM_PRESETS) break;
      const preset = sanitizeCustomPreset(candidate, legacy);
      if (!preset || seenIds.has(preset.id)) continue;
      seenIds.add(preset.id);
      customPresets.push(preset);
    }
  }

  const lastPresetId =
    typeof value.lastPresetId === "string" &&
    validPresetId(value.lastPresetId.trim())
      ? value.lastPresetId.trim()
      : null;
  return {
    schemaVersion: GRAPH_PRESET_SCHEMA_VERSION,
    customPresets,
    lastPresetId,
  };
}

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseGraphPresetPreferences(
  raw: string | null,
  legacy: boolean | null = null,
): GraphPresetPreferences {
  if (!raw) return emptyPreferences();
  try {
    return sanitizePreferences(JSON.parse(raw) as unknown, legacy);
  } catch {
    return emptyPreferences();
  }
}

export function loadGraphPresetPreferences(): GraphPresetPreferences {
  const storage = storageOrNull();
  if (!storage) return emptyPreferences();
  try {
    const current = storage.getItem(GRAPH_PRESET_STORAGE_KEY);
    if (current !== null) return parseGraphPresetPreferences(current, false);
    return parseGraphPresetPreferences(
      storage.getItem(LEGACY_GRAPH_PRESET_STORAGE_KEY),
      true,
    );
  } catch {
    return emptyPreferences();
  }
}

export function saveGraphPresetPreferences(
  preferences: GraphPresetPreferences,
): void {
  const storage = storageOrNull();
  if (!storage) return;
  try {
    const canonical = sanitizePreferences(preferences, false);
    storage.setItem(GRAPH_PRESET_STORAGE_KEY, JSON.stringify(canonical));
  } catch {
    // Graph presets remain optional when local storage is unavailable.
  }
}

export function cloneGraphPresetSnapshot(
  snapshot: GraphPresetSnapshot,
): GraphPresetSnapshot {
  return {
    version: GRAPH_PRESET_SNAPSHOT_VERSION,
    definition: {
      version: WORK_GRAPH_VERSION,
      execution_mode: "sequential",
      nodes: snapshot.definition.nodes.map((node) => ({ ...node })),
      edges: snapshot.definition.edges.map((edge) => ({ ...edge })),
      groups: snapshot.definition.groups?.map((group) => ({
        ...group,
        generation: { ...group.generation },
      })),
    },
    canvas: {
      version: 2,
      direction: graphCanvasDirection(snapshot.canvas),
      node_positions: Object.fromEntries(
        Object.entries(snapshot.canvas.node_positions).map(([id, value]) => [
          id,
          { ...value },
        ]),
      ),
      locked_node_ids: [...(snapshot.canvas.locked_node_ids ?? [])],
      group_positions: Object.fromEntries(
        Object.entries(snapshot.canvas.group_positions ?? {}).map(
          ([id, value]) => [id, { ...value }],
        ),
      ),
      viewport: snapshot.canvas.viewport
        ? { ...snapshot.canvas.viewport }
        : null,
    },
  };
}

export function createGraphPresetSnapshot(
  source: GraphPresetSource,
): GraphPresetSnapshot {
  const snapshot = sanitizeGraphPresetSnapshot({
    version: GRAPH_PRESET_SNAPSHOT_VERSION,
    definition: source.definition,
    canvas: source.canvas,
  });
  if (!snapshot) throw new Error("A graph preset requires a valid work graph and canvas.");
  return cloneGraphPresetSnapshot(snapshot);
}

export function listGraphPresets(
  preferences: GraphPresetPreferences,
): GraphPreset[] {
  return [...BUILTIN_GRAPH_PRESETS, ...preferences.customPresets];
}

export function findGraphPreset(
  preferences: GraphPresetPreferences,
  presetId: string,
): GraphPreset | null {
  return (
    listGraphPresets(preferences).find((preset) => preset.id === presetId) ??
    null
  );
}

export function resolveInitialGraphPresetId(
  preferences: GraphPresetPreferences,
): string {
  return preferences.lastPresetId &&
    findGraphPreset(preferences, preferences.lastPresetId)
    ? preferences.lastPresetId
    : DEFAULT_GRAPH_PRESET_ID;
}

function normalizedCustomIdentity(id: string, name: string): {
  id: string;
  name: string;
} {
  const normalizedId = id.trim();
  const normalizedName = name.trim();
  if (
    !normalizedId ||
    !validPresetId(normalizedId) ||
    BUILTIN_GRAPH_PRESET_IDS.has(normalizedId)
  ) {
    throw new Error("A custom graph preset requires a valid, unique custom id.");
  }
  if (!normalizedName || !validPresetName(normalizedName)) {
    throw new Error("A custom graph preset requires a valid name.");
  }
  return { id: normalizedId, name: normalizedName };
}

export function createCustomGraphPreset(
  source: GraphPresetSource,
  id: string,
  name: string,
): CustomGraphPreset {
  const identity = normalizedCustomIdentity(id, name);
  return {
    ...identity,
    builtIn: false,
    groupId: "custom",
    snapshot: createGraphPresetSnapshot(source),
  };
}

export function saveCustomGraphPreset(
  preferences: GraphPresetPreferences,
  source: GraphPresetSource,
  id: string,
  name: string,
): GraphPresetPreferences {
  if (findGraphPreset(preferences, id.trim())) {
    throw new Error("A graph preset with this id already exists.");
  }
  if (preferences.customPresets.length >= MAX_CUSTOM_PRESETS) {
    throw new Error(`At most ${MAX_CUSTOM_PRESETS} custom graph presets can be saved.`);
  }
  return {
    ...preferences,
    customPresets: [
      ...preferences.customPresets,
      createCustomGraphPreset(source, id, name),
    ],
  };
}

export function duplicateGraphPreset(
  preferences: GraphPresetPreferences,
  sourcePresetId: string,
  id: string,
  name: string,
): GraphPresetPreferences {
  const source = findGraphPreset(preferences, sourcePresetId);
  if (!source) throw new Error("The graph preset to duplicate does not exist.");
  return saveCustomGraphPreset(preferences, source.snapshot, id, name);
}

export function updateCustomGraphPreset(
  preferences: GraphPresetPreferences,
  presetId: string,
  source: GraphPresetSource,
  name?: string,
): GraphPresetPreferences {
  const selected = preferences.customPresets.find(
    (preset) => preset.id === presetId,
  );
  if (!selected) return preferences;
  const nextName = name === undefined
    ? selected.name
    : normalizedCustomIdentity(selected.id, name).name;
  return {
    ...preferences,
    customPresets: preferences.customPresets.map((preset) =>
      preset.id === presetId
        ? {
            ...preset,
            name: nextName,
            snapshot: createGraphPresetSnapshot(source),
          }
        : preset,
    ),
  };
}

export function deleteCustomGraphPreset(
  preferences: GraphPresetPreferences,
  presetId: string,
): GraphPresetPreferences {
  const customPresets = preferences.customPresets.filter(
    (preset) => preset.id !== presetId,
  );
  if (customPresets.length === preferences.customPresets.length) {
    return preferences;
  }
  return {
    ...preferences,
    customPresets,
    lastPresetId:
      preferences.lastPresetId === presetId
        ? DEFAULT_GRAPH_PRESET_ID
        : preferences.lastPresetId,
  };
}

export function markGraphPresetApplied(
  preferences: GraphPresetPreferences,
  presetId: string,
): GraphPresetPreferences {
  if (!findGraphPreset(preferences, presetId)) return preferences;
  return { ...preferences, lastPresetId: presetId };
}

export function applyGraphPreset(
  current: SessionGraph,
  preset: GraphPreset,
): SessionGraph {
  const snapshot = cloneGraphPresetSnapshot(preset.snapshot);
  return {
    ...current,
    agent: { ...current.agent },
    definition: snapshot.definition,
    canvas: snapshot.canvas,
  };
}

export function listGraphNodePromptPresets(
  kind?: Exclude<WorkGraphNodeKind, "goal_sink">,
): readonly GraphNodePromptPreset[] {
  return kind === undefined
    ? BUILTIN_GRAPH_NODE_PROMPT_PRESETS
    : BUILTIN_GRAPH_NODE_PROMPT_PRESETS.filter(
        (preset) => preset.kind === kind,
      );
}

export function findGraphNodePromptPreset(
  presetId: string,
): GraphNodePromptPreset | null {
  return (
    BUILTIN_GRAPH_NODE_PROMPT_PRESETS.find(
      (preset) => preset.id === presetId,
    ) ?? null
  );
}

export function applyGraphNodePromptPreset(
  graph: WorkGraph,
  nodeId: string,
  preset: GraphNodePromptPreset,
): WorkGraph {
  const selected = graph.nodes.find((node) => node.id === nodeId);
  if (!selected || selected.kind === "goal_sink") return graph;
  return {
    ...graph,
    version: WORK_GRAPH_VERSION,
    execution_mode: "sequential",
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            kind: preset.kind,
            title: preset.title,
            instruction: preset.instruction,
          }
        : { ...node },
    ),
    edges: graph.edges.map((edge) => ({ ...edge })),
    groups: graph.groups?.map((group) => ({
      ...group,
      generation: { ...group.generation },
    })),
  };
}
