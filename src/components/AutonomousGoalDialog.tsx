import { Copy, Plus, Sparkles, Trash2 } from "lucide-react";
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
  FULL_AUTONOMY_GOAL_PRESET_ID,
  REVIEW_AUTONOMOUS_GOAL_PRESET_ID,
  buildAutonomousGoalPrompt,
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
import { resolveAiExecutionRequest, useSettings } from "../lib/settings";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import {
  Button,
  Field,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  Select,
  TextInput,
  TEXT_INPUT_CLASS,
} from "./ui";

interface AutonomousGoalDialogProps {
  open: boolean;
  scope: SessionCreateScope | null;
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
  onClose,
}: AutonomousGoalDialogProps) {
  const t = useTranslation();
  const titleId = useId();
  const showToast = useToasts((state) => state.show);
  const settings = useSettings((state) => state.settings);
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const loaded = loadAutonomousGoalPreferences();
    const initialPresetId = resolveInitialAutonomousGoalPresetId(loaded);
    const initialPreset = findAutonomousGoalPreset(loaded, initialPresetId);
    preferencesRef.current = loaded;
    setPreferences(loaded);
    setSelectedPresetId(initialPresetId);
    setPresetNameDraft(initialPreset?.builtIn ? "" : (initialPreset?.name ?? ""));
    setProvider(defaultProvider(useSettings.getState().settings.agents.selected));
    setGoal("");
    setCompletionCriteria("");
    setConstraints("");
    setTests("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const presets = useMemo(
    () => listAutonomousGoalPresets(preferences),
    [preferences],
  );
  const selectedPreset = useMemo(
    () => findAutonomousGoalPreset(preferences, selectedPresetId),
    [preferences, selectedPresetId],
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

  function close() {
    if (!submitting) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    let currentPreferences = preferencesRef.current;
    let currentPreset = findAutonomousGoalPreset(
      currentPreferences,
      selectedPresetId,
    );
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
    const presetSnapshot: AutonomousGoalPreset = {
      ...currentPreset,
      name: presetDisplayName(t, currentPreset),
      policies: { ...currentPreset.policies },
    };

    try {
      const created = scope
        ? await applySessionCreateRequest(
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
              },
            ),
          )
        : await api.createSessionFromDialog(
            sessionName,
            true,
            "regular",
            provider,
            true,
            agt(t, "dialogs.autonomousGoal.selectRepository"),
            "chat",
          );

      if (!created) {
        if (scope) {
          const storeError = useAppStore.getState().consumeError();
          if (storeError) setError(storeError);
        }
        setSubmitting(false);
        return;
      }

      if (!scope) {
        await useAppStore.getState().refreshAll();
        useAppStore.getState().selectSession(created.id);
      }

      const nextPreferences = {
        ...currentPreferences,
        lastPresetId: currentPreset.id,
      } satisfies AutonomousGoalPreferences;
      saveAutonomousGoalPreferences(nextPreferences);

      const prompt = buildAutonomousGoalPrompt({
        goal: trimmedGoal,
        completionCriteria,
        constraints,
        tests,
        provider,
        preset: presetSnapshot,
      });
      onClose();
      showToast(
        formatToast(t("toasts.autonomousGoal.started"), sessionName),
      );
      markLocalGoalSessionWorking(created.id);

      void api
        .sendChatMessage(
          created.id,
          { ...resolveAiExecutionRequest(settings), provider },
          prompt,
        )
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
            console.error("autonomous goal session failed", sendError);
            try {
              await api.setSessionStatus(created.id, "errored");
              await useAppStore.getState().refreshSessions();
            } catch (statusError) {
              console.error(
                "failed to mark goal session as errored",
                statusError,
              );
            }
            showToast(
              `${t("toasts.autonomousGoal.startFailed")} ${String(sendError)}`,
            );
          },
        );
    } catch (submitError) {
      console.error("create autonomous goal session failed", submitError);
      setError(String(submitError));
      setSubmitting(false);
    }
  }

  const presetOptions = presets.map((preset) => ({
    value: preset.id,
    label: presetDisplayName(t, preset),
    description: preset.builtIn
      ? agt(t, "dialogs.autonomousGoal.presets.builtIn")
      : agt(t, "dialogs.autonomousGoal.presets.custom"),
  }));
  const policyOptions = (["auto", "approval", "disabled"] as const).map(
    (policy) => ({
      value: policy,
      label: agt(t, POLICY_TRANSLATION_KEYS[policy]),
    }),
  );

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
          title={agt(t, "dialogs.autonomousGoal.title")}
          subtitle={agt(t, "dialogs.autonomousGoal.subtitle")}
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

              <div className="grid gap-3 sm:grid-cols-2">
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

              <Field
                label={agt(t, "dialogs.autonomousGoal.provider.label")}
                hint={agt(t, "dialogs.autonomousGoal.provider.hint")}
              >
                <Select
                  value={provider}
                  onValueChange={(value) =>
                    setProvider(value as AutonomousGoalProvider)
                  }
                  options={[
                    { value: "codex", label: "Codex" },
                    { value: "claude", label: "Claude" },
                  ]}
                />
              </Field>

              <Notice tone="info" density="compact">
                {agt(t, "dialogs.autonomousGoal.prototypeNotice")}
              </Notice>
            </section>

            <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-bg-sidebar/35 p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
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
                </div>
              </div>

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
                    onChange={(event) => setPresetNameDraft(event.target.value)}
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
            {agt(t, "dialogs.autonomousGoal.footerHint")}
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
                ? agt(t, "dialogs.autonomousGoal.starting")
                : agt(t, "dialogs.autonomousGoal.start")}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}
