import { Play, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isSessionAgentProvider } from "../lib/agentProvider";
import {
  cloneSessionGraph,
  createGraphSessionDraft,
} from "../lib/graphSession";
import { runSavedGraphSession } from "../lib/graphSessionRun";
import {
  applySessionCreateRequest,
  buildSessionCreateRequestFromScope,
  type SessionCreateScope,
} from "../lib/sessionCreation";
import type { SessionAgentProvider, SessionGraph } from "../lib/types";
import { validateWorkGraph } from "../lib/workGraph";
import { useSettings } from "../lib/settings";
import { useToasts } from "../lib/toasts";
import { useAppStore } from "../store";
import { useTranslation } from "../lib/useTranslation";
import { GraphCanvasEditor, type GraphCanvasValue } from "./GraphCanvasEditor";
import { GraphPresetToolbar } from "./GraphPresetToolbar";
import {
  Button,
  Field,
  Modal,
  ModalFooter,
  ModalHeader,
  Select,
} from "./ui";

interface GraphSessionDialogProps {
  open: boolean;
  scope: SessionCreateScope | null;
  onClose: () => void;
}

const PROVIDERS: Array<{ value: SessionAgentProvider; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "antigravity", label: "Antigravity" },
  { value: "grok", label: "Grok" },
];

function graphSessionName(objective: string): string {
  const compact = objective.trim().replace(/\s+/g, " ");
  const summary = compact.length > 42 ? `${compact.slice(0, 39)}…` : compact;
  return `Graph · ${summary}`;
}

export function GraphSessionDialog({
  open,
  scope,
  onClose,
}: GraphSessionDialogProps) {
  const t = useTranslation();
  const sessions = useAppStore((state) => state.sessions);
  const projects = useAppStore((state) => state.projects);
  const createSession = useAppStore((state) => state.createSession);
  const showToast = useToasts((state) => state.show);
  const selectedAgent = useSettings((state) => state.settings.agents.selected);
  const [draft, setDraft] = useState<SessionGraph>(() => createGraphSessionDraft());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(
      createGraphSessionDraft(
        isSessionAgentProvider(selectedAgent) ? selectedAgent : "claude",
      ),
    );
    setSubmitting(false);
    setError(null);
  }, [open, selectedAgent]);

  const validation = useMemo(
    () => validateWorkGraph(draft.definition),
    [draft.definition],
  );
  const canCreate =
    Boolean(scope?.placement.projectScoped) &&
    draft.objective.trim().length > 0 &&
    validation.valid &&
    !submitting;

  function updateCanvas(value: GraphCanvasValue) {
    setDraft((current) => ({
      ...current,
      definition: value.definition,
      canvas: value.canvas,
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate || !scope) return;
    setSubmitting(true);
    setError(null);
    try {
      const graph = cloneSessionGraph({
        ...draft,
        objective: draft.objective.trim(),
        revision: 1,
      });
      const created = await applySessionCreateRequest(
        createSession,
        buildSessionCreateRequestFromScope(
          { sessions, projects },
          scope,
          {
            name: graphSessionName(graph.objective),
            isolated: true,
            kind: "regular",
            mode: "chat",
            agentProvider: graph.agent.provider,
            graph,
          },
        ),
      );
      if (!created) {
        throw new Error(
          useAppStore.getState().consumeError() ?? t("graphSession.createFailed"),
        );
      }
      onClose();
      await useAppStore.getState().refreshAll();
      useAppStore.getState().selectSession(created.id);
      void runSavedGraphSession(created.id)
        .catch((runError) => {
          console.error("run Graph session failed", runError);
          showToast(`${t("graphSession.runFailed")}: ${String(runError)}`);
        });
    } catch (submitError) {
      setError(String(submitError));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="5xl"
      className="max-w-[min(96vw,90rem)]"
      ariaLabel={t("graphSession.newTitle")}
    >
      <ModalHeader
        title={t("graphSession.newTitle")}
        subtitle={t("graphSession.newSubtitle")}
        icon={<Waypoints size={16} className="text-accent" />}
        onClose={onClose}
      />
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_12rem] gap-3 border-b border-border px-4 py-3">
          <Field label={t("graphSession.objective")}>
            <textarea
              autoFocus
              value={draft.objective}
              onChange={(event) =>
                setDraft((current) => ({ ...current, objective: event.target.value }))
              }
              placeholder={t("graphSession.objectivePlaceholder")}
              className="mt-1 min-h-16 w-full resize-y rounded-lg border border-input-border bg-input px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>
          <Field label={t("graphSession.agent")}>
            <Select
              value={draft.agent.provider}
              disabled={submitting}
              onValueChange={(provider) =>
                setDraft((current) => ({
                  ...current,
                  agent: {
                    ...current.agent,
                    provider: provider as SessionAgentProvider,
                  },
                }))
              }
              options={PROVIDERS}
            />
          </Field>
        </div>
        <GraphPresetToolbar
          graph={draft}
          disabled={submitting}
          onApply={(graph) => setDraft(cloneSessionGraph(graph))}
        />
        <GraphCanvasEditor
          className="min-h-[32rem] flex-1"
          value={{ definition: draft.definition, canvas: draft.canvas }}
          onChange={updateCanvas}
          disabled={submitting}
        />
        {error ? (
          <div role="alert" className="border-t border-danger/25 bg-danger/5 px-4 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}
        <ModalFooter>
          <Button type="button" onClick={onClose} disabled={submitting}>
            {t("graphSession.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!canCreate}>
            <Play size={13} />
            {submitting ? t("graphSession.creating") : t("graphSession.createAndRun")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
