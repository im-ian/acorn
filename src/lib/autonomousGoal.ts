import type {
  SessionAgentProvider,
  SessionGoal,
  SessionGoalModelConfig,
  SessionGoalModelSelection,
  SessionGoalPolicies,
} from "./types";

export const AUTONOMOUS_GOAL_PRESET_STORAGE_KEY =
  "acorn:autonomous-goal-presets:v1";
export const EDIT_AUTONOMOUS_GOAL_SESSION_EVENT =
  "acorn:edit-autonomous-goal-session";

export const AUTONOMOUS_GOAL_STAGE_IDS = [
  "interpretation",
  "plan",
  "implementation",
  "validation",
  "autoFix",
  "selfReview",
  "draftPr",
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
  interpretation: "interpretation",
  plan: "plan",
  implementation: "implementation",
  validation: "validation",
  autoFix: "auto_fix",
  selfReview: "self_review",
  draftPr: "draft_pr",
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
  schemaVersion: 1;
  customPresets: CustomAutonomousGoalPreset[];
  /**
   * `null` means the user has never selected a preset. A non-null value that
   * no longer resolves is a stale binding and intentionally falls back to the
   * balanced preset.
   */
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
      interpretation: {},
      plan: {},
      implementation: {},
      validation: {},
      auto_fix: {},
      self_review: {},
      draft_pr: {},
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
      interpretation: normalizedModelSelection(source.stages.interpretation),
      plan: normalizedModelSelection(source.stages.plan),
      implementation: normalizedModelSelection(source.stages.implementation),
      validation: normalizedModelSelection(source.stages.validation),
      auto_fix: normalizedModelSelection(source.stages.auto_fix),
      self_review: normalizedModelSelection(source.stages.self_review),
      draft_pr: normalizedModelSelection(source.stages.draft_pr),
    },
  };
}

function sessionGoalPolicies(
  policies: AutonomousGoalPolicies,
): SessionGoalPolicies {
  return {
    interpretation: policies.interpretation,
    plan: policies.plan,
    implementation: policies.implementation,
    validation: policies.validation,
    auto_fix: policies.autoFix,
    self_review: policies.selfReview,
    draft_pr: policies.draftPr,
  };
}

function autonomousGoalPolicies(
  policies: SessionGoalPolicies,
): AutonomousGoalPolicies {
  return {
    interpretation: policies.interpretation,
    plan: policies.plan,
    implementation: policies.implementation,
    validation: policies.validation,
    autoFix: policies.auto_fix,
    selfReview: policies.self_review,
    draftPr: policies.draft_pr,
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
      current_stage: "interpretation",
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
    interpretation: "approval",
    plan: "approval",
    implementation: "approval",
    validation: "auto",
    autoFix: "approval",
    selfReview: "auto",
    draftPr: "approval",
  },
);

export const BALANCED_AUTONOMOUS_GOAL_PRESET = immutableBuiltinPreset(
  BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
  "Balanced",
  {
    interpretation: "auto",
    plan: "approval",
    implementation: "auto",
    validation: "auto",
    autoFix: "auto",
    selfReview: "auto",
    draftPr: "approval",
  },
);

export const FULL_AUTONOMY_GOAL_PRESET = immutableBuiltinPreset(
  FULL_AUTONOMY_GOAL_PRESET_ID,
  "Full autonomy",
  {
    interpretation: "auto",
    plan: "auto",
    implementation: "auto",
    validation: "auto",
    autoFix: "auto",
    selfReview: "auto",
    draftPr: "auto",
  },
);

export const BUILTIN_AUTONOMOUS_GOAL_PRESETS = Object.freeze([
  REVIEW_AUTONOMOUS_GOAL_PRESET,
  BALANCED_AUTONOMOUS_GOAL_PRESET,
  FULL_AUTONOMY_GOAL_PRESET,
]);

const EMPTY_PREFERENCES: AutonomousGoalPreferences = {
  schemaVersion: 1,
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
    const policy = value[stage];
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
    const raw = storage.getItem(AUTONOMOUS_GOAL_PRESET_STORAGE_KEY);
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
      schemaVersion: 1,
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
        schemaVersion: 1,
        customPresets: preferences.customPresets,
        lastPresetId: preferences.lastPresetId,
      } satisfies AutonomousGoalPreferences),
    );
  } catch {
    // Presets are a convenience setting; a blocked or full storage area must
    // not prevent the user from starting a goal session.
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
