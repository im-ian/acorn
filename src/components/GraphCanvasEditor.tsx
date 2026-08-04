import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import {
  CircleCheck,
  GitMerge,
  Hand,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addGraphNode,
  connectGraphNodes,
  type GraphConnectionError,
  validateProspectiveGraphEdge,
} from "../lib/graphSession";
import { cn } from "../lib/cn";
import { useTranslation } from "../lib/useTranslation";
import {
  serializeWorkGraphToMermaid,
  validateWorkGraph,
  type WorkGraphNodeKind,
} from "../lib/workGraph";
import type { SessionGraphCanvas } from "../lib/types";
import { Button, Field, Select } from "./ui";

const EXECUTABLE_KINDS = [
  "agent",
  "validator",
  "merge",
  "human",
] as const satisfies readonly WorkGraphNodeKind[];

type GraphNodeData = {
  id: string;
  kind: WorkGraphNodeKind;
  kindLabel: string;
  title: string;
  instruction: string;
  sourceHandleLabel: string;
  targetHandleLabel: string;
};

type GraphFlowNode = Node<GraphNodeData, "workGraph">;

export interface GraphCanvasValue {
  definition: import("../lib/workGraph").WorkGraph;
  canvas: SessionGraphCanvas;
}

interface GraphCanvasEditorProps {
  value: GraphCanvasValue;
  onChange: (value: GraphCanvasValue) => void;
  disabled?: boolean;
  className?: string;
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

function WorkGraphFlowNode({ data, selected }: NodeProps<GraphFlowNode>) {
  const isGoal = data.kind === "goal_sink";
  return (
    <div
      className={cn(
        "min-w-44 max-w-56 rounded-xl border bg-bg-elevated shadow-lg transition",
        isGoal ? "border-accent/60 bg-accent/10" : "border-border",
        selected && "ring-2 ring-accent/45",
      )}
      data-graph-node={data.id}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !border-2 !border-bg !bg-accent"
        aria-label={`${data.id} — ${data.targetHandleLabel}`}
      />
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <span className="text-accent">{kindIcon(data.kind)}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {isGoal ? "GOAL" : data.kindLabel}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <div className="truncate text-xs font-semibold text-fg">
          {isGoal ? "GOAL" : data.title || data.id}
        </div>
        {!isGoal ? (
          <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-fg-muted">
            {data.instruction}
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

const NODE_TYPES = { workGraph: WorkGraphFlowNode };

const CONNECTION_ERROR_KEYS = {
  missingEndpoint: "graphSession.connectionErrors.missingEndpoint",
  unknownNode: "graphSession.connectionErrors.unknownNode",
  selfConnection: "graphSession.connectionErrors.selfConnection",
  goalOutgoing: "graphSession.connectionErrors.goalOutgoing",
  duplicate: "graphSession.connectionErrors.duplicate",
  cycle: "graphSession.connectionErrors.cycle",
} as const satisfies Record<GraphConnectionError, string>;

export function GraphCanvasEditor({
  value,
  onChange,
  disabled = false,
  className,
}: GraphCanvasEditorProps) {
  const t = useTranslation();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectionError, setConnectionError] =
    useState<GraphConnectionError | null>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<GraphFlowNode> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const latestValueRef = useRef(value);
  const latestOnChangeRef = useRef(onChange);
  latestValueRef.current = value;
  latestOnChangeRef.current = onChange;

  const validation = useMemo(
    () => validateWorkGraph(value.definition),
    [value.definition],
  );
  const mermaid = useMemo(
    () =>
      validation.valid
        ? serializeWorkGraphToMermaid(value.definition)
        : null,
    [validation.valid, value.definition],
  );
  const selectedNode = value.definition.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const derivedNodes = useMemo<GraphFlowNode[]>(
    () =>
      value.definition.nodes.map((node, index) => ({
        id: node.id,
        type: "workGraph",
        position: value.canvas.node_positions[node.id] ?? {
          x: 80 + (index % 3) * 230,
          y: 80 + Math.floor(index / 3) * 160,
        },
        data: {
          ...node,
          kindLabel:
            node.kind === "goal_sink"
              ? "GOAL"
              : t(`chat.graphEditor.kinds.${node.kind}`),
          sourceHandleLabel: t("graphSession.sourceHandle"),
          targetHandleLabel: t("graphSession.targetHandle"),
        },
        selected: node.id === selectedNodeId,
        deletable: node.kind !== "goal_sink" && !disabled,
        draggable: !disabled,
        connectable: !disabled,
      })),
    [disabled, selectedNodeId, t, value.canvas.node_positions, value.definition.nodes],
  );
  const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>(derivedNodes);
  const nodeIdSignature = value.definition.nodes.map((node) => node.id).join("\0");

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

  const ensureGraphIsVisible = useCallback(async () => {
    const container = canvasRef.current;
    if (!flowInstance || !container || value.definition.nodes.length <= 1) return;
    const currentNodes = flowInstance.getNodes();
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
  }, [flowInstance, value.definition.nodes.length]);

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
  const edges = useMemo<Edge[]>(
    () =>
      value.definition.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        animated: false,
        deletable: !disabled,
        style: { stroke: "var(--color-accent)", strokeWidth: 1.6 },
      })),
    [disabled, value.definition.edges],
  );

  const updateNode = useCallback(
    (patch: Partial<{ kind: WorkGraphNodeKind; title: string; instruction: string }>) => {
      if (!selectedNode || selectedNode.kind === "goal_sink" || disabled) return;
      onChange({
        ...value,
        definition: {
          ...value.definition,
          nodes: value.definition.nodes.map((node) =>
            node.id === selectedNode.id ? { ...node, ...patch } : node,
          ),
        },
      });
    },
    [disabled, onChange, selectedNode, value],
  );

  function removeNodes(ids: readonly string[]) {
    if (disabled) return;
    const removable = new Set(
      value.definition.nodes
        .filter((node) => node.kind !== "goal_sink" && ids.includes(node.id))
        .map((node) => node.id),
    );
    if (removable.size === 0) return;
    const node_positions = { ...value.canvas.node_positions };
    for (const id of removable) delete node_positions[id];
    onChange({
      definition: {
        ...value.definition,
        nodes: value.definition.nodes.filter((node) => !removable.has(node.id)),
        edges: value.definition.edges.filter(
          (edge) => !removable.has(edge.from) && !removable.has(edge.to),
        ),
      },
      canvas: { ...value.canvas, node_positions },
    });
    if (selectedNodeId && removable.has(selectedNodeId)) setSelectedNodeId(null);
  }

  function addNode(kind: (typeof EXECUTABLE_KINDS)[number]) {
    if (disabled) return;
    const added = addGraphNode(value.definition, value.canvas, kind);
    onChange({ definition: added.graph, canvas: added.canvas });
    setSelectedNodeId(added.nodeId);
  }

  function connect(connection: Connection) {
    const next = connectGraphNodes(
      value.definition,
      connection.source,
      connection.target,
    );
    if (!next) {
      setConnectionError(
        validateProspectiveGraphEdge(
          value.definition,
          connection.source,
          connection.target,
        ),
      );
      return;
    }
    setConnectionError(null);
    onChange({ ...value, definition: next });
  }

  const viewport = value.canvas.viewport ?? { x: 0, y: 0, zoom: 1 };

  return (
    <div className={cn("grid min-h-0 grid-cols-[minmax(0,1fr)_19rem] overflow-hidden", className)}>
      <div ref={canvasRef} className="relative min-h-0 border-r border-border bg-bg">
        <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-1 rounded-lg border border-border bg-bg-elevated/95 p-1.5 shadow-lg">
          {EXECUTABLE_KINDS.map((kind) => (
            <Button
              key={kind}
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => addNode(kind)}
            >
              <Plus size={11} />
              {t(`chat.graphEditor.kinds.${kind}`)}
            </Button>
          ))}
        </div>
        <ReactFlow<GraphFlowNode>
          data-testid="graph-canvas"
          nodes={flowNodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onInit={setFlowInstance}
          defaultViewport={viewport}
          minZoom={0.2}
          maxZoom={2.5}
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          elementsSelectable
          onNodesChange={handleNodesChange}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onNodeDragStop={(_, node) => {
            const current = latestValueRef.current;
            latestOnChangeRef.current({
              ...current,
              canvas: {
                ...current.canvas,
                node_positions: {
                  ...current.canvas.node_positions,
                  [node.id]: { x: node.position.x, y: node.position.y },
                },
              },
            });
          }}
          onNodesDelete={(deleted) => removeNodes(deleted.map((node) => node.id))}
          onEdgesDelete={(deleted) =>
            !disabled &&
            onChange({
              ...value,
              definition: {
                ...value.definition,
                edges: value.definition.edges.filter(
                  (edge) => !deleted.some((candidate) => candidate.id === edge.id),
                ),
              },
            })
          }
          onConnect={connect}
          isValidConnection={(connection) =>
            validateProspectiveGraphEdge(
              value.definition,
              connection.source,
              connection.target,
            ) === null
          }
          onMoveEnd={(_, nextViewport: Viewport) =>
            onChange({
              ...value,
              canvas: { ...value.canvas, viewport: nextViewport },
            })
          }
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={!disabled} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) =>
              (node.data as GraphNodeData).kind === "goal_sink"
                ? "var(--color-accent)"
                : "var(--color-fg-muted)"
            }
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
                <div className="text-xs font-semibold text-fg">{t("graphSession.nodeInspector")}</div>
              </div>
              <Button
                size="xs"
                variant="dangerGhost"
                disabled={disabled}
                aria-label={`${t("chat.graphEditor.removeNode")} ${selectedNode.id}`}
                onClick={() => removeNodes([selectedNode.id])}
              >
                <Trash2 size={12} />
              </Button>
            </div>
            <Field label={t("graphSession.kind")}>
              <Select
                value={selectedNode.kind}
                disabled={disabled}
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
                disabled={disabled}
                onChange={(event) => updateNode({ title: event.target.value })}
                className="mt-1 w-full rounded-md border border-input-border bg-input px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
              />
            </Field>
            <Field label={t("chat.graphEditor.instruction")}>
              <textarea
                value={selectedNode.instruction}
                placeholder={t("graphSession.instructionPlaceholder")}
                disabled={disabled}
                onChange={(event) => updateNode({ instruction: event.target.value })}
                className="mt-1 min-h-28 w-full resize-y rounded-md border border-input-border bg-input px-2.5 py-2 text-xs leading-5 text-fg outline-none focus:border-accent"
              />
            </Field>
          </section>
        ) : (
          <div className="rounded-lg border border-border bg-bg-elevated/60 p-4 text-center text-xs text-fg-muted">
            <Hand className="mx-auto mb-2" size={18} />
            {t("graphSession.selectNodeHelp")}
          </div>
        )}

        {connectionError ? (
          <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger">
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
