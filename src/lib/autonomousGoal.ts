import type {
  SessionAgentProvider,
  SessionGoal,
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

export interface AutonomousGoalPromptOptions extends AutonomousGoalInput {
  provider: AutonomousGoalProvider;
  preset: AutonomousGoalPreset;
}

function optionalGoalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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

export function buildPromptForSessionGoal(goal: SessionGoal): string {
  return buildAutonomousGoalPrompt({
    goal: goal.objective,
    completionCriteria: goal.completion_criteria ?? undefined,
    constraints: goal.constraints ?? undefined,
    tests: goal.tests ?? undefined,
    provider: goal.provider,
    preset: autonomousPresetFromSessionGoal(goal),
  });
}

export function buildAutonomousGoalRevisionPrompt(
  previous: SessionGoal,
  next: SessionGoal,
): string {
  return [
    `# Acorn goal revision ${next.revision}`,
    "",
    `This project goal session was paused so its durable goal could be revised. Revision ${next.revision} supersedes revision ${previous.revision}; treat the revised specification below as authoritative.`,
    "",
    "## Previous objective",
    previous.objective,
    "",
    buildPromptForSessionGoal(next),
    "",
    "## Revision protocol",
    "Compare the revised goal with the previous objective and the work already present in this project worktree. Explain what remains valid, what scope changed, and the revised plan. Do not resume implementation in this response, even when the selected Plan policy is AUTO. End with `WAITING:` and ask for confirmation of the revised plan. Resume only after the user confirms in this chat.",
  ].join("\n");
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

const STAGE_PROMPT_LABELS: Record<AutonomousGoalStage, string> = {
  interpretation: "Interpretation",
  plan: "Plan",
  implementation: "Implementation",
  validation: "Validation",
  autoFix: "Automatic fixes",
  selfReview: "Self-review",
  draftPr: "Draft PR preparation",
};

const POLICY_PROMPT_LABELS: Record<AutonomousGoalStagePolicy, string> = {
  auto: "AUTO — proceed without asking",
  approval: "APPROVAL — prepare a reviewable proposal, then ask for confirmation",
  disabled: "DISABLED — skip this stage and report that it was skipped",
};

function optionalPromptSection(label: string, value: string | undefined) {
  const trimmed = value?.trim();
  return `## ${label}\n${trimmed || "Not provided — infer a reasonable answer from the goal and repository, and state important assumptions."}`;
}

export function buildAutonomousGoalPrompt({
  goal,
  completionCriteria,
  constraints,
  tests,
  provider,
  preset,
}: AutonomousGoalPromptOptions): string {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) throw new Error("A goal is required.");

  const policySnapshot = AUTONOMOUS_GOAL_STAGE_IDS.map(
    (stage) =>
      `- ${STAGE_PROMPT_LABELS[stage]}: ${POLICY_PROMPT_LABELS[preset.policies[stage]]}`,
  ).join("\n");

  return [
    "# Acorn autonomous goal session",
    "",
    "Carry out the goal below in this isolated worktree. Work autonomously whenever the policy snapshot permits it, and follow every repository instruction file that applies.",
    "",
    "## Goal",
    trimmedGoal,
    "",
    optionalPromptSection("Completion criteria", completionCriteria),
    "",
    optionalPromptSection("Constraints", constraints),
    "",
    optionalPromptSection("Tests", tests),
    "",
    "## Execution policy snapshot",
    `Preset: ${preset.name}`,
    `Provider: ${provider} (fixed for this session; do not switch providers automatically)`,
    policySnapshot,
    "",
    "For an APPROVAL stage, prepare enough of that stage to make the interpretation, plan, review, or intended action reviewable, but do not perform its side-effecting actions or enter the next stage. Then stop and respond with `WAITING:` followed by the exact decision you need. Continue only after the user replies in this chat. Do not ask for confirmation during an AUTO stage unless progress is impossible without credentials, permissions, an externally consequential choice, or missing information that cannot be inferred safely.",
    "",
    "## Operating rules",
    "- Treat only references explicitly written in the goal or optional fields as task references. Do not search for or select a GitHub issue merely because one may exist.",
    "- You may perform destructive local changes only when they are explicitly requested by the goal. Otherwise stop before them and use `WAITING:`.",
    "- This prototype authorizes work inside the isolated worktree only. Do not push, create or update a pull request, merge, deploy, release, publish, or incur additional external cost. Draft PR preparation means preparing a proposed title/body and reporting readiness, not creating the PR.",
    "- If the user pauses the run and revises the goal in a later chat message, stop the old plan, treat the latest revision as authoritative, explain the scope and plan changes, and respond with `WAITING:` for confirmation before resuming implementation.",
    "- Validate in proportion to the change. During automatic fixes, do not use a fixed total attempt limit. Stop with `WAITING:` when the same or meaning-equivalent validation failure has made no meaningful progress for two consecutive fix attempts. Meaningful progress means eliminating the original failure, reducing the failure set/count/severity, or producing materially more actionable diagnostics; renaming code or changing only a failure fingerprint does not count.",
    "- Keep the work within the stated goal. If omitted fields were inferred, call out material assumptions in the final response.",
    "- Finish with a concise summary of changes, validation performed and results, remaining risks, and any skipped or blocked policy stages.",
  ].join("\n");
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
