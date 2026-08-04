import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  PanOnScrollMode,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import {
  Boxes,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  GitMerge,
  Hand,
  LoaderCircle,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Send,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Trash2,
  UserRound,
  Waypoints,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  addGraphGroup,
  addGraphNode,
  connectGraphNodes,
  removeGraphGroup,
  resizeFixedGraphGroup,
  updateGraphGroup,
  type GraphConnectionError,
  validateProspectiveGraphEdge,
} from "../lib/graphSession";
import { BUILTIN_GRAPH_NODE_PROMPT_PRESETS } from "../lib/graphPresets";
import { cn } from "../lib/cn";
import type { TranslationKey } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import {
  expandWorkGraphEdges,
  serializeWorkGraphToMermaid,
  validateWorkGraph,
  workGraphEdgeCondition,
  workGraphGroups,
  type WorkGraphExecutionMode,
  type WorkGraphEdgeCondition,
  type WorkGraphEdgeKind,
  type WorkGraphGroup,
  type WorkGraphNodeKind,
} from "../lib/workGraph";
import type {
  GraphNodeRunStatus,
  GraphNodeVerdict,
  GraphRunState,
  SessionGraphCanvas,
} from "../lib/types";
import {
  GraphFlowEdgeComponent,
  type GraphFlowEdge,
  type GraphFlowEdgeData,
} from "./GraphFlowEdge";
import { Button, Field, Select } from "./ui";

const EXECUTABLE_KINDS = [
  "agent",
  "validator",
  "merge",
  "human",
] as const satisfies readonly WorkGraphNodeKind[];

const GRAPH_NODE_WIDTH = 224;
const GRAPH_NODE_HEIGHT = 144;
const GROUP_HEADER_HEIGHT = 72;
const GROUP_PADDING_X = 48;
const GROUP_PADDING_BOTTOM = 32;
const GROUP_GAP = 24;
const SNAP_GRID: [number, number] = [16, 16];

const NODE_PROMPT_PRESET_NAME_KEYS: Record<string, TranslationKey> = {
  "builtin:node:agent-research:v1":
    "graphSession.canvas.promptPresetNames.research",
  "builtin:node:agent-implement:v1":
    "graphSession.canvas.promptPresetNames.implement",
  "builtin:node:validator-verify:v1":
    "graphSession.canvas.promptPresetNames.verify",
  "builtin:node:merge-synthesize:v1":
    "graphSession.canvas.promptPresetNames.synthesize",
  "builtin:node:human-approval:v1":
    "graphSession.canvas.promptPresetNames.humanApproval",
};

type GraphNodeData = {
  id: string;
  kind: WorkGraphNodeKind;
  kindLabel: string;
  title: string;
  instruction: string;
  sourceHandleLabel: string;
  targetHandleLabel: string;
  status: GraphNodeRunStatus | null;
  question: string | null;
  requiresVerdict: boolean;
  canSubmitHumanInput: boolean;
  onHumanInput?: (
    nodeId: string,
    input: string,
    verdict?: GraphNodeVerdict,
  ) => Promise<void>;
};

type GraphGroupData = {
  id: string;
  title: string;
  generationMode: WorkGraphGroup["generation"]["mode"];
  memberCount: number;
  sourceHandleLabel: string;
  targetHandleLabel: string;
  status: GraphNodeRunStatus | null;
};

type WorkGraphFlowNode = Node<GraphNodeData, "workGraph">;
type WorkGraphGroupFlowNode = Node<GraphGroupData, "workGraphGroup">;
type GraphFlowNode = WorkGraphFlowNode | WorkGraphGroupFlowNode;

export interface GraphCanvasValue {
  definition: import("../lib/workGraph").WorkGraph;
  canvas: SessionGraphCanvas;
}

export interface GraphCanvasEditorProps {
  value: GraphCanvasValue;
  onChange: (value: GraphCanvasValue) => void;
  disabled?: boolean;
  className?: string;
  runState?: GraphRunState | null;
  mode?: "edit" | "run";
  onHumanInput?: (
    nodeId: string,
    input: string,
    verdict?: GraphNodeVerdict,
  ) => Promise<void>;
}

function kindIcon(kind: WorkGraphNodeKind) {
  switch (kind) {
    case "agent":
      return <Sparkles size={13} />;
    case "validator":
      return <ShieldCheck size={13} />;
    case "merge":
      return <GitMerge size={13} />;
    case "human":
      return <UserRound size={13} />;
    case "goal_sink":
      return <CircleCheck size={15} />;
  }
}

const STATUS_LABEL_KEYS = {
  queued: "graphSession.canvas.statuses.queued",
  working: "graphSession.canvas.statuses.working",
  waiting: "graphSession.canvas.statuses.waiting",
  completed: "graphSession.canvas.statuses.completed",
  failed: "graphSession.canvas.statuses.failed",
  skipped: "graphSession.canvas.statuses.skipped",
  cancelled: "graphSession.canvas.statuses.cancelled",
} as const satisfies Record<GraphNodeRunStatus, string>;

const STATUS_CLASS_NAMES: Record<GraphNodeRunStatus, string> = {
  queued: "border-border bg-bg-elevated",
  working: "border-accent/70 bg-accent/10",
  waiting: "border-warning/70 bg-warning/10",
  completed: "border-success/65 bg-success/10",
  failed: "border-danger/70 bg-danger/10",
  skipped: "border-fg-muted/35 bg-fill/40 opacity-75",
  cancelled: "border-fg-muted/35 bg-fill/40 opacity-75",
};

function statusClassName(status: GraphNodeRunStatus | null): string {
  return status ? STATUS_CLASS_NAMES[status] : "";
}

function StatusMark({ status }: { status: GraphNodeRunStatus }) {
  const className = cn(
    "shrink-0",
    status === "working" && "animate-spin text-accent",
    status === "waiting" && "text-warning",
    status === "completed" && "text-success",
    status === "failed" && "text-danger",
    (status === "skipped" || status === "cancelled") && "text-fg-muted",
    status === "queued" && "text-fg-muted",
  );
  switch (status) {
    case "working":
      return <LoaderCircle size={11} className={className} />;
    case "waiting":
      return <Clock3 size={11} className={className} />;
    case "completed":
      return <Check size={11} className={className} />;
    case "failed":
      return <CircleAlert size={11} className={className} />;
    case "skipped":
    case "cancelled":
      return <SkipForward size={11} className={className} />;
    case "queued":
      return <Clock3 size={11} className={className} />;
  }
}

function HumanNodeInput({ data }: { data: GraphNodeData }) {
  const t = useTranslation();
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function submitAnswer(verdict?: GraphNodeVerdict) {
    const answer = input.trim();
    if (!answer || !data.onHumanInput || pending) return;
    setPending(true);
    setError(false);
    try {
      await data.onHumanInput(data.id, answer, verdict);
      setInput("");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!data.requiresVerdict) void submitAnswer();
  }

  return (
    <form
      className="nodrag nopan nowheel mt-1.5"
      onSubmit={(event) => void submit(event)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex gap-1">
        <input
          aria-label={data.question ?? t("graphSession.canvas.humanInput")}
          value={input}
          disabled={pending || !data.canSubmitHumanInput}
          placeholder={data.question || t("graphSession.canvas.reply")}
          onChange={(event) => setInput(event.target.value)}
          className={cn(
            "h-7 min-w-0 flex-1 rounded-md border bg-input px-2 text-[10px] text-fg outline-none",
            error ? "border-danger" : "border-input-border focus:border-accent",
          )}
        />
        <button
          type="submit"
          aria-label={t("graphSession.canvas.sendHumanInput")}
          disabled={
            data.requiresVerdict ||
            !input.trim() ||
            pending ||
            !data.canSubmitHumanInput
          }
          className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-on-accent transition hover:bg-accent-hover disabled:opacity-45"
        >
          {pending ? (
            <LoaderCircle size={11} className="animate-spin" />
          ) : (
            <Send size={11} />
          )}
        </button>
      </div>
      {data.requiresVerdict ? (
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            disabled={!input.trim() || pending || !data.canSubmitHumanInput}
            className="h-6 flex-1 rounded-md bg-success/15 text-[9px] font-semibold text-success transition hover:bg-success/25 disabled:opacity-45"
            onClick={() => void submitAnswer("approved")}
          >
            {t("graphSession.canvas.approve")}
          </button>
          <button
            type="button"
            disabled={!input.trim() || pending || !data.canSubmitHumanInput}
            className="h-6 flex-1 rounded-md bg-danger/10 text-[9px] font-semibold text-danger transition hover:bg-danger/20 disabled:opacity-45"
            onClick={() => void submitAnswer("rejected")}
          >
            {t("graphSession.canvas.reject")}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function WorkGraphFlowNode({ data, selected }: NodeProps<WorkGraphFlowNode>) {
  const t = useTranslation();
  const isGoal = data.kind === "goal_sink";
  const showHumanInput =
    data.kind === "human" && data.status === "waiting" && data.onHumanInput;
  return (
    <div
      className={cn(
        "flex h-36 w-56 flex-col overflow-hidden rounded-xl border bg-bg-elevated shadow-lg transition",
        isGoal ? "border-accent/60 bg-accent/10" : "border-border",
        data.status && statusClassName(data.status),
        selected && "ring-2 ring-accent/50",
      )}
      data-graph-node={data.id}
      data-graph-node-status={data.status ?? "idle"}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !border-2 !border-bg !bg-accent"
        aria-label={`${data.id} — ${data.targetHandleLabel}`}
      />
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <span className="text-accent">{kindIcon(data.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {isGoal ? "GOAL" : data.kindLabel}
        </span>
        {data.status ? (
          <span className="flex items-center gap-1 text-[9px] font-medium text-fg-muted">
            <StatusMark status={data.status} />
            {t(STATUS_LABEL_KEYS[data.status])}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 px-3 py-2.5">
        <div className="truncate text-xs font-semibold text-fg">
          {isGoal ? "GOAL" : data.title || data.id}
        </div>
        {showHumanInput ? (
          <HumanNodeInput data={data} />
        ) : !isGoal ? (
          <div className="mt-1 line-clamp-3 text-[10px] leading-4 text-fg-muted">
            {data.question || data.instruction}
          </div>
        ) : (
          <div className="mt-1 text-[10px] text-fg-muted">GOAL</div>
        )}
      </div>
      {!isGoal ? (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-3 !border-2 !border-bg !bg-accent"
          aria-label={`${data.id} — ${data.sourceHandleLabel}`}
        />
      ) : null}
    </div>
  );
}

function WorkGraphGroupFlowNode({
  data,
  selected,
}: NodeProps<WorkGraphGroupFlowNode>) {
  const t = useTranslation();
  return (
    <div
      className={cn(
        "h-full w-full rounded-2xl border border-dashed border-accent/45 bg-accent/[0.035] shadow-sm transition",
        data.status && statusClassName(data.status),
        selected && "ring-2 ring-accent/45",
      )}
      data-graph-group={data.id}
      data-graph-node-status={data.status ?? "idle"}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3.5 !border-2 !border-bg !bg-accent"
        aria-label={`${data.id} — ${data.targetHandleLabel}`}
      />
      <div className="flex h-12 items-center gap-2 border-b border-dashed border-accent/25 px-4">
        <span className="grid size-6 place-items-center rounded-md bg-accent/10 text-accent">
          <Boxes size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-fg">{data.title}</div>
          <div className="text-[9px] uppercase tracking-wide text-fg-muted">
            {data.generationMode === "fixed"
              ? t("graphSession.canvas.fixedCount")
              : t("graphSession.canvas.promptGenerated")} · {data.generationMode === "fixed"
              ? data.memberCount
              : t("graphSession.canvas.auto")}{" "}
            {t("graphSession.canvas.nodes")}
          </div>
        </div>
        {data.status ? (
          <span className="flex items-center gap-1 text-[9px] text-fg-muted">
            <StatusMark status={data.status} />
            {t(STATUS_LABEL_KEYS[data.status])}
          </span>
        ) : null}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-3.5 !border-2 !border-bg !bg-accent"
        aria-label={`${data.id} — ${data.sourceHandleLabel}`}
      />
    </div>
  );
}

const NODE_TYPES = {
  workGraph: WorkGraphFlowNode,
  workGraphGroup: WorkGraphGroupFlowNode,
};
const EDGE_TYPES = { graphFlow: GraphFlowEdgeComponent };

const CONNECTION_ERROR_KEYS = {
  missingEndpoint: "graphSession.connectionErrors.missingEndpoint",
  unknownNode: "graphSession.connectionErrors.unknownNode",
  selfConnection: "graphSession.connectionErrors.selfConnection",
  goalOutgoing: "graphSession.connectionErrors.goalOutgoing",
  dynamicGroupBoundary: "graphSession.connectionErrors.dynamicGroupBoundary",
  duplicate: "graphSession.connectionErrors.duplicate",
  cycle: "graphSession.connectionErrors.cycle",
} as const satisfies Record<GraphConnectionError, string>;

function groupDimensions(group: WorkGraphGroup, memberCount: number) {
  const count = Math.max(1, memberCount);
  if (group.direction === "TD") {
    return {
      width: GROUP_PADDING_X * 2 + GRAPH_NODE_WIDTH,
      height:
        GROUP_HEADER_HEIGHT +
        count * GRAPH_NODE_HEIGHT +
        (count - 1) * GROUP_GAP +
        GROUP_PADDING_BOTTOM,
    };
  }
  return {
    width:
      GROUP_PADDING_X * 2 +
      count * GRAPH_NODE_WIDTH +
      (count - 1) * GROUP_GAP,
    height: GROUP_HEADER_HEIGHT + GRAPH_NODE_HEIGHT + GROUP_PADDING_BOTTOM,
  };
}

function fallbackGroupMemberPosition(
  group: WorkGraphGroup,
  index: number,
): { x: number; y: number } {
  return group.direction === "TD"
    ? { x: GROUP_PADDING_X, y: GROUP_HEADER_HEIGHT + index * (GRAPH_NODE_HEIGHT + GROUP_GAP) }
    : { x: GROUP_PADDING_X + index * (GRAPH_NODE_WIDTH + GROUP_GAP), y: GROUP_HEADER_HEIGHT };
}

function groupRunStatus(
  memberIds: readonly string[],
  runState: GraphRunState | null | undefined,
): GraphNodeRunStatus | null {
  const statuses = memberIds
    .map((id) => runState?.nodes[id]?.status)
    .filter((status): status is GraphNodeRunStatus => Boolean(status));
  if (statuses.length === 0) return null;
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("queued")) return "queued";
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.every((status) => status === "skipped" || status === "cancelled")) {
    return statuses.includes("cancelled") ? "cancelled" : "skipped";
  }
  return "completed";
}

export function GraphCanvasEditor({
  value,
  onChange,
  disabled = false,
  className,
  runState = null,
  mode = "edit",
  onHumanInput,
}: GraphCanvasEditorProps) {
  const t = useTranslation();
  const canEdit = mode === "edit" && !disabled;
  const displayDefinition = runState?.definition ?? value.definition;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectionKind, setConnectionKind] =
    useState<WorkGraphEdgeKind>("dependency");
  const [connectionError, setConnectionError] =
    useState<GraphConnectionError | null>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<GraphFlowNode, GraphFlowEdge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pendingSelectionIdRef = useRef<string | null>(null);
  const latestValueRef = useRef(value);
  const latestOnChangeRef = useRef(onChange);
  latestValueRef.current = value;
  latestOnChangeRef.current = onChange;

  const validation = useMemo(
    () => validateWorkGraph(displayDefinition),
    [displayDefinition],
  );
  const mermaid = useMemo(
    () =>
      validation.valid
        ? serializeWorkGraphToMermaid(displayDefinition)
        : null,
    [displayDefinition, validation.valid],
  );
  const selectedNode = displayDefinition.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const selectedGroup = workGraphGroups(displayDefinition).find(
    (group) => group.id === selectedNodeId,
  );
  const savedNode = value.definition.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const savedGroup = workGraphGroups(value.definition).find(
    (group) => group.id === selectedNodeId,
  );
  const selectedEdge = displayDefinition.edges.find(
    (edge) => edge.id === selectedEdgeId,
  );
  const savedEdge = value.definition.edges.find(
    (edge) => edge.id === selectedEdgeId,
  );
  const selectedRetryCondition: WorkGraphEdgeCondition = selectedEdge
    ? (() => {
        const sourceKinds = new Set(
          expandWorkGraphEdges(displayDefinition)
            .filter((edge) => edge.source_edge_id === selectedEdge.id)
            .map((edge) =>
              displayDefinition.nodes.find((node) => node.id === edge.from)?.kind,
            )
            .filter((kind): kind is WorkGraphNodeKind => Boolean(kind)),
        );
        return sourceKinds.size === 1 && sourceKinds.has("human")
          ? "rejected"
          : "fail";
      })()
    : "fail";
  const selectedEdgeConditionOptions: readonly WorkGraphEdgeCondition[] =
    (selectedEdge?.kind ?? "dependency") === "retry"
      ? [selectedRetryCondition]
      : ["always", "pass", "fail", "approved", "rejected"];

  const derivedNodes = useMemo<GraphFlowNode[]>(() => {
    const groups = workGraphGroups(displayDefinition);
    const groupIds = new Set(groups.map((group) => group.id));
    const groupNodes: WorkGraphGroupFlowNode[] = groups.map((group, index) => {
      const members = displayDefinition.nodes.filter(
        (node) => node.group_id === group.id,
      );
      const dimensions = groupDimensions(group, members.length);
      return {
        id: group.id,
        type: "workGraphGroup",
        position: value.canvas.group_positions?.[group.id] ?? {
          x: 64,
          y: 64 + index * (dimensions.height + 48),
        },
        style: dimensions,
        data: {
          id: group.id,
          title: group.title,
          generationMode: group.generation.mode,
          memberCount: members.length,
          sourceHandleLabel: t("graphSession.sourceHandle"),
          targetHandleLabel: t("graphSession.targetHandle"),
          status: groupRunStatus(
            members.map((member) => member.id),
            runState,
          ),
        },
        deletable:
          canEdit &&
          workGraphGroups(value.definition).some(
            (saved) => saved.id === group.id,
          ),
        draggable: canEdit,
        connectable: canEdit,
      };
    });

    const memberIndex = new Map<string, number>();
    for (const group of groups) {
      displayDefinition.nodes
        .filter((node) => node.group_id === group.id)
        .forEach((node, index) => memberIndex.set(node.id, index));
    }

    const regularNodes: WorkGraphFlowNode[] = displayDefinition.nodes.map(
      (node, index) => {
        const group = node.group_id
          ? groups.find((candidate) => candidate.id === node.group_id)
          : undefined;
        const position = group
          ? value.canvas.node_positions[node.id] ??
            fallbackGroupMemberPosition(group, memberIndex.get(node.id) ?? 0)
          : value.canvas.node_positions[node.id] ?? {
              x: 80 + (index % 3) * (GRAPH_NODE_WIDTH + GROUP_GAP),
              y: 80 + Math.floor(index / 3) * (GRAPH_NODE_HEIGHT + GROUP_GAP),
            };
        const runtimeNode = runState?.nodes[node.id];
        const existsInSavedGraph = value.definition.nodes.some(
          (saved) => saved.id === node.id,
        );
        return {
          id: node.id,
          type: "workGraph",
          position,
          width: GRAPH_NODE_WIDTH,
          height: GRAPH_NODE_HEIGHT,
          parentId: group && groupIds.has(group.id) ? group.id : undefined,
          extent: group ? "parent" : undefined,
          data: {
            ...node,
            kindLabel:
              node.kind === "goal_sink"
                ? "GOAL"
                : t(`chat.graphEditor.kinds.${node.kind}`),
            sourceHandleLabel: t("graphSession.sourceHandle"),
            targetHandleLabel: t("graphSession.targetHandle"),
            status: runtimeNode?.status ?? null,
            question: runtimeNode?.question ?? null,
            requiresVerdict:
              node.kind === "human" &&
              displayDefinition.edges.some(
                (edge) =>
                  edge.from === node.id &&
                  (edge.condition === "approved" || edge.condition === "rejected"),
              ),
            canSubmitHumanInput:
              mode === "run" &&
              runtimeNode?.status === "waiting" &&
              Boolean(onHumanInput),
            onHumanInput,
          },
          deletable:
            canEdit && existsInSavedGraph && node.kind !== "goal_sink",
          draggable: canEdit && existsInSavedGraph,
          connectable:
            canEdit &&
            existsInSavedGraph &&
            group?.generation.mode !== "prompt",
        };
      },
    );

    return [...groupNodes, ...regularNodes];
  }, [
    canEdit,
    displayDefinition,
    mode,
    onHumanInput,
    runState,
    t,
    value.canvas.group_positions,
    value.canvas.node_positions,
    value.definition.nodes,
  ]);
  const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>(derivedNodes);
  const nodeIdSignature = derivedNodes.map((node) => node.id).join("\0");

  useEffect(() => {
    setFlowNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return derivedNodes.map((node) => {
        const existing = currentById.get(node.id);
        return existing
          ? {
              ...existing,
              ...node,
              measured: existing.measured ?? node.measured,
            }
          : node;
      });
    });
  }, [derivedNodes]);

  useEffect(() => {
    const pendingId = pendingSelectionIdRef.current;
    if (!pendingId || !derivedNodes.some((node) => node.id === pendingId)) return;
    pendingSelectionIdRef.current = null;
    setFlowNodes((current) =>
      current.map((node) => ({ ...node, selected: node.id === pendingId })),
    );
  }, [derivedNodes, nodeIdSignature]);

  const ensureGraphIsVisible = useCallback(async () => {
    const container = canvasRef.current;
    if (!flowInstance || !container || displayDefinition.nodes.length <= 1) return;
    const currentNodes = flowInstance.getNodes().filter((node) => !node.parentId);
    if (currentNodes.length <= 1) return;
    const bounds = flowInstance.getNodesBounds(currentNodes);
    const viewport = flowInstance.getViewport();
    const padding = 24;
    const left = bounds.x * viewport.zoom + viewport.x;
    const top = bounds.y * viewport.zoom + viewport.y;
    const right = (bounds.x + bounds.width) * viewport.zoom + viewport.x;
    const bottom = (bounds.y + bounds.height) * viewport.zoom + viewport.y;
    const fullyVisible =
      left >= padding &&
      top >= padding &&
      right <= container.clientWidth - padding &&
      bottom <= container.clientHeight - padding;
    if (fullyVisible) return;

    const fitted = await flowInstance.fitView({
      duration: 0,
      maxZoom: 1,
      padding: 0.18,
      nodes: currentNodes,
    });
    if (!fitted) return;
    const nextViewport = flowInstance.getViewport();
    const current = latestValueRef.current;
    const savedViewport = current.canvas.viewport;
    if (
      savedViewport &&
      Math.abs(savedViewport.x - nextViewport.x) < 0.01 &&
      Math.abs(savedViewport.y - nextViewport.y) < 0.01 &&
      Math.abs(savedViewport.zoom - nextViewport.zoom) < 0.001
    ) {
      return;
    }
    latestOnChangeRef.current({
      ...current,
      canvas: { ...current.canvas, viewport: nextViewport },
    });
  }, [displayDefinition.nodes.length, flowInstance]);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void ensureGraphIsVisible();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [ensureGraphIsVisible, nodeIdSignature]);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void ensureGraphIsVisible();
      });
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ensureGraphIsVisible]);

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges<GraphFlowNode>>[0]) => {
      setFlowNodes((current) => applyNodeChanges(changes, current));
    },
    [],
  );

  const edges = useMemo<GraphFlowEdge[]>(
    () =>
      displayDefinition.edges.map((edge) => {
        const runtimeEdge = runState?.edges[edge.id];
        const condition = workGraphEdgeCondition(edge);
        const label = [
          edge.label?.trim(),
          condition === "always"
            ? null
            : t(`graphSession.canvas.conditions.${condition}`),
        ]
          .filter((part): part is string => Boolean(part))
          .join(" / ");
        const sourceFailed = runState?.nodes[edge.from]?.status === "failed";
        const targetFailed = runState?.nodes[edge.to]?.status === "failed";
        const state: GraphFlowEdgeData["state"] = runtimeEdge?.active
          ? "active"
          : sourceFailed || targetFailed
            ? "failed"
            : runtimeEdge?.traversed
              ? "traversed"
              : "idle";
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: "graphFlow",
          selected: edge.id === selectedEdgeId,
          animated: state === "active",
          deletable: canEdit && value.definition.edges.some((saved) => saved.id === edge.id),
          selectable: true,
          data: {
            removable:
              canEdit && value.definition.edges.some((saved) => saved.id === edge.id),
            removeLabel: `${t("graphSession.canvas.disconnectEdge")} ${edge.id}`,
            label: label || null,
            state,
          },
          style: {
            stroke:
              state === "failed"
                ? "var(--color-danger)"
                : state === "traversed"
                  ? "var(--color-success)"
                  : "var(--color-accent)",
            strokeWidth: state === "active" ? 2.5 : 1.7,
            opacity: state === "idle" ? 0.72 : 1,
            strokeDasharray: edge.kind === "retry" ? "7 5" : undefined,
          },
        };
      }),
    [canEdit, displayDefinition.edges, runState, selectedEdgeId, t, value.definition.edges],
  );

  const updateNode = useCallback(
    (patch: Partial<{ kind: WorkGraphNodeKind; title: string; instruction: string }>) => {
      if (!savedNode || savedNode.kind === "goal_sink" || !canEdit) return;
      const current = latestValueRef.current;
      latestOnChangeRef.current({
        ...current,
        definition: {
          ...current.definition,
          nodes: current.definition.nodes.map((node) =>
            node.id === savedNode.id ? { ...node, ...patch } : node,
          ),
        },
      });
    },
    [canEdit, savedNode],
  );

  const updateGroup = useCallback(
    (
      patch: Parameters<typeof updateGraphGroup>[2],
      nextCanvas?: SessionGraphCanvas,
    ) => {
      if (!savedGroup || !canEdit) return;
      const current = latestValueRef.current;
      latestOnChangeRef.current({
        definition: updateGraphGroup(current.definition, savedGroup.id, patch),
        canvas: nextCanvas ?? current.canvas,
      });
    },
    [canEdit, savedGroup],
  );

  const updateEdge = useCallback(
    (patch: Partial<import("../lib/workGraph").WorkGraphEdge>) => {
      if (!savedEdge || !canEdit) return;
      const current = latestValueRef.current;
      latestOnChangeRef.current({
        ...current,
        definition: {
          ...current.definition,
          edges: current.definition.edges.map((edge) =>
            edge.id === savedEdge.id ? { ...edge, ...patch } : edge,
          ),
        },
      });
    },
    [canEdit, savedEdge],
  );

  function removeElements(ids: readonly string[]) {
    if (!canEdit) return;
    const current = latestValueRef.current;
    let definition = current.definition;
    let canvas = current.canvas;
    const requested = new Set(ids);
    for (const group of workGraphGroups(definition)) {
      if (!requested.has(group.id)) continue;
      const removed = removeGraphGroup(definition, canvas, group.id);
      definition = removed.graph;
      canvas = removed.canvas;
    }
    const removable = new Set(
      definition.nodes
        .filter((node) => node.kind !== "goal_sink" && requested.has(node.id))
        .map((node) => node.id),
    );
    if (removable.size > 0) {
      const node_positions = { ...canvas.node_positions };
      for (const id of removable) delete node_positions[id];
      definition = {
        ...definition,
        nodes: definition.nodes.filter((node) => !removable.has(node.id)),
        edges: definition.edges.filter(
          (edge) => !removable.has(edge.from) && !removable.has(edge.to),
        ),
      };
      canvas = { ...canvas, node_positions };
    }
    if (definition === current.definition && canvas === current.canvas) return;
    latestOnChangeRef.current({ definition, canvas });
    setSelectedNodeIds((selected) => selected.filter((id) => !requested.has(id)));
    if (selectedNodeId && requested.has(selectedNodeId)) setSelectedNodeId(null);
  }

  function addNode() {
    if (!canEdit) return;
    const current = latestValueRef.current;
    const added = addGraphNode(current.definition, current.canvas, "agent");
    pendingSelectionIdRef.current = added.nodeId;
    latestOnChangeRef.current({ definition: added.graph, canvas: added.canvas });
    setSelectedNodeId(added.nodeId);
    setSelectedNodeIds([added.nodeId]);
  }

  function addGroup() {
    if (!canEdit) return;
    const current = latestValueRef.current;
    const added = addGraphGroup(current.definition, current.canvas);
    pendingSelectionIdRef.current = added.groupId;
    latestOnChangeRef.current({ definition: added.graph, canvas: added.canvas });
    setSelectedNodeId(added.groupId);
    setSelectedNodeIds([added.groupId]);
  }

  function connect(connection: Connection) {
    if (!canEdit) return;
    const current = latestValueRef.current;
    const retryCondition = current.definition.nodes.find(
      (node) => node.id === connection.source,
    )?.kind === "human"
      ? "rejected"
      : "fail";
    const next = connectGraphNodes(
      current.definition,
      connection.source,
      connection.target,
      connectionKind === "retry"
        ? { kind: "retry", condition: retryCondition, retry_limit: 2 }
        : { kind: "dependency" },
    );
    if (!next) {
      setConnectionError(
        validateProspectiveGraphEdge(
          current.definition,
          connection.source,
          connection.target,
        ),
      );
      return;
    }
    setConnectionError(null);
    latestOnChangeRef.current({ ...current, definition: next });
  }

  function removeEdges(ids: readonly string[]) {
    if (!canEdit || ids.length === 0) return;
    const current = latestValueRef.current;
    const removed = new Set(ids);
    latestOnChangeRef.current({
      ...current,
      definition: {
        ...current.definition,
        edges: current.definition.edges.filter((edge) => !removed.has(edge.id)),
      },
    });
    setSelectedEdgeId((selected) => (selected && removed.has(selected) ? null : selected));
  }

  function persistPosition(node: GraphFlowNode) {
    if (!canEdit) return;
    const current = latestValueRef.current;
    const isGroup = workGraphGroups(current.definition).some(
      (group) => group.id === node.id,
    );
    if (
      !isGroup &&
      !current.definition.nodes.some((candidate) => candidate.id === node.id)
    ) {
      return;
    }
    latestOnChangeRef.current({
      ...current,
      canvas: isGroup
        ? {
            ...current.canvas,
            group_positions: {
              ...(current.canvas.group_positions ?? {}),
              [node.id]: { x: node.position.x, y: node.position.y },
            },
          }
        : {
            ...current.canvas,
            node_positions: {
              ...current.canvas.node_positions,
              [node.id]: { x: node.position.x, y: node.position.y },
            },
          },
    });
  }

  const selectedFlowNodes = flowNodes.filter((node) =>
    selectedNodeIds.includes(node.id),
  );
  const selectedParents = new Set(
    selectedFlowNodes.map((node) => node.parentId ?? null),
  );
  const canAlign =
    canEdit && selectedFlowNodes.length >= 2 && selectedParents.size === 1;

  function alignSelected(axis: "x" | "y") {
    if (!canAlign) return;
    const anchor =
      selectedFlowNodes.find((node) => node.id === selectedNodeId) ??
      selectedFlowNodes[0];
    if (!anchor) return;
    const selectedIds = new Set(selectedFlowNodes.map((node) => node.id));
    setFlowNodes((current) =>
      current.map((node) =>
        selectedIds.has(node.id)
          ? { ...node, position: { ...node.position, [axis]: anchor.position[axis] } }
          : node,
      ),
    );
    const current = latestValueRef.current;
    const groupIds = new Set(workGraphGroups(current.definition).map((group) => group.id));
    const node_positions = { ...current.canvas.node_positions };
    const group_positions = { ...(current.canvas.group_positions ?? {}) };
    for (const node of selectedFlowNodes) {
      const position = { ...node.position, [axis]: anchor.position[axis] };
      if (groupIds.has(node.id)) group_positions[node.id] = position;
      else if (current.definition.nodes.some((candidate) => candidate.id === node.id)) {
        node_positions[node.id] = position;
      }
    }
    latestOnChangeRef.current({
      ...current,
      canvas: { ...current.canvas, node_positions, group_positions },
    });
  }

  function updateGroupDirection(direction: WorkGraphGroup["direction"]) {
    if (!savedGroup || !canEdit) return;
    const current = latestValueRef.current;
    const members = current.definition.nodes.filter(
      (node) => node.group_id === savedGroup.id,
    );
    const nextGroup = { ...savedGroup, direction };
    const node_positions = { ...current.canvas.node_positions };
    for (const [index, member] of members.entries()) {
      node_positions[member.id] = fallbackGroupMemberPosition(nextGroup, index);
    }
    updateGroup(
      { direction },
      { ...current.canvas, node_positions },
    );
  }

  function updateGroupGenerationMode(
    generationMode: WorkGraphGroup["generation"]["mode"],
  ) {
    if (!savedGroup || !canEdit) return;
    const current = latestValueRef.current;
    const memberCount = current.definition.nodes.filter(
      (node) => node.group_id === savedGroup.id,
    ).length;
    const count = generationMode === "prompt"
      ? 1
      : Math.max(1, savedGroup.generation.count ?? memberCount);
    const resized = resizeFixedGraphGroup(
      current.definition,
      current.canvas,
      savedGroup.id,
      count,
    );
    if (!resized) return;
    const definition = updateGraphGroup(resized.graph, savedGroup.id, {
      generation: {
        mode: generationMode,
        count: generationMode === "prompt" ? null : count,
      },
    });
    latestOnChangeRef.current({ definition, canvas: resized.canvas });
  }

  function resizeGroup(count: number) {
    if (!savedGroup || !canEdit) return;
    const current = latestValueRef.current;
    const resized = resizeFixedGraphGroup(
      current.definition,
      current.canvas,
      savedGroup.id,
      count,
    );
    if (resized) {
      latestOnChangeRef.current({ definition: resized.graph, canvas: resized.canvas });
    }
  }

  function updateExecutionMode(executionMode: WorkGraphExecutionMode) {
    if (!canEdit) return;
    const current = latestValueRef.current;
    latestOnChangeRef.current({
      ...current,
      definition: {
        ...current.definition,
        execution_mode: executionMode,
      },
    });
  }

  const selectedPromptPreset = savedNode
    ? BUILTIN_GRAPH_NODE_PROMPT_PRESETS.find(
        (preset) =>
          preset.kind === savedNode.kind &&
          preset.title === savedNode.title &&
          preset.instruction === savedNode.instruction,
      )?.id ?? "custom"
    : "custom";
  const viewport = value.canvas.viewport ?? { x: 0, y: 0, zoom: 1 };

  useEffect(() => {
    if (!flowInstance) return;
    const current = flowInstance.getViewport();
    if (
      Math.abs(current.x - viewport.x) < 0.01 &&
      Math.abs(current.y - viewport.y) < 0.01 &&
      Math.abs(current.zoom - viewport.zoom) < 0.001
    ) {
      return;
    }
    void flowInstance.setViewport(viewport, { duration: 0 });
  }, [flowInstance, viewport.x, viewport.y, viewport.zoom]);

  return (
    <div
      className={cn(
        "grid min-h-0 grid-cols-[minmax(0,1fr)_19rem] overflow-hidden",
        className,
      )}
    >
      <div ref={canvasRef} className="relative min-h-0 border-r border-border bg-bg">
        {canEdit ? (
          <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-1 rounded-lg border border-border bg-bg-elevated/95 p-1.5 shadow-lg">
            <Button size="xs" variant="outline" onClick={addNode}>
              <Plus size={11} /> {t("graphSession.canvas.node")}
            </Button>
            <Button size="xs" variant="outline" onClick={addGroup}>
              <Boxes size={11} /> {t("graphSession.canvas.group")}
            </Button>
            <span className="mx-0.5 w-px self-stretch bg-border" />
            <div className="flex items-center gap-1.5 pl-1 text-[10px] text-fg-muted">
              <span>{t("graphSession.canvas.connection")}</span>
              <Select
                aria-label={t("graphSession.canvas.connectionKind")}
                className="w-28"
                value={connectionKind}
                onValueChange={(kind) => setConnectionKind(kind as WorkGraphEdgeKind)}
                options={[
                  { value: "dependency", label: t("graphSession.canvas.dependency") },
                  { value: "retry", label: t("graphSession.canvas.retry") },
                ]}
              />
            </div>
            <span className="mx-0.5 w-px self-stretch bg-border" />
            <div className="flex items-center gap-1.5 pl-1 text-[10px] text-fg-muted">
              <span>{t("graphSession.canvas.execution")}</span>
              <Select
                aria-label={t("graphSession.canvas.graphExecutionMode")}
                className="w-28"
                value={value.definition.execution_mode ?? "parallel"}
                onValueChange={(executionMode) =>
                  updateExecutionMode(executionMode as WorkGraphExecutionMode)
                }
                options={[
                  { value: "parallel", label: t("graphSession.canvas.parallel") },
                  { value: "sequential", label: t("graphSession.canvas.sequential") },
                ]}
              />
            </div>
            <span className="mx-0.5 w-px self-stretch bg-border" />
            <Button
              size="xs"
              variant="ghost"
              disabled={!canAlign}
              aria-label={t("graphSession.canvas.alignXAria")}
              onClick={() => alignSelected("x")}
            >
              <MoveVertical size={11} /> {t("graphSession.canvas.alignX")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canAlign}
              aria-label={t("graphSession.canvas.alignYAria")}
              onClick={() => alignSelected("y")}
            >
              <MoveHorizontal size={11} /> {t("graphSession.canvas.alignY")}
            </Button>
          </div>
        ) : null}
        <ReactFlow<GraphFlowNode, GraphFlowEdge>
          data-testid="graph-canvas"
          nodes={flowNodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onInit={setFlowInstance}
          defaultViewport={viewport}
          minZoom={0.2}
          maxZoom={2.5}
          snapToGrid
          snapGrid={SNAP_GRID}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Horizontal}
          zoomOnScroll={false}
          selectionOnDrag={canEdit}
          nodesDraggable={canEdit}
          nodesConnectable={canEdit}
          elementsSelectable
          onNodesChange={handleNodesChange}
          onSelectionChange={({ nodes }) => {
            const ids = nodes.map((node) => node.id);
            setSelectedNodeIds((current) =>
              current.length === ids.length &&
              current.every((id, index) => id === ids[index])
                ? current
                : ids,
            );
            setSelectedNodeId((current) =>
              current && ids.includes(current)
                ? current
                : (ids[ids.length - 1] ?? null),
            );
          }}
          onNodeClick={(_, node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
            setSelectedNodeIds([]);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedNodeIds([]);
            setSelectedEdgeId(null);
          }}
          onNodeDragStop={(_, node) => persistPosition(node)}
          onNodesDelete={(deleted) => removeElements(deleted.map((node) => node.id))}
          onEdgesDelete={(deleted) => removeEdges(deleted.map((edge) => edge.id))}
          onConnect={connect}
          isValidConnection={(connection) =>
            canEdit &&
            (connectionKind === "retry"
              ? connectGraphNodes(
                  latestValueRef.current.definition,
                  connection.source,
                  connection.target,
                  {
                    kind: "retry",
                    condition:
                      latestValueRef.current.definition.nodes.find(
                        (node) => node.id === connection.source,
                      )?.kind === "human"
                        ? "rejected"
                        : "fail",
                    retry_limit: 2,
                  },
                ) !== null
              : validateProspectiveGraphEdge(
                  latestValueRef.current.definition,
                  connection.source,
                  connection.target,
                ) === null)
          }
          onMoveEnd={(_, nextViewport: Viewport) => {
            const current = latestValueRef.current;
            latestOnChangeRef.current({
              ...current,
              canvas: { ...current.canvas, viewport: nextViewport },
            });
          }}
          deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={canEdit} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => {
              if (node.type === "workGraphGroup") return "var(--color-accent)";
              return (node.data as GraphNodeData).kind === "goal_sink"
                ? "var(--color-accent)"
                : "var(--color-fg-muted)";
            }}
            maskColor="color-mix(in oklab, var(--color-bg) 78%, transparent)"
          />
        </ReactFlow>
      </div>

      <aside className="min-h-0 overflow-y-auto bg-bg-sidebar/55 p-3">
        {selectedNode && selectedNode.kind !== "goal_sink" ? (
          <section className="rounded-lg border border-border bg-bg-elevated p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-fg-muted">
                  {selectedNode.id}
                </div>
                <div className="text-xs font-semibold text-fg">
                  {t("graphSession.nodeInspector")}
                </div>
              </div>
              <Button
                size="xs"
                variant="dangerGhost"
                disabled={!canEdit || !savedNode}
                aria-label={`${t("chat.graphEditor.removeNode")} ${selectedNode.id}`}
                onClick={() => removeElements([selectedNode.id])}
              >
                <Trash2 size={12} />
              </Button>
            </div>
            {runState?.nodes[selectedNode.id]?.status ? (
              <div className="mb-3 flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1.5 text-[10px] text-fg-muted">
                <StatusMark status={runState.nodes[selectedNode.id].status} />
                {t(STATUS_LABEL_KEYS[runState.nodes[selectedNode.id].status])}
              </div>
            ) : null}
            {canEdit && savedNode ? (
              <>
                <Field label={t("graphSession.canvas.promptPreset")}>
                  <Select
                    value={selectedPromptPreset}
                    onValueChange={(presetId) => {
                      const preset = BUILTIN_GRAPH_NODE_PROMPT_PRESETS.find(
                        (candidate) => candidate.id === presetId,
                      );
                      if (preset) {
                        updateNode({
                          kind: preset.kind,
                          title: preset.title,
                          instruction: preset.instruction,
                        });
                      }
                    }}
                    options={[
                      { value: "custom", label: t("graphSession.canvas.custom") },
                      ...BUILTIN_GRAPH_NODE_PROMPT_PRESETS.map((preset) => ({
                        value: preset.id,
                        label: t(
                          NODE_PROMPT_PRESET_NAME_KEYS[preset.id] ?? preset.name,
                        ),
                      })),
                    ]}
                  />
                </Field>
                <Field label={t("graphSession.kind")}>
                  <Select
                    value={selectedNode.kind}
                    onValueChange={(kind) =>
                      updateNode({ kind: kind as WorkGraphNodeKind })
                    }
                    options={EXECUTABLE_KINDS.map((kind) => ({
                      value: kind,
                      label: t(`chat.graphEditor.kinds.${kind}`),
                    }))}
                  />
                </Field>
                <Field label={t("chat.graphEditor.nodeTitle")}>
                  <input
                    value={selectedNode.title}
                    onChange={(event) => updateNode({ title: event.target.value })}
                    className="mt-1 w-full rounded-md border border-input-border bg-input px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
                  />
                </Field>
                <Field label={t("chat.graphEditor.instruction")}>
                  <textarea
                    value={selectedNode.instruction}
                    placeholder={t("graphSession.instructionPlaceholder")}
                    onChange={(event) =>
                      updateNode({ instruction: event.target.value })
                    }
                    className="mt-1 min-h-28 w-full resize-y rounded-md border border-input-border bg-input px-2.5 py-2 text-xs leading-5 text-fg outline-none focus:border-accent"
                  />
                </Field>
              </>
            ) : (
              <div className="text-[10px] leading-4 text-fg-muted">
                {runState?.nodes[selectedNode.id]?.question ||
                  runState?.nodes[selectedNode.id]?.output ||
                  runState?.nodes[selectedNode.id]?.error ||
                  selectedNode.instruction}
              </div>
            )}
          </section>
        ) : selectedGroup ? (
          <section className="rounded-lg border border-border bg-bg-elevated p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-fg-muted">
                  {selectedGroup.id}
                </div>
                <div className="text-xs font-semibold text-fg">
                  {t("graphSession.canvas.groupInspector")}
                </div>
              </div>
              <Button
                size="xs"
                variant="dangerGhost"
                disabled={!canEdit || !savedGroup}
                aria-label={`${t("graphSession.canvas.removeGroup")} ${selectedGroup.id}`}
                onClick={() => removeElements([selectedGroup.id])}
              >
                <Trash2 size={12} />
              </Button>
            </div>
            {canEdit && savedGroup ? (
              <>
                <Field label={t("graphSession.canvas.title")}>
                  <input
                    value={selectedGroup.title}
                    onChange={(event) => updateGroup({ title: event.target.value })}
                    className="mt-1 w-full rounded-md border border-input-border bg-input px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
                  />
                </Field>
                <Field label={t("graphSession.canvas.generation")}>
                  <Select
                    value={selectedGroup.generation.mode}
                    onValueChange={(generationMode) =>
                      updateGroupGenerationMode(
                        generationMode as WorkGraphGroup["generation"]["mode"],
                      )
                    }
                    options={[
                      { value: "fixed", label: t("graphSession.canvas.fixedCount") },
                      { value: "prompt", label: t("graphSession.canvas.promptGenerated") },
                    ]}
                  />
                </Field>
                <Field label={t("graphSession.canvas.layout")}>
                  <Select
                    value={selectedGroup.direction}
                    onValueChange={(direction) =>
                      updateGroupDirection(direction as WorkGraphGroup["direction"])
                    }
                    options={[
                      { value: "LR", label: t("graphSession.canvas.horizontal") },
                      { value: "TD", label: t("graphSession.canvas.vertical") },
                    ]}
                  />
                </Field>
                {selectedGroup.generation.mode === "fixed" ? (
                  <Field label={t("graphSession.canvas.nodeCount")}>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={selectedGroup.generation.count ?? 1}
                      onChange={(event) => resizeGroup(Number(event.target.value))}
                      className="mt-1 h-8 w-full rounded-md border border-input-border bg-input px-2.5 text-xs text-fg outline-none focus:border-accent"
                    />
                  </Field>
                ) : (
                  <>
                    <Field label={t("graphSession.canvas.generationPrompt")}>
                      <textarea
                        value={selectedGroup.generation.prompt ?? ""}
                        placeholder={t("graphSession.canvas.generationPromptPlaceholder")}
                        onChange={(event) =>
                          updateGroup({
                            generation: { prompt: event.target.value },
                          })
                        }
                        className="mt-1 min-h-28 w-full resize-y rounded-md border border-input-border bg-input px-2.5 py-2 text-xs leading-5 text-fg outline-none focus:border-accent"
                      />
                    </Field>
                    <Field label={t("graphSession.canvas.safeNodeLimit")}>
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={selectedGroup.generation.max_nodes ?? 12}
                        onChange={(event) =>
                          updateGroup({
                            generation: {
                              max_nodes: Math.max(
                                1,
                                Math.min(12, Number(event.target.value) || 1),
                              ),
                            },
                          })
                        }
                        className="mt-1 h-8 w-full rounded-md border border-input-border bg-input px-2.5 text-xs text-fg outline-none focus:border-accent"
                      />
                    </Field>
                  </>
                )}
              </>
            ) : (
              <div className="text-[10px] text-fg-muted">
                {selectedGroup.generation.mode === "fixed"
                  ? t("graphSession.canvas.fixedCount")
                  : t("graphSession.canvas.promptGenerated")} ·{" "}
                {selectedGroup.generation.count ?? t("graphSession.canvas.auto")} {t("graphSession.canvas.nodes")}
              </div>
            )}
          </section>
        ) : selectedEdge ? (
          <section className="rounded-lg border border-border bg-bg-elevated p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-fg-muted">
                  {selectedEdge.id}
                </div>
                <div className="text-xs font-semibold text-fg">
                  {t("graphSession.canvas.edgeInspector")}
                </div>
              </div>
              <Button
                size="xs"
                variant="dangerGhost"
                disabled={!canEdit || !savedEdge}
                aria-label={`${t("chat.graphEditor.removeEdge")} ${selectedEdge.id}`}
                onClick={() => removeEdges([selectedEdge.id])}
              >
                <Trash2 size={12} />
              </Button>
            </div>
            {canEdit && savedEdge ? (
              <>
                <Field label={t("graphSession.canvas.edgeLabel")}>
                  <input
                    value={selectedEdge.label ?? ""}
                    onChange={(event) => updateEdge({ label: event.target.value || null })}
                    className="mt-1 w-full rounded-md border border-input-border bg-input px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
                  />
                </Field>
                <Field label={t("graphSession.canvas.edgeKind")}>
                  <Select
                    value={selectedEdge.kind ?? "dependency"}
                    onValueChange={(kind) =>
                      updateEdge({
                        kind: kind as WorkGraphEdgeKind,
                        condition:
                          kind === "retry"
                            ? selectedRetryCondition
                            : selectedEdge.condition,
                        retry_limit: kind === "retry" ? (selectedEdge.retry_limit ?? 2) : null,
                      })
                    }
                    options={[
                      { value: "dependency", label: t("graphSession.canvas.dependency") },
                      { value: "retry", label: t("graphSession.canvas.retry") },
                    ]}
                  />
                </Field>
                <Field label={t("graphSession.canvas.condition")}>
                  <Select
                    value={selectedEdge.condition ?? "always"}
                    onValueChange={(condition) =>
                      updateEdge({ condition: condition as WorkGraphEdgeCondition })
                    }
                    options={selectedEdgeConditionOptions.map((condition) => ({
                      value: condition,
                      label: t(`graphSession.canvas.conditions.${condition}`),
                    }))}
                  />
                </Field>
                {(selectedEdge.kind ?? "dependency") === "retry" ? (
                  <Field label={t("graphSession.canvas.retryLimit")}>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={selectedEdge.retry_limit ?? 2}
                      onChange={(event) =>
                        updateEdge({
                          retry_limit: Math.max(
                            1,
                            Math.min(10, Number(event.target.value) || 1),
                          ),
                        })
                      }
                      className="mt-1 h-8 w-full rounded-md border border-input-border bg-input px-2.5 text-xs text-fg outline-none focus:border-accent"
                    />
                  </Field>
                ) : null}
              </>
            ) : (
              <div className="text-[10px] text-fg-muted">
                {selectedEdge.from} → {selectedEdge.to}
              </div>
            )}
          </section>
        ) : (
          <div className="rounded-lg border border-border bg-bg-elevated/60 p-4 text-center text-xs text-fg-muted">
            <Hand className="mx-auto mb-2" size={18} />
            {t("graphSession.selectNodeHelp")}
          </div>
        )}

        {connectionError ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger"
          >
            {t(CONNECTION_ERROR_KEYS[connectionError])}
          </div>
        ) : null}

        <div
          role="status"
          className={cn(
            "mt-3 rounded-lg border p-3 text-xs",
            validation.valid
              ? "border-accent/30 bg-accent/5 text-accent"
              : "border-danger/30 bg-danger/5 text-danger",
          )}
        >
          <div className="flex items-center gap-2 font-semibold">
            {validation.valid ? <CircleCheck size={14} /> : <Waypoints size={14} />}
            {validation.valid
              ? t("chat.graphEditor.valid")
              : t("chat.graphEditor.invalid")}
          </div>
          {!validation.valid ? (
            <div className="mt-2 text-[10px] leading-4">
              {t("chat.graphEditor.invalidHelp")}
            </div>
          ) : null}
        </div>

        <h3 className="mt-4 text-xs font-semibold text-fg">
          {t("chat.graphEditor.mermaidPreview")}
        </h3>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg px-3 py-3 font-mono text-[9px] leading-4 text-fg-muted">
          {mermaid ?? t("chat.graphEditor.previewUnavailable")}
        </pre>
      </aside>
    </div>
  );
}
