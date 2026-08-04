import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CircleStop, Play, Save, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { cloneSessionGraph } from "../lib/graphSession";
import {
  GRAPH_RUN_STATE_CHANGED_EVENT,
  applyGraphRunState,
  cancelSavedGraphRun,
  runSavedGraphSession,
  selectLatestGraphRunState,
  subscribeGraphRunState,
  submitSavedGraphNodeInput,
  type GraphRunStateChangedPayload,
} from "../lib/graphSessionRun";
import type {
  GraphNodeVerdict,
  GraphRunState,
  Session,
  SessionGraph,
} from "../lib/types";
import { validateWorkGraph } from "../lib/workGraph";
import { useAppStore } from "../store";
import { useTranslation } from "../lib/useTranslation";
import { GraphCanvasEditor, type GraphCanvasValue } from "./GraphCanvasEditor";
import { GraphPresetToolbar } from "./GraphPresetToolbar";
import { Button } from "./ui";

interface GraphSessionViewProps {
  session: Session;
  isActive: boolean;
}

function graphRunIsActive(state: GraphRunState | null): boolean {
  return state?.status === "running" || state?.status === "waiting";
}

export function GraphSessionView({ session, isActive }: GraphSessionViewProps) {
  const t = useTranslation();
  const graph = session.graph;
  const [view, setView] = useState<"design" | "run">("design");
  const [draft, setDraft] = useState<SessionGraph | null>(() =>
    graph ? cloneSessionGraph(graph) : null,
  );
  const [runState, setRunState] = useState<GraphRunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRunStateRef = useRef<GraphRunState | null>(null);

  useEffect(() => {
    if (graph) setDraft(cloneSessionGraph(graph));
  }, [session.id, graph?.revision]);

  useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    latestRunStateRef.current = null;
    setRunState(null);

    const receive = (state: GraphRunState) => {
      if (disposed || state.session_id !== session.id) return;
      const latest = selectLatestGraphRunState(latestRunStateRef.current, state);
      if (latest !== state) return;
      latestRunStateRef.current = state;
      setRunState(state);
      setView("run");
      if (state.status === "running" || state.status === "waiting") {
        setBusy(false);
      }
    };
    const unsubscribeState = subscribeGraphRunState(session.id, receive);

    void (async () => {
      try {
        const cancel = await listen<GraphRunStateChangedPayload>(
          GRAPH_RUN_STATE_CHANGED_EVENT,
          (event) => applyGraphRunState(event.payload.state),
        );
        if (disposed) {
          cancel();
          return;
        }
        unlisten = cancel;
      } catch (listenError) {
        if (!disposed) setError(String(listenError));
      }
      if (disposed) return;
      try {
        const loaded = await api.loadGraphRunState(session.id);
        if (loaded) applyGraphRunState(loaded);
      } catch (loadError) {
        if (!disposed) setError(String(loadError));
      }
    })();

    return () => {
      disposed = true;
      unsubscribeState();
      unlisten?.();
    };
  }, [isActive, session.id]);

  const validation = useMemo(
    () => (draft ? validateWorkGraph(draft.definition) : { valid: false, errors: [] }),
    [draft],
  );
  if (!graph || !draft) return null;
  const savedGraph = graph;
  const currentDraft = draft;
  const activeRun = runState
    ? graphRunIsActive(runState)
    : session.status === "working" || session.status === "waiting_for_input";
  const editable = view === "design" && !activeRun && !busy;
  const dirty = JSON.stringify(currentDraft) !== JSON.stringify(savedGraph);

  function updateCanvas(value: GraphCanvasValue) {
    setDraft((current) =>
      current
        ? { ...current, definition: value.definition, canvas: value.canvas }
        : current,
    );
  }

  async function save(): Promise<SessionGraph> {
    if (!validation.valid || !currentDraft.objective.trim()) {
      throw new Error(t("graphSession.invalidRun"));
    }
    if (!dirty) return savedGraph;
    const next = cloneSessionGraph({
      ...currentDraft,
      objective: currentDraft.objective.trim(),
    });
    const updated = await api.updateSessionGraph(session.id, savedGraph.revision, next);
    if (!updated.graph) throw new Error(t("graphSession.updateMissing"));
    setDraft(cloneSessionGraph(updated.graph));
    await useAppStore.getState().refreshSessions();
    return updated.graph;
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await save();
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function handleRun() {
    setBusy(true);
    setError(null);
    try {
      await save();
      setView("run");
      await runSavedGraphSession(session.id);
    } catch (runError) {
      setError(String(runError));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!runState || !graphRunIsActive(runState)) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelSavedGraphRun(runState);
    } catch (cancelError) {
      setError(String(cancelError));
    } finally {
      setCancelling(false);
    }
  }

  async function handleHumanInput(
    nodeId: string,
    input: string,
    verdict?: GraphNodeVerdict,
  ) {
    if (!runState || runState.status !== "waiting") return;
    const waitingState = runState;
    setError(null);
    setRunState({
      ...waitingState,
      status: "running",
      nodes: {
        ...waitingState.nodes,
        [nodeId]: {
          ...waitingState.nodes[nodeId],
          status: "working",
          question: null,
        },
      },
    });
    try {
      await submitSavedGraphNodeInput(waitingState, nodeId, input, verdict);
    } catch (inputError) {
      setRunState(waitingState);
      setError(String(inputError));
      throw inputError;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-graph-session-view>
      <header className="shrink-0 border-b border-border bg-bg-sidebar/55 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
            <Waypoints size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              <span>{t("graphSession.label")}</span>
              <span>{t("graphSession.revision")} {savedGraph.revision}</span>
              <span className="rounded bg-fill px-1.5 py-0.5 normal-case">
                {runState
                  ? t(`graphSession.runStatuses.${runState.status}`)
                  : t(`sidebar.status.${session.status}`)}
              </span>
            </div>
            {view === "design" && editable ? (
              <input
                aria-label={t("graphSession.objective")}
                value={currentDraft.objective}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, objective: event.target.value } : current,
                  )
                }
                className="mt-0.5 w-full border-0 bg-transparent p-0 text-xs font-medium text-fg outline-none"
              />
            ) : (
              <div className="mt-0.5 truncate text-xs font-medium text-fg" title={savedGraph.objective}>
                {savedGraph.objective}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg p-1">
            <Button
              size="xs"
              variant={view === "design" ? "accentSoft" : "ghost"}
              onClick={() => setView("design")}
            >
              <Waypoints size={12} /> {t("graphSession.design")}
            </Button>
            <Button
              size="xs"
              variant={view === "run" ? "accentSoft" : "ghost"}
              onClick={() => setView("run")}
            >
              <Play size={12} /> {t("graphSession.liveRun")}
            </Button>
          </div>
          <span className="text-[11px] text-fg-muted">{savedGraph.agent.provider}</span>
          {activeRun && runState ? (
            <Button
              size="xs"
              variant="outline"
              disabled={cancelling}
              onClick={() => void handleCancel()}
            >
              <CircleStop size={12} /> {t("graphSession.cancelRun")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={!editable || !dirty || !validation.valid || !currentDraft.objective.trim()}
            onClick={() => void handleSave()}
          >
            <Save size={12} /> {t("graphSession.save")}
          </Button>
          <Button
            size="xs"
            variant="primary"
            disabled={activeRun || busy || !validation.valid || !currentDraft.objective.trim()}
            onClick={() => void handleRun()}
          >
            <Play size={12} /> {busy ? t("graphSession.starting") : t("graphSession.run")}
          </Button>
        </div>
        {activeRun ? (
          <div className="mt-2 text-[10px] text-warning">
            {t("graphSession.lockNotice")}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="mt-2 text-[11px] text-danger">{error}</div>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {view === "design" ? (
          <GraphPresetToolbar
            graph={currentDraft}
            disabled={!editable}
            onApply={(next) => setDraft(cloneSessionGraph(next))}
          />
        ) : (
          <div
            className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border bg-bg-sidebar/45 px-3 text-[10px] text-fg-muted"
            data-graph-run-summary
          >
            {runState ? (
              <>
                <span className="font-semibold text-fg">
                  {t(`graphSession.runStatuses.${runState.status}`)}
                </span>
                <span>{runState.run_id}</span>
                {runState.error ? <span className="text-danger">{runState.error}</span> : null}
                {runState.final_output ? (
                  <span className="min-w-0 flex-1 truncate text-right" title={runState.final_output}>
                    {runState.final_output}
                  </span>
                ) : null}
              </>
            ) : (
              <span>{t("graphSession.noRun")}</span>
            )}
          </div>
        )}
        <GraphCanvasEditor
          key={session.id}
          className="flex-1"
          value={{
            definition:
              view === "run" && runState
                ? runState.definition
                : currentDraft.definition,
            canvas: currentDraft.canvas,
          }}
          onChange={updateCanvas}
          disabled={view !== "design" || !editable}
          mode={view === "run" ? "run" : "edit"}
          runState={view === "run" ? runState : null}
          onHumanInput={handleHumanInput}
        />
      </div>
    </div>
  );
}
