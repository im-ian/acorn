import { ListTree, Play, Save, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { cloneSessionGraph } from "../lib/graphSession";
import { runSavedGraphSession } from "../lib/graphSessionRun";
import type { Session, SessionGraph } from "../lib/types";
import { validateWorkGraph } from "../lib/workGraph";
import { useAppStore } from "../store";
import { useTranslation } from "../lib/useTranslation";
import { ChatPane } from "./ChatPane";
import { GraphCanvasEditor, type GraphCanvasValue } from "./GraphCanvasEditor";
import { Button } from "./ui";

interface GraphSessionViewProps {
  session: Session;
  isActive: boolean;
}

export function GraphSessionView({ session, isActive }: GraphSessionViewProps) {
  const t = useTranslation();
  const graph = session.graph;
  const [tab, setTab] = useState<"design" | "log">("design");
  const [draft, setDraft] = useState<SessionGraph | null>(() =>
    graph ? cloneSessionGraph(graph) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (graph) setDraft(cloneSessionGraph(graph));
  }, [session.id, graph?.revision]);

  useEffect(() => {
    if (session.status === "working" || session.status === "waiting_for_input") {
      setTab("log");
    }
  }, [session.status]);

  const validation = useMemo(
    () => (draft ? validateWorkGraph(draft.definition) : { valid: false, errors: [] }),
    [draft],
  );
  if (!graph || !draft) return null;
  const savedGraph = graph;
  const currentDraft = draft;

  const activeRun =
    session.status === "working" || session.status === "waiting_for_input";
  const editable = !activeRun && !busy;
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
      setTab("log");
      void runSavedGraphSession(session.id)
        .catch((runError) => {
          console.error("run Graph session failed", runError);
          setError(String(runError));
        })
        .finally(() => setBusy(false));
    } catch (runError) {
      setError(String(runError));
      setBusy(false);
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
                {t(`sidebar.status.${session.status}`)}
              </span>
            </div>
            {tab === "design" && editable ? (
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
              variant={tab === "design" ? "accentSoft" : "ghost"}
              onClick={() => setTab("design")}
            >
              <Waypoints size={12} /> {t("graphSession.design")}
            </Button>
            <Button
              size="xs"
              variant={tab === "log" ? "accentSoft" : "ghost"}
              onClick={() => setTab("log")}
            >
              <ListTree size={12} /> {t("graphSession.runLog")}
            </Button>
          </div>
          <span className="text-[11px] text-fg-muted">{savedGraph.agent.provider}</span>
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
            disabled={!editable || !validation.valid || !currentDraft.objective.trim()}
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
      {tab === "design" ? (
        <GraphCanvasEditor
          key={session.id}
          className="flex-1"
          value={{ definition: currentDraft.definition, canvas: currentDraft.canvas }}
          onChange={updateCanvas}
          disabled={!editable}
        />
      ) : (
        <ChatPane
          sessionId={session.id}
          isActive={isActive}
          repoPath={session.worktree_path}
          session={session}
        />
      )}
    </div>
  );
}
