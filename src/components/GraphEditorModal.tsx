import { CircleCheck, GitBranch, Plus, Trash2, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDialogShortcuts } from "../lib/dialog";
import { useTranslation } from "../lib/useTranslation";
import {
  AUTOMATIC_GRAPH_PROMPT_PLAN,
  GRAPH_PROMPT_PLAN_VERSION,
  WORK_GRAPH_GOAL_ID,
  createEmptyWorkGraph,
  serializeWorkGraphToMermaid,
  validateWorkGraph,
  type GraphPromptPlan,
  type WorkGraph,
  type WorkGraphNode,
  type WorkGraphNodeKind,
} from "../lib/workGraph";
import {
  Button,
  Field,
  Modal,
  ModalFooter,
  ModalHeader,
  Select,
  TextInput,
} from "./ui";

interface GraphEditorModalProps {
  open: boolean;
  plan: GraphPromptPlan;
  onClose: () => void;
  onApply: (plan: GraphPromptPlan) => void;
}

const EXECUTABLE_KINDS: WorkGraphNodeKind[] = [
  "agent",
  "validator",
  "merge",
  "human",
];

function cloneGraph(graph: WorkGraph): WorkGraph {
  return {
    version: graph.version,
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function nextStableId(prefix: string, taken: Set<string>): string {
  let index = 1;
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function GraphEditorModal({
  open,
  plan,
  onClose,
  onApply,
}: GraphEditorModalProps) {
  const t = useTranslation();
  const [mode, setMode] = useState<"automatic" | "manual">(plan.mode);
  const [graph, setGraph] = useState<WorkGraph>(() =>
    plan.mode === "manual" ? cloneGraph(plan.graph) : createEmptyWorkGraph(),
  );
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState<string>(WORK_GRAPH_GOAL_ID);

  useEffect(() => {
    if (!open) return;
    setMode(plan.mode);
    setGraph(
      plan.mode === "manual" ? cloneGraph(plan.graph) : createEmptyWorkGraph(),
    );
    setEdgeFrom("");
    setEdgeTo(WORK_GRAPH_GOAL_ID);
  }, [open, plan]);

  const validation = useMemo(() => validateWorkGraph(graph), [graph]);
  const mermaid = useMemo(() => {
    if (!validation.valid) return null;
    return serializeWorkGraphToMermaid(graph);
  }, [graph, validation.valid]);
  const canApply = mode === "automatic" || validation.valid;
  const executableNodes = graph.nodes.filter(
    (node) => node.kind !== "goal_sink",
  );

  function applyPlan() {
    if (!canApply) return;
    onApply(
      mode === "automatic"
        ? AUTOMATIC_GRAPH_PROMPT_PLAN
        : {
            version: GRAPH_PROMPT_PLAN_VERSION,
            mode: "manual",
            graph: cloneGraph(graph),
          },
    );
  }

  useDialogShortcuts(open, {
    onCancel: onClose,
    onConfirm: applyPlan,
  });

  function kindLabel(kind: WorkGraphNodeKind): string {
    switch (kind) {
      case "agent":
        return t("chat.graphEditor.kinds.agent");
      case "validator":
        return t("chat.graphEditor.kinds.validator");
      case "merge":
        return t("chat.graphEditor.kinds.merge");
      case "human":
        return t("chat.graphEditor.kinds.human");
      case "goal_sink":
        return "GOAL";
    }
  }

  function addNode(kind: WorkGraphNodeKind) {
    const taken = new Set(graph.nodes.map((node) => node.id));
    const id = nextStableId(kind, taken);
    setGraph((current) => ({
      ...current,
      nodes: [
        ...current.nodes.filter((node) => node.kind !== "goal_sink"),
        { id, kind, title: "", instruction: "" },
        current.nodes.find((node) => node.kind === "goal_sink")!,
      ],
    }));
    setEdgeFrom((current) => current || id);
  }

  function updateNode(
    originalNode: WorkGraphNode,
    patch: Partial<{ id: string; title: string; instruction: string }>,
  ) {
    const originalId = originalNode.id;
    const nextId = patch.id ?? originalId;
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node === originalNode ? { ...node, ...patch } : node,
      ),
      edges: current.edges.map((edge) => ({
        ...edge,
        from: edge.from === originalId ? nextId : edge.from,
        to: edge.to === originalId ? nextId : edge.to,
      })),
    }));
    setEdgeFrom((current) => (current === originalId ? nextId : current));
    setEdgeTo((current) => (current === originalId ? nextId : current));
  }

  function removeNode(nodeToRemove: WorkGraphNode) {
    const id = nodeToRemove.id;
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node !== nodeToRemove),
      edges: current.edges.filter(
        (edge) => edge.from !== id && edge.to !== id,
      ),
    }));
    if (edgeFrom === id) setEdgeFrom("");
    if (edgeTo === id) setEdgeTo(WORK_GRAPH_GOAL_ID);
  }

  function addEdge() {
    if (!edgeFrom || !edgeTo) return;
    const taken = new Set(graph.edges.map((edge) => edge.id));
    setGraph((current) => ({
      ...current,
      edges: [
        ...current.edges,
        {
          id: nextStableId("edge", taken),
          from: edgeFrom,
          to: edgeTo,
        },
      ],
    }));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="5xl"
      ariaLabel={t("chat.graphEditor.title")}
    >
      <ModalHeader
        title={t("chat.graphEditor.title")}
        subtitle={t("chat.graphEditor.subtitle")}
        icon={<Waypoints size={15} className="text-accent" />}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 gap-2 border-b border-border px-4 py-3">
          <Button
            aria-pressed={mode === "automatic"}
            variant={mode === "automatic" ? "accentSoft" : "outline"}
            onClick={() => setMode("automatic")}
          >
            {t("chat.graphEditor.automatic")}
          </Button>
          <Button
            aria-pressed={mode === "manual"}
            variant={mode === "manual" ? "accentSoft" : "outline"}
            onClick={() => setMode("manual")}
          >
            {t("chat.graphEditor.manual")}
          </Button>
        </div>

        {mode === "automatic" ? (
          <div className="grid flex-1 place-items-center overflow-auto p-8">
            <div className="max-w-xl rounded-xl border border-accent/25 bg-accent/5 p-6 text-center">
              <Waypoints className="mx-auto mb-3 text-accent" size={28} />
              <h3 className="text-sm font-semibold text-fg">
                {t("chat.graphEditor.autoTitle")}
              </h3>
              <p className="mt-2 text-xs leading-5 text-fg-muted">
                {t("chat.graphEditor.autoDescription")}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <div className="min-h-0 overflow-auto border-r border-border p-4">
              <section aria-labelledby="graph-nodes-heading">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="graph-nodes-heading" className="text-xs font-semibold text-fg">
                    {t("chat.graphEditor.nodes")}
                  </h3>
                  <div className="flex flex-wrap gap-1">
                    {EXECUTABLE_KINDS.map((kind) => (
                      <Button
                        key={kind}
                        size="xs"
                        variant="outline"
                        onClick={() => addNode(kind)}
                      >
                        <Plus size={11} />
                        {kindLabel(kind)}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {executableNodes.map((node, index) => (
                    <article
                      key={`${node.kind}:${index}`}
                      className="rounded-lg border border-border bg-bg-elevated p-3"
                      data-work-graph-node={node.id}
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <span className="rounded bg-accent/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
                          {kindLabel(node.kind)}
                        </span>
                        <Button
                          size="xs"
                          variant="dangerGhost"
                          aria-label={`${t("chat.graphEditor.removeNode")} ${node.id}`}
                          onClick={() => removeNode(node)}
                        >
                          <Trash2 size={11} />
                          {t("chat.graphEditor.remove")}
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t("chat.graphEditor.nodeId")}>
                          <TextInput
                            aria-label={`${node.id} ${t("chat.graphEditor.nodeId")}`}
                            value={node.id}
                            onChange={(event) =>
                              updateNode(node, { id: event.target.value })
                            }
                          />
                        </Field>
                        <Field label={t("chat.graphEditor.nodeTitle")}>
                          <TextInput
                            aria-label={`${node.id} ${t("chat.graphEditor.nodeTitle")}`}
                            value={node.title}
                            onChange={(event) =>
                              updateNode(node, { title: event.target.value })
                            }
                          />
                        </Field>
                      </div>
                      <Field label={t("chat.graphEditor.instruction")}>
                        <textarea
                          aria-label={`${node.id} ${t("chat.graphEditor.instruction")}`}
                          className="mt-1 min-h-20 w-full resize-y rounded-lg border border-input-border bg-input px-2.5 py-2 text-xs leading-5 text-fg outline-none focus:border-accent focus:bg-input-hover"
                          value={node.instruction}
                          onChange={(event) =>
                            updateNode(node, {
                              instruction: event.target.value,
                            })
                          }
                        />
                      </Field>
                    </article>
                  ))}
                  <article className="rounded-lg border border-accent/35 bg-accent/5 p-3" data-work-graph-node="goal">
                    <div className="flex items-center gap-3">
                      <span className="grid size-8 place-items-center rounded-full border border-accent/40 bg-accent/10 text-[11px] font-bold text-accent">
                        GOAL
                      </span>
                      <div>
                        <div className="text-xs font-semibold text-fg">GOAL</div>
                        <div className="text-[11px] text-fg-muted">
                          {t("chat.graphEditor.goalDescription")}
                        </div>
                      </div>
                    </div>
                  </article>
                </div>
              </section>

              <section className="mt-5" aria-labelledby="graph-edges-heading">
                <h3 id="graph-edges-heading" className="text-xs font-semibold text-fg">
                  {t("chat.graphEditor.edges")}
                </h3>
                <div className="mt-2 grid grid-cols-[1fr_auto_1fr_auto] items-end gap-2 rounded-lg border border-border bg-bg-sidebar/45 p-3">
                  <Field label={t("chat.graphEditor.from")}>
                    <Select
                      aria-label={t("chat.graphEditor.from")}
                      value={edgeFrom}
                      onValueChange={setEdgeFrom}
                      options={executableNodes.map((node) => ({
                        value: node.id,
                        label: node.id,
                      }))}
                    />
                  </Field>
                  <GitBranch className="mb-2 text-fg-muted" size={14} />
                  <Field label={t("chat.graphEditor.to")}>
                    <Select
                      aria-label={t("chat.graphEditor.to")}
                      value={edgeTo}
                      onValueChange={setEdgeTo}
                      options={graph.nodes.map((node) => ({
                        value: node.id,
                        label: node.kind === "goal_sink" ? "GOAL" : node.id,
                      }))}
                    />
                  </Field>
                  <Button
                    variant="accentSoft"
                    disabled={!edgeFrom || !edgeTo}
                    onClick={addEdge}
                  >
                    <Plus size={12} />
                    {t("chat.graphEditor.addEdge")}
                  </Button>
                </div>
                <div className="mt-2 space-y-1">
                  {graph.edges.map((edge) => (
                    <div
                      key={edge.id}
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-[11px]"
                    >
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {edge.from} → {edge.to === WORK_GRAPH_GOAL_ID ? "GOAL" : edge.to}
                      </span>
                      <button
                        type="button"
                        aria-label={`${t("chat.graphEditor.removeEdge")} ${edge.from} ${edge.to}`}
                        className="text-fg-muted transition hover:text-danger"
                        onClick={() =>
                          setGraph((current) => ({
                            ...current,
                            edges: current.edges.filter(
                              (candidate) => candidate.id !== edge.id,
                            ),
                          }))
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <aside className="min-h-0 overflow-auto bg-bg-sidebar/35 p-4">
              <div
                role="status"
                className={`rounded-lg border p-3 text-xs ${
                  validation.valid
                    ? "border-success/30 bg-success/5 text-success"
                    : "border-danger/30 bg-danger/5 text-danger"
                }`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {validation.valid ? <CircleCheck size={14} /> : <Waypoints size={14} />}
                  {validation.valid
                    ? t("chat.graphEditor.valid")
                    : t("chat.graphEditor.invalid")}
                </div>
                {!validation.valid ? (
                  <>
                    <p className="mt-1 text-[11px] leading-4 opacity-90">
                      {t("chat.graphEditor.invalidHelp")}
                    </p>
                    <ul
                      aria-label={t("chat.graphEditor.validationErrors")}
                      className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-4"
                    >
                      {validation.errors.slice(0, 4).map((error, index) => (
                        <li key={`${index}:${error}`}>{error}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
              <h3 className="mt-4 text-xs font-semibold text-fg">
                {t("chat.graphEditor.mermaidPreview")}
              </h3>
              <pre className="mt-2 min-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg px-3 py-3 font-mono text-[10px] leading-4 text-fg-muted">
                {mermaid ?? t("chat.graphEditor.previewUnavailable")}
              </pre>
            </aside>
          </div>
        )}
      </div>
      <ModalFooter>
        <Button onClick={onClose}>{t("chat.graphEditor.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!canApply}
          onClick={applyPlan}
        >
          {t("chat.graphEditor.apply")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
