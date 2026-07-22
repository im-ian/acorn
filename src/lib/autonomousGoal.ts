import type {
  SessionAgentProvider,
  SessionGoal,
  SessionGoalModelConfig,
  SessionGoalModelSelection,
  SessionGoalPolicies,
} from "./types";
import type { SessionCreateScope } from "./sessionCreation";

export const AUTONOMOUS_GOAL_PRESET_STORAGE_KEY =
  "acorn:autonomous-goal-presets:v2";
export const AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY =
  "acorn:autonomous-goal-model-presets:v2";
const LEGACY_AUTONOMOUS_GOAL_PRESET_STORAGE_KEY =
  "acorn:autonomous-goal-presets:v1";
const LEGACY_AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY =
  "acorn:autonomous-goal-model-presets:v1";
export const NEW_AUTONOMOUS_GOAL_SESSION_EVENT =
  "acorn:new-autonomous-goal-session";
export const EDIT_AUTONOMOUS_GOAL_SESSION_EVENT =
  "acorn:edit-autonomous-goal-session";

export interface NewAutonomousGoalSessionEventDetail {
  scope?: SessionCreateScope;
}

export function requestNewAutonomousGoalSession(
  scope?: SessionCreateScope,
): void {
  window.dispatchEvent(
    new CustomEvent<NewAutonomousGoalSessionEventDetail>(
      NEW_AUTONOMOUS_GOAL_SESSION_EVENT,
      { detail: { scope } },
    ),
  );
}

export const AUTONOMOUS_GOAL_STAGE_IDS = [
  "plan",
  "implementation",
  "validation",
  "autoFix",
  "selfReview",
  "openPr",
  "merge",
] as const;

export type AutonomousGoalStage = (typeof AUTONOMOUS_GOAL_STAGE_IDS)[number];
export type AutonomousGoalStagePolicy = "auto" | "approval" | "disabled";
export type AutonomousGoalProvider = Extract<
  SessionAgentProvider,
  "claude" | "codex"
>;

export type AutonomousGoalPolicies = Record<
  AutonomousGoalStage,
  AutonomousGoalStagePolicy
>;

export const AUTONOMOUS_GOAL_STAGE_MODEL_KEYS: Record<
  AutonomousGoalStage,
  keyof SessionGoalModelConfig["stages"]
> = {
  plan: "plan",
  implementation: "implementation",
  validation: "validation",
  autoFix: "auto_fix",
  selfReview: "self_review",
  openPr: "open_pr",
  merge: "merge",
};

export interface AutonomousGoalPreset {
  id: string;
  name: string;
  builtIn: boolean;
  policies: AutonomousGoalPolicies;
}

export interface CustomAutonomousGoalPreset extends AutonomousGoalPreset {
  builtIn: false;
}

export interface AutonomousGoalPreferences {
  schemaVersion: 2;
  customPresets: CustomAutonomousGoalPreset[];
  /**
   * `null` means the user has never selected a preset. A non-null value that
   * no longer resolves is a stale binding and intentionally falls back to the
   * balanced preset.
   */
  lastPresetId: string | null;
}

export interface AutonomousGoalModelPreset {
  id: string;
  name: string;
  builtIn: boolean;
  provider: AutonomousGoalProvider;
  modelConfig: SessionGoalModelConfig;
}

export interface CustomAutonomousGoalModelPreset
  extends AutonomousGoalModelPreset {
  builtIn: false;
}

export interface AutonomousGoalModelPreferences {
  schemaVersion: 2;
  customPresets: CustomAutonomousGoalModelPreset[];
  lastPresetId: string | null;
}

export interface AutonomousGoalInput {
  goal: string;
  completionCriteria?: string;
  constraints?: string;
  tests?: string;
}

function optionalGoalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizedModelSelection(
  selection: SessionGoalModelSelection | undefined,
): SessionGoalModelSelection {
  return {
    model: optionalGoalValue(selection?.model ?? undefined),
    effort: selection?.effort ?? undefined,
  };
}

export function createDefaultGoalModelConfig(): SessionGoalModelConfig {
  return {
    single_model: true,
    default: {},
    stages: {
      plan: {},
      implementation: {},
      validation: {},
      auto_fix: {},
      self_review: {},
      open_pr: {},
      merge: {},
    },
  };
}

export function cloneGoalModelConfig(
  config: SessionGoalModelConfig | null | undefined,
): SessionGoalModelConfig {
  const source = config ?? createDefaultGoalModelConfig();
  return {
    single_model: source.single_model,
    default: normalizedModelSelection(source.default),
    stages: {
      plan: normalizedModelSelection(source.stages.plan),
      implementation: normalizedModelSelection(source.stages.implementation),
      validation: normalizedModelSelection(source.stages.validation),
      auto_fix: normalizedModelSelection(source.stages.auto_fix),
      self_review: normalizedModelSelection(source.stages.self_review),
      open_pr: normalizedModelSelection(source.stages.open_pr),
      merge: normalizedModelSelection(source.stages.merge),
    },
  };
}

function sessionGoalPolicies(
  policies: AutonomousGoalPolicies,
): SessionGoalPolicies {
  return {
    plan: policies.plan,
    implementation: policies.implementation,
    validation: policies.validation,
    auto_fix: policies.autoFix,
    self_review: policies.selfReview,
    open_pr: policies.openPr,
    merge: policies.merge,
  };
}

function autonomousGoalPolicies(
  policies: SessionGoalPolicies,
): AutonomousGoalPolicies {
  return {
    plan: policies.plan,
    implementation: policies.implementation,
    validation: policies.validation,
    autoFix: policies.auto_fix,
    selfReview: policies.self_review,
    openPr: policies.open_pr,
    merge: policies.merge,
  };
}

export function createSessionGoal(
  input: AutonomousGoalInput,
  provider: AutonomousGoalProvider,
  preset: AutonomousGoalPreset,
  revision = 1,
  modelConfig: SessionGoalModelConfig = createDefaultGoalModelConfig(),
): SessionGoal {
  const objective = input.goal.trim();
  if (!objective) throw new Error("A goal is required.");
  return {
    objective,
    completion_criteria: optionalGoalValue(input.completionCriteria),
    constraints: optionalGoalValue(input.constraints),
    tests: optionalGoalValue(input.tests),
    provider,
    preset: {
      id: preset.id,
      name: preset.name,
      policies: sessionGoalPolicies(preset.policies),
    },
    model_config: cloneGoalModelConfig(modelConfig),
    progress: {
      current_stage: "plan",
      state: "pending",
      revision_review: false,
      approval_pending: false,
    },
    revision,
  };
}

export function autonomousPresetFromSessionGoal(
  goal: SessionGoal,
  id = goal.preset.id,
  name = goal.preset.name,
): AutonomousGoalPreset {
  return {
    id,
    name,
    builtIn: true,
    policies: autonomousGoalPolicies(goal.preset.policies),
  };
}

export const REVIEW_AUTONOMOUS_GOAL_PRESET_ID = "builtin:review";
export const BALANCED_AUTONOMOUS_GOAL_PRESET_ID = "builtin:balanced";
export const FULL_AUTONOMY_GOAL_PRESET_ID = "builtin:full-autonomy";
export const CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID =
  "builtin:model:codex-default";
export const CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID =
  "builtin:model:claude-default";

const STAGE_POLICY_VALUES = new Set<AutonomousGoalStagePolicy>([
  "auto",
  "approval",
  "disabled",
]);

const BUILTIN_PRESET_IDS = new Set([
  REVIEW_AUTONOMOUS_GOAL_PRESET_ID,
  BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
  FULL_AUTONOMY_GOAL_PRESET_ID,
]);

const BUILTIN_MODEL_PRESET_IDS = new Set([
  CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
  CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
]);

function immutablePolicies(
  policies: AutonomousGoalPolicies,
): AutonomousGoalPolicies {
  return Object.freeze({ ...policies });
}

function immutableBuiltinPreset(
  id: string,
  name: string,
  policies: AutonomousGoalPolicies,
): AutonomousGoalPreset {
  return Object.freeze({
    id,
    name,
    builtIn: true,
    policies: immutablePolicies(policies),
  });
}

export const REVIEW_AUTONOMOUS_GOAL_PRESET = immutableBuiltinPreset(
  REVIEW_AUTONOMOUS_GOAL_PRESET_ID,
  "Review-centered",
  {
    plan: "approval",
    implementation: "approval",
    validation: "auto",
    autoFix: "approval",
    selfReview: "auto",
    openPr: "approval",
    merge: "approval",
  },
);

export const BALANCED_AUTONOMOUS_GOAL_PRESET = immutableBuiltinPreset(
  BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
  "Balanced",
  {
    plan: "approval",
    implementation: "auto",
    validation: "auto",
    autoFix: "auto",
    selfReview: "auto",
    openPr: "approval",
    merge: "approval",
  },
);

export const FULL_AUTONOMY_GOAL_PRESET = immutableBuiltinPreset(
  FULL_AUTONOMY_GOAL_PRESET_ID,
  "Full autonomy",
  {
    plan: "auto",
    implementation: "auto",
    validation: "auto",
    autoFix: "auto",
    selfReview: "auto",
    openPr: "auto",
    merge: "auto",
  },
);

export const BUILTIN_AUTONOMOUS_GOAL_PRESETS = Object.freeze([
  REVIEW_AUTONOMOUS_GOAL_PRESET,
  BALANCED_AUTONOMOUS_GOAL_PRESET,
  FULL_AUTONOMY_GOAL_PRESET,
]);

function immutableModelSelection(
  selection: SessionGoalModelSelection,
): SessionGoalModelSelection {
  return Object.freeze({ ...selection });
}

function immutableModelConfig(
  config: SessionGoalModelConfig,
): SessionGoalModelConfig {
  const cloned = cloneGoalModelConfig(config);
  return Object.freeze({
    single_model: cloned.single_model,
    default: immutableModelSelection(cloned.default),
    stages: Object.freeze({
      plan: immutableModelSelection(cloned.stages.plan),
      implementation: immutableModelSelection(cloned.stages.implementation),
      validation: immutableModelSelection(cloned.stages.validation),
      auto_fix: immutableModelSelection(cloned.stages.auto_fix),
      self_review: immutableModelSelection(cloned.stages.self_review),
      open_pr: immutableModelSelection(cloned.stages.open_pr),
      merge: immutableModelSelection(cloned.stages.merge),
    }),
  });
}

function immutableBuiltinModelPreset(
  id: string,
  name: string,
  provider: AutonomousGoalProvider,
): AutonomousGoalModelPreset {
  return Object.freeze({
    id,
    name,
    builtIn: true,
    provider,
    modelConfig: immutableModelConfig(createDefaultGoalModelConfig()),
  });
}

export const CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET =
  immutableBuiltinModelPreset(
    CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
    "Codex · Default",
    "codex",
  );

export const CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET =
  immutableBuiltinModelPreset(
    CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
    "Claude · Default",
    "claude",
  );

export const BUILTIN_AUTONOMOUS_GOAL_MODEL_PRESETS = Object.freeze([
  CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET,
  CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET,
]);

const EMPTY_PREFERENCES: AutonomousGoalPreferences = {
  schemaVersion: 2,
  customPresets: [],
  lastPresetId: null,
};

const EMPTY_MODEL_PREFERENCES: AutonomousGoalModelPreferences = {
  schemaVersion: 2,
  customPresets: [],
  lastPresetId: null,
};

function clonePolicies(
  policies: Readonly<AutonomousGoalPolicies>,
): AutonomousGoalPolicies {
  return { ...policies };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePolicies(value: unknown): AutonomousGoalPolicies | null {
  if (!isRecord(value)) return null;
  const policies = {} as AutonomousGoalPolicies;
  for (const stage of AUTONOMOUS_GOAL_STAGE_IDS) {
    const policy =
      stage === "openPr"
        ? (value.openPr ?? value.draftPr)
        : stage === "merge"
          ? (value.merge ?? "disabled")
          : value[stage];
    if (
      typeof policy !== "string" ||
      !STAGE_POLICY_VALUES.has(policy as AutonomousGoalStagePolicy)
    ) {
      return null;
    }
    policies[stage] = policy as AutonomousGoalStagePolicy;
  }
  return policies;
}

function sanitizeCustomPreset(
  value: unknown,
): CustomAutonomousGoalPreset | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const policies = sanitizePolicies(value.policies);
  if (!id || !name || BUILTIN_PRESET_IDS.has(id) || !policies) return null;
  return { id, name, builtIn: false, policies };
}

function sanitizeModelSelection(
  value: unknown,
): SessionGoalModelSelection | null {
  if (!isRecord(value)) return null;
  if (
    value.model !== undefined &&
    value.model !== null &&
    typeof value.model !== "string"
  ) {
    return null;
  }
  if (
    value.effort !== undefined &&
    value.effort !== null &&
    typeof value.effort !== "string"
  ) {
    return null;
  }
  return normalizedModelSelection({
    model: typeof value.model === "string" ? value.model : undefined,
    effort:
      typeof value.effort === "string"
        ? optionalGoalValue(value.effort)
        : undefined,
  });
}

function sanitizeModelConfig(value: unknown): SessionGoalModelConfig | null {
  if (
    !isRecord(value) ||
    typeof value.single_model !== "boolean" ||
    !isRecord(value.stages)
  ) {
    return null;
  }
  const defaultSelection = sanitizeModelSelection(value.default);
  const plan = sanitizeModelSelection(value.stages.plan);
  const implementation = sanitizeModelSelection(value.stages.implementation);
  const validation = sanitizeModelSelection(value.stages.validation);
  const autoFix = sanitizeModelSelection(value.stages.auto_fix);
  const selfReview = sanitizeModelSelection(value.stages.self_review);
  const openPr = sanitizeModelSelection(
    value.stages.open_pr ?? value.stages.draft_pr,
  );
  const merge = sanitizeModelSelection(value.stages.merge ?? {});
  if (
    !defaultSelection ||
    !plan ||
    !implementation ||
    !validation ||
    !autoFix ||
    !selfReview ||
    !openPr ||
    !merge
  ) {
    return null;
  }
  return {
    single_model: value.single_model,
    default: defaultSelection,
    stages: {
      plan,
      implementation,
      validation,
      auto_fix: autoFix,
      self_review: selfReview,
      open_pr: openPr,
      merge,
    },
  };
}

function sanitizeCustomModelPreset(
  value: unknown,
): CustomAutonomousGoalModelPreset | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const provider = value.provider;
  const modelConfig = sanitizeModelConfig(value.modelConfig);
  if (
    !id ||
    !name ||
    BUILTIN_MODEL_PRESET_IDS.has(id) ||
    (provider !== "codex" && provider !== "claude") ||
    !modelConfig
  ) {
    return null;
  }
  return { id, name, builtIn: false, provider, modelConfig };
}

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadAutonomousGoalPreferences(): AutonomousGoalPreferences {
  const storage = storageOrNull();
  if (!storage) return { ...EMPTY_PREFERENCES, customPresets: [] };
  try {
    const raw =
      storage.getItem(AUTONOMOUS_GOAL_PRESET_STORAGE_KEY) ??
      storage.getItem(LEGACY_AUTONOMOUS_GOAL_PRESET_STORAGE_KEY);
    if (!raw) return { ...EMPTY_PREFERENCES, customPresets: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { ...EMPTY_PREFERENCES, customPresets: [] };
    }
    const seenIds = new Set<string>();
    const customPresets = Array.isArray(parsed.customPresets)
      ? parsed.customPresets.flatMap((candidate) => {
          const preset = sanitizeCustomPreset(candidate);
          if (!preset || seenIds.has(preset.id)) return [];
          seenIds.add(preset.id);
          return [preset];
        })
      : [];
    return {
      schemaVersion: 2,
      customPresets,
      lastPresetId:
        typeof parsed.lastPresetId === "string"
          ? parsed.lastPresetId
          : null,
    };
  } catch {
    return { ...EMPTY_PREFERENCES, customPresets: [] };
  }
}

export function saveAutonomousGoalPreferences(
  preferences: AutonomousGoalPreferences,
): void {
  const storage = storageOrNull();
  if (!storage) return;
  try {
    storage.setItem(
      AUTONOMOUS_GOAL_PRESET_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        customPresets: preferences.customPresets,
        lastPresetId: preferences.lastPresetId,
      } satisfies AutonomousGoalPreferences),
    );
  } catch {
    // Presets are a convenience setting; a blocked or full storage area must
    // not prevent the user from starting a goal session.
  }
}

export function loadAutonomousGoalModelPreferences(
): AutonomousGoalModelPreferences {
  const storage = storageOrNull();
  if (!storage) return { ...EMPTY_MODEL_PREFERENCES, customPresets: [] };
  try {
    const raw =
      storage.getItem(AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY) ??
      storage.getItem(LEGACY_AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY);
    if (!raw) return { ...EMPTY_MODEL_PREFERENCES, customPresets: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { ...EMPTY_MODEL_PREFERENCES, customPresets: [] };
    }
    const seenIds = new Set<string>();
    const customPresets = Array.isArray(parsed.customPresets)
      ? parsed.customPresets.flatMap((candidate) => {
          const preset = sanitizeCustomModelPreset(candidate);
          if (!preset || seenIds.has(preset.id)) return [];
          seenIds.add(preset.id);
          return [preset];
        })
      : [];
    return {
      schemaVersion: 2,
      customPresets,
      lastPresetId:
        typeof parsed.lastPresetId === "string" ? parsed.lastPresetId : null,
    };
  } catch {
    return { ...EMPTY_MODEL_PREFERENCES, customPresets: [] };
  }
}

export function saveAutonomousGoalModelPreferences(
  preferences: AutonomousGoalModelPreferences,
): void {
  const storage = storageOrNull();
  if (!storage) return;
  try {
    storage.setItem(
      AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        customPresets: preferences.customPresets,
        lastPresetId: preferences.lastPresetId,
      } satisfies AutonomousGoalModelPreferences),
    );
  } catch {
    // Model presets are optional convenience state and must never block Goal
    // session creation when local storage is unavailable.
  }
}

export function listAutonomousGoalPresets(
  preferences: AutonomousGoalPreferences,
): AutonomousGoalPreset[] {
  return [...BUILTIN_AUTONOMOUS_GOAL_PRESETS, ...preferences.customPresets];
}

export function findAutonomousGoalPreset(
  preferences: AutonomousGoalPreferences,
  presetId: string,
): AutonomousGoalPreset | null {
  return (
    listAutonomousGoalPresets(preferences).find(
      (preset) => preset.id === presetId,
    ) ?? null
  );
}

export function resolveInitialAutonomousGoalPresetId(
  preferences: AutonomousGoalPreferences,
): string {
  if (preferences.lastPresetId === null) {
    return FULL_AUTONOMY_GOAL_PRESET_ID;
  }
  return findAutonomousGoalPreset(preferences, preferences.lastPresetId)
    ? preferences.lastPresetId
    : BALANCED_AUTONOMOUS_GOAL_PRESET_ID;
}

export function createCustomAutonomousGoalPreset(
  source: AutonomousGoalPreset,
  id: string,
  name: string,
): CustomAutonomousGoalPreset {
  const trimmedId = id.trim();
  const trimmedName = name.trim();
  if (!trimmedId || BUILTIN_PRESET_IDS.has(trimmedId)) {
    throw new Error("A custom preset requires a unique custom id.");
  }
  if (!trimmedName) {
    throw new Error("A custom preset requires a name.");
  }
  return {
    id: trimmedId,
    name: trimmedName,
    builtIn: false,
    policies: clonePolicies(source.policies),
  };
}

export function deleteCustomAutonomousGoalPreset(
  preferences: AutonomousGoalPreferences,
  presetId: string,
): AutonomousGoalPreferences {
  const nextPresets = preferences.customPresets.filter(
    (preset) => preset.id !== presetId,
  );
  if (nextPresets.length === preferences.customPresets.length) {
    return preferences;
  }
  return {
    ...preferences,
    customPresets: nextPresets,
    lastPresetId:
      preferences.lastPresetId === presetId
        ? BALANCED_AUTONOMOUS_GOAL_PRESET_ID
        : preferences.lastPresetId,
  };
}

export function defaultAutonomousGoalModelPresetId(
  provider: AutonomousGoalProvider,
): string {
  return provider === "claude"
    ? CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID
    : CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID;
}

export function builtinAutonomousGoalModelPresetForProvider(
  provider: AutonomousGoalProvider,
): AutonomousGoalModelPreset {
  return provider === "claude"
    ? CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET
    : CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET;
}

export function listAutonomousGoalModelPresets(
  preferences: AutonomousGoalModelPreferences,
): AutonomousGoalModelPreset[] {
  return [
    ...BUILTIN_AUTONOMOUS_GOAL_MODEL_PRESETS,
    ...preferences.customPresets,
  ];
}

export function findAutonomousGoalModelPreset(
  preferences: AutonomousGoalModelPreferences,
  presetId: string,
): AutonomousGoalModelPreset | null {
  return (
    listAutonomousGoalModelPresets(preferences).find(
      (preset) => preset.id === presetId,
    ) ?? null
  );
}

export function resolveInitialAutonomousGoalModelPresetId(
  preferences: AutonomousGoalModelPreferences,
  defaultProvider: AutonomousGoalProvider,
): string {
  if (
    preferences.lastPresetId &&
    findAutonomousGoalModelPreset(preferences, preferences.lastPresetId)
  ) {
    return preferences.lastPresetId;
  }
  return defaultAutonomousGoalModelPresetId(defaultProvider);
}

export function createCustomAutonomousGoalModelPreset(
  source: AutonomousGoalModelPreset,
  id: string,
  name: string,
): CustomAutonomousGoalModelPreset {
  const trimmedId = id.trim();
  const trimmedName = name.trim();
  if (!trimmedId || BUILTIN_MODEL_PRESET_IDS.has(trimmedId)) {
    throw new Error("A custom model preset requires a unique custom id.");
  }
  if (!trimmedName) {
    throw new Error("A custom model preset requires a name.");
  }
  return {
    id: trimmedId,
    name: trimmedName,
    builtIn: false,
    provider: source.provider,
    modelConfig: cloneGoalModelConfig(source.modelConfig),
  };
}

export function deleteCustomAutonomousGoalModelPreset(
  preferences: AutonomousGoalModelPreferences,
  presetId: string,
): AutonomousGoalModelPreferences {
  const removed = preferences.customPresets.find(
    (preset) => preset.id === presetId,
  );
  if (!removed) return preferences;
  return {
    ...preferences,
    customPresets: preferences.customPresets.filter(
      (preset) => preset.id !== presetId,
    ),
    lastPresetId:
      preferences.lastPresetId === presetId
        ? defaultAutonomousGoalModelPresetId(removed.provider)
        : preferences.lastPresetId,
  };
}

export function deriveAutonomousGoalSessionName(goal: string): string {
  const firstMeaningfulLine =
    goal
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "Autonomous goal";
  const compact =
    firstMeaningfulLine.replace(/^#+\s*/u, "").replace(/\s+/gu, " ") ||
    "Autonomous goal";
  const maxGoalLength = 48;
  const summary =
    compact.length > maxGoalLength
      ? `${compact.slice(0, maxGoalLength - 1).trimEnd()}…`
      : compact;
  return `Goal · ${summary}`;
}
