import { ChevronsUpDown, Play, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isSessionAgentProvider } from "../lib/agentProvider";
import { api } from "../lib/api";
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
import type {
  GoalAgentCapabilities,
  GoalAgentModelCapability,
  SessionAgentProvider,
  SessionGraph,
} from "../lib/types";
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
  IconButton,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  Select,
  TextInput,
  type SelectItem,
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

const CUSTOM_MODEL_OPTION = "__acorn_custom_graph_model__";

function hasModelCatalog(
  provider: SessionAgentProvider,
): provider is "claude" | "codex" {
  return provider === "claude" || provider === "codex";
}

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
  const [agentCapabilities, setAgentCapabilities] =
    useState<GoalAgentCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(
    null,
  );
  const [customModel, setCustomModel] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(
      createGraphSessionDraft(
        isSessionAgentProvider(selectedAgent) ? selectedAgent : "claude",
      ),
    );
    setAgentCapabilities(null);
    setCapabilitiesLoading(false);
    setCapabilitiesError(null);
    setCustomModel(false);
    setSubmitting(false);
    setError(null);
  }, [open, selectedAgent]);

  useEffect(() => {
    if (!open) return;
    const provider = draft.agent.provider;
    if (!hasModelCatalog(provider)) {
      setAgentCapabilities(null);
      setCapabilitiesLoading(false);
      setCapabilitiesError(null);
      return;
    }
    let cancelled = false;
    setAgentCapabilities(null);
    setCapabilitiesLoading(true);
    setCapabilitiesError(null);
    void api
      .getGoalAgentCapabilities(provider)
      .then((capabilities) => {
        if (!cancelled) setAgentCapabilities(capabilities);
      })
      .catch((capabilityError: unknown) => {
        if (!cancelled) {
          setAgentCapabilities(null);
          setCapabilitiesError(String(capabilityError));
        }
      })
      .finally(() => {
        if (!cancelled) setCapabilitiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.agent.provider, open]);

  const validation = useMemo(
    () => validateWorkGraph(draft.definition),
    [draft.definition],
  );
  const canCreate =
    Boolean(scope?.placement.projectScoped) &&
    draft.objective.trim().length > 0 &&
    validation.valid &&
    !submitting;
  const capabilityWarning = agentCapabilities?.warning ?? capabilitiesError;

  const modelOptions = useMemo<SelectItem[]>(() => {
    const models = agentCapabilities?.models ?? [];
    const defaultModel = models.find((model) => model.is_default);
    return [
      {
        value: "",
        label: t("graphSession.agentDefault"),
        description: defaultModel?.label,
      },
      ...models
        .filter((model) => model.id !== "default")
        .map((model) => ({
          value: model.id,
          label: model.label,
          description: model.description ?? undefined,
          searchText: `${model.label} ${model.id}`,
        })),
      { type: "separator" as const },
      {
        value: CUSTOM_MODEL_OPTION,
        label: t("graphSession.customModel"),
      },
    ];
  }, [agentCapabilities, t]);

  const selectedModelCapability = useMemo<
    GoalAgentModelCapability | undefined
  >(() => {
    const model = draft.agent.model?.trim();
    return model
      ? agentCapabilities?.models.find((candidate) => candidate.id === model)
      : agentCapabilities?.models.find((candidate) => candidate.is_default);
  }, [agentCapabilities, draft.agent.model]);

  const effortOptions = useMemo<SelectItem[]>(() => {
    const discovered = selectedModelCapability?.supported_efforts.length
      ? selectedModelCapability.supported_efforts
      : (agentCapabilities?.effort_options ?? []);
    const seen = new Set<string>();
    const options = discovered.filter((effort) => {
      if (seen.has(effort.id)) return false;
      seen.add(effort.id);
      return true;
    });
    const currentEffort = draft.agent.effort?.trim();
    if (currentEffort && !seen.has(currentEffort)) {
      options.push({ id: currentEffort });
    }
    const defaultLabel = selectedModelCapability?.default_effort
      ? `${t("graphSession.agentDefault")} · ${selectedModelCapability.default_effort}`
      : t("graphSession.agentDefault");
    return [
      { value: "default", label: defaultLabel },
      ...options.map((effort) => ({
        value: effort.id,
        label: effort.id,
        description: effort.description ?? undefined,
      })),
    ];
  }, [agentCapabilities, draft.agent.effort, selectedModelCapability, t]);

  function changeProvider(provider: SessionAgentProvider) {
    setCustomModel(false);
    setDraft((current) => ({
      ...current,
      agent: { provider, model: null, effort: null },
    }));
  }

  function changeDiscoveredModel(model: string) {
    if (model === CUSTOM_MODEL_OPTION) {
      setCustomModel(true);
      setDraft((current) => ({
        ...current,
        agent: { ...current.agent, model: null },
      }));
      return;
    }
    setCustomModel(false);
    const nextModel = model || null;
    const nextCapability = nextModel
      ? agentCapabilities?.models.find((candidate) => candidate.id === nextModel)
      : agentCapabilities?.models.find((candidate) => candidate.is_default);
    setDraft((current) => ({
      ...current,
      agent: {
        ...current.agent,
        model: nextModel,
        effort:
          current.agent.effort &&
          nextCapability &&
          !nextCapability.supported_efforts.some(
            (effort) => effort.id === current.agent.effort,
          )
            ? null
            : current.agent.effort,
      },
    }));
  }

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
        <div className="grid shrink-0 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start gap-4 border-b border-border px-4 py-3">
          <Field label={t("graphSession.objective")}>
            <textarea
              autoFocus
              value={draft.objective}
              onChange={(event) =>
                setDraft((current) => ({ ...current, objective: event.target.value }))
              }
              placeholder={t("graphSession.objectivePlaceholder")}
              className="min-h-16 w-full resize-y rounded-lg border border-input-border bg-input px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>
          <div className="grid min-w-0 grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.8fr)] gap-2">
            <Field label={t("graphSession.agent")}>
              <Select
                aria-label={t("graphSession.agent")}
                value={draft.agent.provider}
                disabled={submitting}
                onValueChange={(provider) =>
                  changeProvider(provider as SessionAgentProvider)
                }
                options={PROVIDERS}
              />
            </Field>
            <Field label={t("graphSession.model")}>
              {hasModelCatalog(draft.agent.provider) && !customModel ? (
                <Select
                  searchable
                  aria-label={t("graphSession.model")}
                  value={draft.agent.model ?? ""}
                  disabled={submitting || capabilitiesLoading}
                  searchPlaceholder={t("graphSession.searchModels")}
                  onValueChange={changeDiscoveredModel}
                  options={modelOptions}
                />
              ) : (
                <div className="flex min-w-0 gap-1">
                  <TextInput
                    aria-label={t("graphSession.model")}
                    value={draft.agent.model ?? ""}
                    disabled={submitting}
                    placeholder={t("graphSession.customModelPlaceholder")}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agent: {
                          ...current.agent,
                          model: event.target.value || null,
                        },
                      }))
                    }
                  />
                  {hasModelCatalog(draft.agent.provider) ? (
                    <IconButton
                      size="lg"
                      variant="outline"
                      disabled={submitting}
                      aria-label={t("graphSession.chooseDiscoveredModel")}
                      title={t("graphSession.chooseDiscoveredModel")}
                      onClick={() => {
                        setCustomModel(false);
                        setDraft((current) => ({
                          ...current,
                          agent: { ...current.agent, model: null },
                        }));
                      }}
                    >
                      <ChevronsUpDown size={13} />
                    </IconButton>
                  ) : null}
                </div>
              )}
            </Field>
            <Field label={t("graphSession.effort")}>
              {hasModelCatalog(draft.agent.provider) ? (
                <Select
                  aria-label={t("graphSession.effort")}
                  value={draft.agent.effort ?? "default"}
                  disabled={submitting || capabilitiesLoading}
                  onValueChange={(effort) =>
                    setDraft((current) => ({
                      ...current,
                      agent: {
                        ...current.agent,
                        effort: effort === "default" ? null : effort,
                      },
                    }))
                  }
                  options={effortOptions}
                />
              ) : (
                <TextInput
                  aria-label={t("graphSession.effort")}
                  value={draft.agent.effort ?? ""}
                  disabled={submitting}
                  placeholder={t("graphSession.agentDefault")}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      agent: {
                        ...current.agent,
                        effort: event.target.value || null,
                      },
                    }))
                  }
                />
              )}
            </Field>
          </div>
          {capabilityWarning ? (
            <Notice
              tone="neutral"
              density="compact"
              className="col-span-2"
              data-graph-capability-warning
            >
              {capabilityWarning}
            </Notice>
          ) : null}
        </div>
        <GraphPresetToolbar
          graph={draft}
          disabled={submitting}
          onApply={(graph) => setDraft(cloneSessionGraph(graph))}
        />
        <GraphCanvasEditor
          className="min-h-0 flex-1"
          value={{ definition: draft.definition, canvas: draft.canvas }}
          onChange={updateCanvas}
          disabled={submitting}
        />
        {error ? (
          <div role="alert" className="border-t border-danger/25 bg-danger/5 px-4 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}
        <ModalFooter className="shrink-0 border-t border-border">
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
