import { ChevronsUpDown, Copy, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BALANCED_AUTONOMOUS_GOAL_PRESET,
  BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
  AUTONOMOUS_GOAL_STAGE_IDS,
  AUTONOMOUS_GOAL_STAGE_MODEL_KEYS,
  FULL_AUTONOMY_GOAL_PRESET_ID,
  REVIEW_AUTONOMOUS_GOAL_PRESET_ID,
  autonomousPresetFromSessionGoal,
  cloneGoalModelConfig,
  createDefaultGoalModelConfig,
  createSessionGoal,
  createCustomAutonomousGoalPreset,
  deleteCustomAutonomousGoalPreset,
  deriveAutonomousGoalSessionName,
  findAutonomousGoalPreset,
  listAutonomousGoalPresets,
  loadAutonomousGoalPreferences,
  resolveInitialAutonomousGoalPresetId,
  saveAutonomousGoalPreferences,
  type AutonomousGoalPreferences,
  type AutonomousGoalPreset,
  type AutonomousGoalProvider,
  type AutonomousGoalStage,
  type AutonomousGoalStagePolicy,
} from "../lib/autonomousGoal";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  applySessionCreateRequest,
  buildSessionCreateRequestFromScope,
  type SessionCreateScope,
} from "../lib/sessionCreation";
import { useSettings } from "../lib/settings";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import type {
  GoalAgentCapabilities,
  GoalAgentEffortOption,
  GoalAgentModelCapability,
  Session,
  SessionGoalModelConfig,
  SessionGoalModelSelection,
} from "../lib/types";
import {
  Button,
  CheckboxRow,
  Field,
  IconButton,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  Select,
  type SelectItem,
  SegmentedControl,
  TextInput,
  TEXT_INPUT_CLASS,
} from "./ui";

interface AutonomousGoalDialogProps {
  open: boolean;
  scope: SessionCreateScope | null;
  session?: Session | null;
  onClose: () => void;
}

type AutonomousGoalTranslationKey = Extract<
  TranslationKey,
  `dialogs.autonomousGoal.${string}`
>;

function agt(t: Translator, key: AutonomousGoalTranslationKey): string {
  return t(key);
}

const STAGE_TRANSLATION_KEYS: Record<
  AutonomousGoalStage,
  AutonomousGoalTranslationKey
> = {
  interpretation: "dialogs.autonomousGoal.stages.interpretation",
  plan: "dialogs.autonomousGoal.stages.plan",
  implementation: "dialogs.autonomousGoal.stages.implementation",
  validation: "dialogs.autonomousGoal.stages.validation",
  autoFix: "dialogs.autonomousGoal.stages.autoFix",
  selfReview: "dialogs.autonomousGoal.stages.selfReview",
  draftPr: "dialogs.autonomousGoal.stages.draftPr",
};

const POLICY_TRANSLATION_KEYS: Record<
  AutonomousGoalStagePolicy,
  AutonomousGoalTranslationKey
> = {
  auto: "dialogs.autonomousGoal.policies.auto",
  approval: "dialogs.autonomousGoal.policies.approval",
  disabled: "dialogs.autonomousGoal.policies.disabled",
};

type GoalSettingsTab = "policy" | "model";

type GoalModelSlot = "default" | keyof SessionGoalModelConfig["stages"];

const GOAL_AGENT_PROVIDERS = ["codex", "claude"] as const;
const CUSTOM_MODEL_OPTION = "__acorn_custom_model__";

function defaultProvider(selected: string): AutonomousGoalProvider {
  return selected === "claude" ? "claude" : "codex";
}

function createPresetId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return `custom:${webCrypto.randomUUID()}`;
  }
  return `custom:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function builtinPresetName(
  t: Translator,
  preset: AutonomousGoalPreset,
): string {
  if (preset.id === REVIEW_AUTONOMOUS_GOAL_PRESET_ID) {
    return agt(t, "dialogs.autonomousGoal.presets.review");
  }
  if (preset.id === BALANCED_AUTONOMOUS_GOAL_PRESET_ID) {
    return agt(t, "dialogs.autonomousGoal.presets.balanced");
  }
  if (preset.id === FULL_AUTONOMY_GOAL_PRESET_ID) {
    return agt(t, "dialogs.autonomousGoal.presets.fullAutonomy");
  }
  return preset.name;
}

function presetDisplayName(t: Translator, preset: AutonomousGoalPreset) {
  return preset.builtIn ? builtinPresetName(t, preset) : preset.name;
}

function nextCustomPresetName(
  t: Translator,
  preferences: AutonomousGoalPreferences,
): string {
  const prefix = agt(t, "dialogs.autonomousGoal.presets.customDefault");
  const taken = new Set(
    preferences.customPresets.map((preset) => preset.name.toLocaleLowerCase()),
  );
  let index = preferences.customPresets.length + 1;
  let candidate = `${prefix} ${index}`;
  while (taken.has(candidate.toLocaleLowerCase())) {
    index += 1;
    candidate = `${prefix} ${index}`;
  }
  return candidate;
}

function formatToast(template: string, value: string): string {
  return template.replace("{name}", value);
}

function sessionSnapshotPresetId(session: Session): string {
  return `session-snapshot:${session.id}:${session.goal?.revision ?? 0}`;
}

function markLocalGoalSessionWorking(sessionId: string) {
  useAppStore.setState((state) => {
    let changed = false;
    const sessions = state.sessions.map((session) => {
      if (session.id !== sessionId || session.status === "working") {
        return session;
      }
      changed = true;
      return { ...session, status: "working" as const };
    });
    return changed ? { sessions } : {};
  });
}

export function AutonomousGoalDialog({
  open,
  scope,
  session = null,
  onClose,
}: AutonomousGoalDialogProps) {
  const t = useTranslation();
  const titleId = useId();
  const showToast = useToasts((state) => state.show);
  const sessions = useAppStore((state) => state.sessions);
  const projects = useAppStore((state) => state.projects);
  const createSession = useAppStore((state) => state.createSession);
  const [goal, setGoal] = useState("");
  const [completionCriteria, setCompletionCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [tests, setTests] = useState("");
  const [provider, setProvider] = useState<AutonomousGoalProvider>(() =>
    defaultProvider(useSettings.getState().settings.agents.selected),
  );
  const [preferences, setPreferences] =
    useState<AutonomousGoalPreferences>(loadAutonomousGoalPreferences);
  const preferencesRef = useRef(preferences);
  const [selectedPresetId, setSelectedPresetId] = useState(() =>
    resolveInitialAutonomousGoalPresetId(loadAutonomousGoalPreferences()),
  );
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [settingsTab, setSettingsTab] = useState<GoalSettingsTab>("policy");
  const [modelConfig, setModelConfig] = useState<SessionGoalModelConfig>(
    createDefaultGoalModelConfig,
  );
  const [agentCapabilities, setAgentCapabilities] = useState<
    Partial<Record<AutonomousGoalProvider, GoalAgentCapabilities>>
  >({});
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const capabilityRequestsRef = useRef<
    Partial<
      Record<AutonomousGoalProvider, Promise<GoalAgentCapabilities>>
    >
  >({});
  const [customModelSlots, setCustomModelSlots] = useState<Set<GoalModelSlot>>(
    () => new Set(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingSession = session?.goal ? session : null;
  const editingGoal = editingSession?.goal ?? null;
  const snapshotPreset = useMemo(() => {
    if (!editingSession || !editingGoal) return null;
    return autonomousPresetFromSessionGoal(
      editingGoal,
      sessionSnapshotPresetId(editingSession),
      `${editingGoal.preset.name} · ${agt(t, "dialogs.autonomousGoal.presets.sessionSnapshot")}`,
    );
  }, [editingGoal, editingSession, t]);

  useEffect(() => {
    if (!open) return;
    const loaded = loadAutonomousGoalPreferences();
    const initialPresetId = editingSession
      ? sessionSnapshotPresetId(editingSession)
      : resolveInitialAutonomousGoalPresetId(loaded);
    const initialPreset = editingSession
      ? autonomousPresetFromSessionGoal(
          editingSession.goal!,
          initialPresetId,
          editingSession.goal!.preset.name,
        )
      : findAutonomousGoalPreset(loaded, initialPresetId);
    preferencesRef.current = loaded;
    setPreferences(loaded);
    setSelectedPresetId(initialPresetId);
    setPresetNameDraft(initialPreset?.builtIn ? "" : (initialPreset?.name ?? ""));
    setProvider(
      editingSession?.goal?.provider ??
        defaultProvider(useSettings.getState().settings.agents.selected),
    );
    setSettingsTab("policy");
    setModelConfig(cloneGoalModelConfig(editingSession?.goal?.model_config));
    setCustomModelSlots(new Set());
    setGoal(editingSession?.goal?.objective ?? "");
    setCompletionCriteria(editingSession?.goal?.completion_criteria ?? "");
    setConstraints(editingSession?.goal?.constraints ?? "");
    setTests(editingSession?.goal?.tests ?? "");
    setSubmitting(false);
    setError(null);
  }, [editingSession?.id, editingSession?.goal?.revision, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCapabilitiesLoading(true);
    const requests = GOAL_AGENT_PROVIDERS.map((agentProvider) => {
      const existing = capabilityRequestsRef.current[agentProvider];
      if (existing) return existing;
      const request = api
        .getGoalAgentCapabilities(agentProvider)
        .catch(
          (capabilityError: unknown): GoalAgentCapabilities => ({
            provider: agentProvider,
            installed: false,
            source: "unavailable",
            models: [],
            effort_options: [],
            warning: String(capabilityError),
          }),
        );
      capabilityRequestsRef.current[agentProvider] = request;
      void request.then(() => {
        if (capabilityRequestsRef.current[agentProvider] === request) {
          delete capabilityRequestsRef.current[agentProvider];
        }
      });
      return request;
    });
    void Promise.all(requests).then((capabilities) => {
      if (cancelled) return;
      setAgentCapabilities(
        Object.fromEntries(
          capabilities.map((item) => [item.provider, item]),
        ) as Record<AutonomousGoalProvider, GoalAgentCapabilities>,
      );
      setCapabilitiesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const presets = useMemo(
    () => [
      ...(snapshotPreset ? [snapshotPreset] : []),
      ...listAutonomousGoalPresets(preferences),
    ],
    [preferences, snapshotPreset],
  );
  const selectedPreset = useMemo(
    () =>
      snapshotPreset?.id === selectedPresetId
        ? snapshotPreset
        : findAutonomousGoalPreset(preferences, selectedPresetId),
    [preferences, selectedPresetId, snapshotPreset],
  );

  useEffect(() => {
    setPresetNameDraft(
      selectedPreset && !selectedPreset.builtIn ? selectedPreset.name : "",
    );
  }, [selectedPreset?.id, selectedPreset?.name, selectedPreset?.builtIn]);

  function persistPreferences(next: AutonomousGoalPreferences) {
    preferencesRef.current = next;
    setPreferences(next);
    saveAutonomousGoalPreferences(next);
  }

  function selectPreset(presetId: string) {
    setSelectedPresetId(presetId);
    setError(null);
  }

  function addPreset() {
    const preset = createCustomAutonomousGoalPreset(
      BALANCED_AUTONOMOUS_GOAL_PRESET,
      createPresetId(),
      nextCustomPresetName(t, preferences),
    );
    persistPreferences({
      ...preferences,
      customPresets: [...preferences.customPresets, preset],
      lastPresetId: preset.id,
    });
    selectPreset(preset.id);
  }

  function duplicatePreset() {
    if (!selectedPreset) return;
    const sourceName = presetDisplayName(t, selectedPreset);
    const preset = createCustomAutonomousGoalPreset(
      selectedPreset,
      createPresetId(),
      `${sourceName} ${agt(t, "dialogs.autonomousGoal.presets.copySuffix")}`,
    );
    persistPreferences({
      ...preferences,
      customPresets: [...preferences.customPresets, preset],
      lastPresetId: preset.id,
    });
    selectPreset(preset.id);
  }

  function commitPresetName() {
    if (!selectedPreset || selectedPreset.builtIn) return;
    const name = presetNameDraft.trim() || selectedPreset.name;
    setPresetNameDraft(name);
    persistPreferences({
      ...preferences,
      customPresets: preferences.customPresets.map((preset) =>
        preset.id === selectedPreset.id ? { ...preset, name } : preset,
      ),
    });
  }

  function updateStagePolicy(
    stage: AutonomousGoalStage,
    policy: AutonomousGoalStagePolicy,
  ) {
    if (!selectedPreset || selectedPreset.builtIn) return;
    persistPreferences({
      ...preferences,
      customPresets: preferences.customPresets.map((preset) =>
        preset.id === selectedPreset.id
          ? {
              ...preset,
              policies: { ...preset.policies, [stage]: policy },
            }
          : preset,
      ),
    });
  }

  function deletePreset() {
    if (!selectedPreset || selectedPreset.builtIn) return;
    const next = deleteCustomAutonomousGoalPreset(
      preferences,
      selectedPreset.id,
    );
    persistPreferences(next);
    selectPreset(resolveInitialAutonomousGoalPresetId(next));
  }

  function changeProvider(nextProvider: AutonomousGoalProvider) {
    setProvider(nextProvider);
    setCustomModelSlots(new Set());
  }

  function updateDefaultModelSelection(
    patch: Partial<SessionGoalModelSelection>,
  ) {
    setModelConfig((current) => ({
      ...current,
      default: { ...current.default, ...patch },
    }));
  }

  function updateStageModelSelection(
    stage: AutonomousGoalStage,
    patch: Partial<SessionGoalModelSelection>,
  ) {
    const stageKey = AUTONOMOUS_GOAL_STAGE_MODEL_KEYS[stage];
    setModelConfig((current) => ({
      ...current,
      stages: {
        ...current.stages,
        [stageKey]: { ...current.stages[stageKey], ...patch },
      },
    }));
  }

  function toggleSingleModel(singleModel: boolean) {
    setModelConfig((current) => {
      if (singleModel) return { ...current, single_model: true };
      const stageSelections = Object.values(current.stages);
      const hasDetailedValues = stageSelections.some(
        (selection) => selection.model || selection.effort,
      );
      if (hasDetailedValues) return { ...current, single_model: false };
      const inherited = () => ({ ...current.default });
      return {
        ...current,
        single_model: false,
        stages: {
          interpretation: inherited(),
          plan: inherited(),
          implementation: inherited(),
          validation: inherited(),
          auto_fix: inherited(),
          self_review: inherited(),
          draft_pr: inherited(),
        },
      };
    });
  }

  function close() {
    if (!submitting) onClose();
  }

  function runGoalSession(sessionId: string) {
    markLocalGoalSessionWorking(sessionId);
    void api
      .runGoalSession(sessionId)
      .then(
        () => {
          void useAppStore
            .getState()
            .refreshSessions()
            .catch((refreshError: unknown) => {
              console.error(
                "failed to refresh completed goal session",
                refreshError,
              );
            });
        },
        async (sendError: unknown) => {
          console.error("goal session run failed", sendError);
          try {
            await api.setSessionStatus(sessionId, "errored");
            await useAppStore.getState().refreshSessions();
          } catch (statusError) {
            console.error("failed to mark goal session as errored", statusError);
          }
          showToast(
            `${t("toasts.autonomousGoal.startFailed")} ${String(sendError)}`,
          );
        },
      );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    let currentPreferences = preferencesRef.current;
    let currentPreset =
      snapshotPreset?.id === selectedPresetId
        ? snapshotPreset
        : findAutonomousGoalPreset(currentPreferences, selectedPresetId);
    if (!trimmedGoal || !currentPreset || submitting) return;

    if (!currentPreset.builtIn) {
      const committedName = presetNameDraft.trim() || currentPreset.name;
      if (committedName !== currentPreset.name) {
        currentPreferences = {
          ...currentPreferences,
          customPresets: currentPreferences.customPresets.map((preset) =>
            preset.id === currentPreset?.id
              ? { ...preset, name: committedName }
              : preset,
          ),
        };
        persistPreferences(currentPreferences);
        currentPreset = findAutonomousGoalPreset(
          currentPreferences,
          selectedPresetId,
        );
        if (!currentPreset) return;
      }
    }
    setSubmitting(true);
    setError(null);

    const sessionName = deriveAutonomousGoalSessionName(trimmedGoal);
    const usesSessionSnapshot = currentPreset.id === snapshotPreset?.id;
    const presetSnapshot: AutonomousGoalPreset = {
      ...currentPreset,
      id: usesSessionSnapshot
        ? (editingGoal?.preset.id ?? currentPreset.id)
        : currentPreset.id,
      name: usesSessionSnapshot
        ? (editingGoal?.preset.name ?? currentPreset.name)
        : presetDisplayName(t, currentPreset),
      policies: { ...currentPreset.policies },
    };
    const goalSpec = createSessionGoal(
      { goal: trimmedGoal, completionCriteria, constraints, tests },
      provider,
      presetSnapshot,
      editingGoal?.revision ?? 1,
      modelConfig,
    );

    try {
      const nextPreferences = {
        ...currentPreferences,
        lastPresetId: usesSessionSnapshot
          ? currentPreferences.lastPresetId
          : currentPreset.id,
      } satisfies AutonomousGoalPreferences;
      persistPreferences(nextPreferences);

      if (editingSession && editingGoal) {
        await api.cancelChatMessage(editingSession.id);
        const updated = await api.updateSessionGoal(
          editingSession.id,
          editingGoal.revision,
          goalSpec,
        );
        if (!updated.goal) {
          throw new Error("updated goal session did not return its goal");
        }
        await useAppStore.getState().refreshSessions();
        onClose();
        showToast(
          formatToast(t("toasts.autonomousGoal.updated"), updated.name),
        );
        runGoalSession(updated.id);
        return;
      }

      if (!scope) {
        throw new Error(
          agt(t, "dialogs.autonomousGoal.projectScopeRequired"),
        );
      }
      const created = await applySessionCreateRequest(
        createSession,
        buildSessionCreateRequestFromScope(
          { sessions, projects },
          scope,
          {
            name: sessionName,
            isolated: true,
            kind: "regular",
            agentProvider: provider,
            mode: "chat",
            goal: goalSpec,
          },
        ),
      );
      if (!created) {
        const storeError = useAppStore.getState().consumeError();
        if (storeError) setError(storeError);
        setSubmitting(false);
        return;
      }

      onClose();
      showToast(formatToast(t("toasts.autonomousGoal.started"), sessionName));
      runGoalSession(created.id);
    } catch (submitError) {
      console.error("save goal session failed", submitError);
      setError(String(submitError));
      setSubmitting(false);
    }
  }

  const presetOptions = presets.map((preset) => ({
    value: preset.id,
    label: presetDisplayName(t, preset),
    description:
      preset.id === snapshotPreset?.id
        ? agt(t, "dialogs.autonomousGoal.presets.sessionSnapshotHint")
        : preset.builtIn
          ? agt(t, "dialogs.autonomousGoal.presets.builtIn")
          : agt(t, "dialogs.autonomousGoal.presets.custom"),
  }));
  const policyOptions = (["auto", "approval", "disabled"] as const).map(
    (policy) => ({
      value: policy,
      label: agt(t, POLICY_TRANSLATION_KEYS[policy]),
    }),
  );
  const providerOptions = GOAL_AGENT_PROVIDERS.map((agentProvider) => {
    const capabilities = agentCapabilities[agentProvider];
    const label = agentProvider === "codex" ? "Codex" : "Claude";
    let description = agt(
      t,
      "dialogs.autonomousGoal.provider.capabilityLoading",
    );
    if (capabilities?.installed) {
      description = capabilities.version
        ? capabilities.version
        : agt(t, "dialogs.autonomousGoal.provider.available");
    } else if (capabilities) {
      description = agt(t, "dialogs.autonomousGoal.provider.unavailable");
    }
    return { value: agentProvider, label, description };
  });
  const selectedAgentCapabilities = agentCapabilities[provider];

  function modelCapabilityFor(
    selection: SessionGoalModelSelection,
  ): GoalAgentModelCapability | undefined {
    const model = selection.model?.trim();
    if (model && model !== "default") {
      return selectedAgentCapabilities?.models.find(
        (candidate) => candidate.id === model,
      );
    }
    return selectedAgentCapabilities?.models.find(
      (candidate) => candidate.is_default,
    );
  }

  function effortOptionsFor(
    selection: SessionGoalModelSelection,
  ): SelectItem[] {
    const modelCapability = modelCapabilityFor(selection);
    const discovered = modelCapability
      ? modelCapability.supported_efforts
      : (selectedAgentCapabilities?.effort_options ?? []);
    const efforts: GoalAgentEffortOption[] = [];
    const seen = new Set<string>();
    for (const effort of discovered) {
      if (seen.has(effort.id)) continue;
      seen.add(effort.id);
      efforts.push(effort);
    }
    if (selection.effort && !seen.has(selection.effort)) {
      efforts.push({ id: selection.effort });
    }
    const defaultLabel = modelCapability?.default_effort
      ? `${agt(t, "dialogs.autonomousGoal.model.agentDefault")} · ${modelCapability.default_effort}`
      : agt(t, "dialogs.autonomousGoal.model.agentDefault");
    return [
      { value: "default", label: defaultLabel },
      ...efforts.map((effort) => ({
        value: effort.id,
        label: effort.id,
        description: effort.description ?? undefined,
      })),
    ];
  }

  function modelOptions(): SelectItem[] {
    const defaultModel = selectedAgentCapabilities?.models.find(
      (candidate) => candidate.is_default,
    );
    const options: SelectItem[] = [
      {
        value: "",
        label: agt(t, "dialogs.autonomousGoal.model.agentDefault"),
        description: defaultModel?.label,
      },
      ...(selectedAgentCapabilities?.models ?? [])
        .filter((model) => model.id !== "default")
        .map((model) => ({
          value: model.id,
          label: model.label,
          description: model.description ?? undefined,
          searchText: `${model.label} ${model.id}`,
        })),
      { type: "separator" },
      {
        value: CUSTOM_MODEL_OPTION,
        label: agt(t, "dialogs.autonomousGoal.model.customModel"),
      },
    ];
    return options;
  }

  function setCustomModelSlot(slot: GoalModelSlot, enabled: boolean) {
    setCustomModelSlots((current) => {
      const next = new Set(current);
      if (enabled) next.add(slot);
      else next.delete(slot);
      return next;
    });
  }

  function capabilityStatusText(): string {
    const capabilities = selectedAgentCapabilities;
    if (!capabilities && capabilitiesLoading) {
      return agt(t, "dialogs.autonomousGoal.model.loadingCapabilities");
    }
    if (!capabilities?.installed) {
      return agt(t, "dialogs.autonomousGoal.model.agentUnavailable");
    }
    if (capabilities.source === "codex_app_server") {
      return agt(t, "dialogs.autonomousGoal.model.codexCapabilities").replace(
        "{count}",
        String(capabilities.models.length),
      );
    }
    if (capabilities.source === "claude_cli_help") {
      return agt(t, "dialogs.autonomousGoal.model.claudeCapabilities");
    }
    return agt(t, "dialogs.autonomousGoal.model.capabilityFallback");
  }

  function renderModelSelection(
    selection: SessionGoalModelSelection,
    onChange: (patch: Partial<SessionGoalModelSelection>) => void,
    ariaPrefix: string,
    slot: GoalModelSlot,
  ) {
    const model = selection.model?.trim() ?? "";
    const modelIsDiscovered = selectedAgentCapabilities?.models.some(
      (candidate) => candidate.id === model,
    );
    const customModel =
      customModelSlots.has(slot) ||
      Boolean(model && model !== "default" && !modelIsDiscovered);
    return (
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_116px] gap-2">
        {customModel ? (
          <div className="flex min-w-0 gap-1">
            <TextInput
              autoFocus={!model}
              aria-label={`${ariaPrefix} ${agt(t, "dialogs.autonomousGoal.model.modelLabel")}`}
              value={selection.model ?? ""}
              placeholder={agt(
                t,
                "dialogs.autonomousGoal.model.customModelPlaceholder",
              )}
              onChange={(event) => onChange({ model: event.target.value })}
            />
            <IconButton
              aria-label={agt(
                t,
                "dialogs.autonomousGoal.model.chooseDiscoveredModel",
              )}
              title={agt(
                t,
                "dialogs.autonomousGoal.model.chooseDiscoveredModel",
              )}
              size="lg"
              variant="outline"
              onClick={() => {
                setCustomModelSlot(slot, false);
                onChange({ model: undefined });
              }}
            >
              <ChevronsUpDown size={13} />
            </IconButton>
          </div>
        ) : (
          <Select
            searchable
            aria-label={`${ariaPrefix} ${agt(t, "dialogs.autonomousGoal.model.modelLabel")}`}
            value={model === "default" ? "" : model}
            options={modelOptions()}
            searchPlaceholder={agt(
              t,
              "dialogs.autonomousGoal.model.searchModels",
            )}
            onValueChange={(value) => {
              if (value === CUSTOM_MODEL_OPTION) {
                setCustomModelSlot(slot, true);
                onChange({ model: undefined });
                return;
              }
              setCustomModelSlot(slot, false);
              const nextModel = value || undefined;
              const nextCapability = nextModel
                ? selectedAgentCapabilities?.models.find(
                    (candidate) => candidate.id === nextModel,
                  )
                : selectedAgentCapabilities?.models.find(
                    (candidate) => candidate.is_default,
                  );
              const effort = selection.effort;
              const supported = nextCapability?.supported_efforts ?? [];
              onChange({
                model: nextModel,
                effort:
                  effort &&
                  nextCapability &&
                  !supported.some((candidate) => candidate.id === effort)
                    ? undefined
                    : effort,
              });
            }}
          />
        )}
        <Select
          aria-label={`${ariaPrefix} ${agt(t, "dialogs.autonomousGoal.model.effortLabel")}`}
          value={selection.effort ?? "default"}
          options={effortOptionsFor(selection)}
          onValueChange={(value) =>
            onChange({
              effort: value === "default" ? undefined : value,
            })
          }
        />
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      variant="dialog"
      size="3xl"
      ariaLabelledBy={titleId}
      className="flex max-h-[calc(100vh-8rem)] flex-col"
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalHeader
          titleId={titleId}
          title={agt(
            t,
            editingSession
              ? "dialogs.autonomousGoal.editTitle"
              : "dialogs.autonomousGoal.title",
          )}
          subtitle={agt(
            t,
            editingSession
              ? "dialogs.autonomousGoal.editSubtitle"
              : "dialogs.autonomousGoal.subtitle",
          )}
          icon={<Sparkles size={18} className="text-accent" />}
          variant="dialog"
          onClose={close}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
            <section className="flex min-w-0 flex-col gap-3">
              <Field
                label={agt(t, "dialogs.autonomousGoal.goal.label")}
                hint={agt(t, "dialogs.autonomousGoal.goal.hint")}
              >
                <textarea
                  autoFocus
                  required
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder={agt(
                    t,
                    "dialogs.autonomousGoal.goal.placeholder",
                  )}
                  className={cn(
                    TEXT_INPUT_CLASS,
                    "h-28 resize-y py-2 leading-relaxed",
                  )}
                />
              </Field>

              <div className="grid gap-3">
                <Field
                  label={agt(
                    t,
                    "dialogs.autonomousGoal.completionCriteria.label",
                  )}
                  hint={agt(
                    t,
                    "dialogs.autonomousGoal.optionalFieldHint",
                  )}
                >
                  <textarea
                    value={completionCriteria}
                    onChange={(event) =>
                      setCompletionCriteria(event.target.value)
                    }
                    placeholder={agt(
                      t,
                      "dialogs.autonomousGoal.completionCriteria.placeholder",
                    )}
                    className={cn(
                      TEXT_INPUT_CLASS,
                      "h-20 resize-y py-2 leading-relaxed",
                    )}
                  />
                </Field>
                <Field
                  label={agt(t, "dialogs.autonomousGoal.constraints.label")}
                  hint={agt(
                    t,
                    "dialogs.autonomousGoal.optionalFieldHint",
                  )}
                >
                  <textarea
                    value={constraints}
                    onChange={(event) => setConstraints(event.target.value)}
                    placeholder={agt(
                      t,
                      "dialogs.autonomousGoal.constraints.placeholder",
                    )}
                    className={cn(
                      TEXT_INPUT_CLASS,
                      "h-20 resize-y py-2 leading-relaxed",
                    )}
                  />
                </Field>
              </div>

              <Field
                label={agt(t, "dialogs.autonomousGoal.tests.label")}
                hint={agt(t, "dialogs.autonomousGoal.optionalFieldHint")}
              >
                <textarea
                  value={tests}
                  onChange={(event) => setTests(event.target.value)}
                  placeholder={agt(
                    t,
                    "dialogs.autonomousGoal.tests.placeholder",
                  )}
                  className={cn(
                    TEXT_INPUT_CLASS,
                    "h-16 resize-y py-2 leading-relaxed",
                  )}
                />
              </Field>

              <Notice tone="info" density="compact">
                {agt(
                  t,
                  editingSession
                    ? "dialogs.autonomousGoal.revisionNotice"
                    : "dialogs.autonomousGoal.prototypeNotice",
                )}
              </Notice>
            </section>

            <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-bg-sidebar/35 p-3">
              <SegmentedControl
                activeId={settingsTab}
                onChange={setSettingsTab}
                surface="dialog"
                size="sm"
                ariaLabel={agt(t, "dialogs.autonomousGoal.tabs.label")}
                items={[
                  {
                    id: "policy",
                    label: agt(t, "dialogs.autonomousGoal.tabs.policy"),
                  },
                  {
                    id: "model",
                    label: agt(t, "dialogs.autonomousGoal.tabs.model"),
                  },
                ]}
              />

              {settingsTab === "policy" ? (
                <>
                  <Field
                    label={agt(t, "dialogs.autonomousGoal.preset.label")}
                    hint={agt(t, "dialogs.autonomousGoal.preset.hint")}
                  >
                    <Select
                      value={selectedPresetId}
                      onValueChange={selectPreset}
                      options={presetOptions}
                    />
                  </Field>

                  <div className="flex flex-wrap gap-1.5">
                    <Button size="xs" variant="outline" onClick={addPreset}>
                      <Plus size={12} />
                      {agt(t, "dialogs.autonomousGoal.preset.add")}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={duplicatePreset}
                      disabled={!selectedPreset}
                    >
                      <Copy size={12} />
                      {agt(t, "dialogs.autonomousGoal.preset.duplicate")}
                    </Button>
                    {!selectedPreset?.builtIn ? (
                      <Button
                        size="xs"
                        variant="dangerGhost"
                        onClick={deletePreset}
                      >
                        <Trash2 size={12} />
                        {agt(t, "dialogs.autonomousGoal.preset.delete")}
                      </Button>
                    ) : null}
                  </div>

                  {selectedPreset && !selectedPreset.builtIn ? (
                    <Field
                      label={agt(t, "dialogs.autonomousGoal.preset.name")}
                    >
                      <TextInput
                        value={presetNameDraft}
                        maxLength={80}
                        onChange={(event) =>
                          setPresetNameDraft(event.target.value)
                        }
                        onBlur={commitPresetName}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitPresetName();
                          }
                        }}
                      />
                    </Field>
                  ) : (
                    <Notice tone="neutral" density="compact">
                      {agt(t, "dialogs.autonomousGoal.preset.builtInReadonly")}
                    </Notice>
                  )}

                  <div className="flex flex-col gap-1.5">
                    {selectedPreset
                      ? AUTONOMOUS_GOAL_STAGE_IDS.map((stage) => (
                          <div
                            key={stage}
                            className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-2"
                          >
                            <span className="truncate text-xs text-fg">
                              {agt(t, STAGE_TRANSLATION_KEYS[stage])}
                            </span>
                            <Select
                              aria-label={agt(t, STAGE_TRANSLATION_KEYS[stage])}
                              value={selectedPreset.policies[stage]}
                              disabled={selectedPreset.builtIn}
                              onValueChange={(value) =>
                                updateStagePolicy(
                                  stage,
                                  value as AutonomousGoalStagePolicy,
                                )
                              }
                              options={policyOptions}
                            />
                          </div>
                        ))
                      : null}
                  </div>

                  <p className="text-[11px] leading-relaxed text-fg-muted">
                    {agt(t, "dialogs.autonomousGoal.preset.snapshotHint")}
                  </p>
                </>
              ) : (
                <>
                  <Field
                    label={agt(t, "dialogs.autonomousGoal.provider.label")}
                    hint={agt(t, "dialogs.autonomousGoal.provider.hint")}
                  >
                    <Select
                      aria-label={agt(
                        t,
                        "dialogs.autonomousGoal.provider.label",
                      )}
                      value={provider}
                      onValueChange={(value) =>
                        changeProvider(value as AutonomousGoalProvider)
                      }
                      options={providerOptions}
                    />
                  </Field>

                  <CheckboxRow
                    checked={modelConfig.single_model}
                    onChange={toggleSingleModel}
                    label={agt(t, "dialogs.autonomousGoal.model.singleModel")}
                    description={agt(
                      t,
                      "dialogs.autonomousGoal.model.singleModelHint",
                    )}
                  />

                  <Notice
                    tone={
                      selectedAgentCapabilities?.installed === false ||
                      selectedAgentCapabilities?.source === "fallback"
                        ? "neutral"
                        : "info"
                    }
                    density="compact"
                  >
                    {capabilityStatusText()}
                  </Notice>

                  {modelConfig.single_model ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="grid grid-cols-[minmax(0,1fr)_116px] gap-2 text-[10px] uppercase tracking-wide text-fg-muted">
                        <span>
                          {agt(t, "dialogs.autonomousGoal.model.modelLabel")}
                        </span>
                        <span>
                          {agt(t, "dialogs.autonomousGoal.model.effortLabel")}
                        </span>
                      </div>
                      {renderModelSelection(
                        modelConfig.default,
                        updateDefaultModelSelection,
                        agt(t, "dialogs.autonomousGoal.model.allStages"),
                        "default",
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_116px] gap-2 px-2 text-[10px] uppercase tracking-wide text-fg-muted">
                        <span>
                          {agt(t, "dialogs.autonomousGoal.model.modelLabel")}
                        </span>
                        <span>
                          {agt(t, "dialogs.autonomousGoal.model.effortLabel")}
                        </span>
                      </div>
                      {AUTONOMOUS_GOAL_STAGE_IDS.map((stage) => {
                        const stageKey = AUTONOMOUS_GOAL_STAGE_MODEL_KEYS[stage];
                        const label = agt(t, STAGE_TRANSLATION_KEYS[stage]);
                        return (
                          <div
                            key={stage}
                            className="flex flex-col gap-1 rounded-lg border border-border bg-bg/65 p-2"
                          >
                            <span className="text-[11px] font-medium text-fg">
                              {label}
                            </span>
                            {renderModelSelection(
                              modelConfig.stages[stageKey],
                              (patch) =>
                                updateStageModelSelection(stage, patch),
                              label,
                              stageKey,
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <p className="text-[11px] leading-relaxed text-fg-muted">
                    {agt(t, "dialogs.autonomousGoal.model.snapshotHint")}
                  </p>
                </>
              )}
            </section>
          </div>

          {error ? (
            <Notice tone="danger" className="mt-3">
              {error}
            </Notice>
          ) : null}
        </div>

        <ModalFooter className="border-t border-border" align="between">
          <span className="text-[11px] text-fg-muted">
            {agt(
              t,
              editingSession
                ? "dialogs.autonomousGoal.editFooterHint"
                : "dialogs.autonomousGoal.footerHint",
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={close} disabled={submitting}>
              {t("dialogs.common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || !goal.trim() || !selectedPreset}
            >
              <Sparkles size={13} />
              {submitting
                ? agt(
                    t,
                    editingSession
                      ? "dialogs.autonomousGoal.replanning"
                      : "dialogs.autonomousGoal.starting",
                  )
                : agt(
                    t,
                    editingSession
                      ? "dialogs.autonomousGoal.saveAndReplan"
                      : "dialogs.autonomousGoal.start",
                  )}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}
