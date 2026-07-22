import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_GOAL_STAGE_IDS,
  AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
  AUTONOMOUS_GOAL_PRESET_STORAGE_KEY,
  BALANCED_AUTONOMOUS_GOAL_PRESET,
  BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
  BUILTIN_AUTONOMOUS_GOAL_MODEL_PRESETS,
  BUILTIN_AUTONOMOUS_GOAL_PRESETS,
  CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
  CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET,
  CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
  FULL_AUTONOMY_GOAL_PRESET_ID,
  REVIEW_AUTONOMOUS_GOAL_PRESET,
  autonomousPresetFromSessionGoal,
  createCustomAutonomousGoalModelPreset,
  createSessionGoal,
  createCustomAutonomousGoalPreset,
  deleteCustomAutonomousGoalModelPreset,
  deleteCustomAutonomousGoalPreset,
  deriveAutonomousGoalSessionName,
  loadAutonomousGoalModelPreferences,
  loadAutonomousGoalPreferences,
  resolveInitialAutonomousGoalModelPresetId,
  resolveInitialAutonomousGoalPresetId,
  saveAutonomousGoalModelPreferences,
  saveAutonomousGoalPreferences,
  type AutonomousGoalModelPreferences,
  type AutonomousGoalPreferences,
} from "./autonomousGoal";

describe("autonomous goal presets", () => {
  beforeEach(() => window.localStorage.clear());

  it("ships three immutable policy presets", () => {
    expect(BUILTIN_AUTONOMOUS_GOAL_PRESETS).toHaveLength(3);
    expect(Object.isFrozen(BUILTIN_AUTONOMOUS_GOAL_PRESETS)).toBe(true);
    expect(Object.isFrozen(REVIEW_AUTONOMOUS_GOAL_PRESET)).toBe(true);
    expect(Object.isFrozen(REVIEW_AUTONOMOUS_GOAL_PRESET.policies)).toBe(true);
    expect(REVIEW_AUTONOMOUS_GOAL_PRESET.policies.autoFix).toBe("approval");
    expect(REVIEW_AUTONOMOUS_GOAL_PRESET.policies.merge).toBe("approval");
    expect(BALANCED_AUTONOMOUS_GOAL_PRESET.policies.plan).toBe("approval");
    expect(
      Object.values(
        BUILTIN_AUTONOMOUS_GOAL_PRESETS[2]?.policies ?? {},
      ),
    ).toEqual(Array(7).fill("auto"));
    expect(AUTONOMOUS_GOAL_STAGE_IDS).toEqual([
      "plan",
      "implementation",
      "validation",
      "autoFix",
      "selfReview",
      "openPr",
      "merge",
    ]);
  });

  it("defaults a first run to full autonomy and a stale binding to balanced", () => {
    const fresh = loadAutonomousGoalPreferences();
    expect(resolveInitialAutonomousGoalPresetId(fresh)).toBe(
      FULL_AUTONOMY_GOAL_PRESET_ID,
    );

    expect(
      resolveInitialAutonomousGoalPresetId({
        ...fresh,
        lastPresetId: "deleted:preset",
      }),
    ).toBe(BALANCED_AUTONOMOUS_GOAL_PRESET_ID);
  });

  it("duplicates a built-in as an independent custom snapshot", () => {
    const duplicate = createCustomAutonomousGoalPreset(
      REVIEW_AUTONOMOUS_GOAL_PRESET,
      "custom:review",
      "My review flow",
    );
    duplicate.policies.plan = "auto";

    expect(duplicate.builtIn).toBe(false);
    expect(duplicate.policies.plan).toBe("auto");
    expect(REVIEW_AUTONOMOUS_GOAL_PRESET.policies.plan).toBe("approval");
  });

  it("deletes only the selected custom preset and moves its stale binding", () => {
    const first = createCustomAutonomousGoalPreset(
      BALANCED_AUTONOMOUS_GOAL_PRESET,
      "custom:first",
      "First",
    );
    const second = createCustomAutonomousGoalPreset(
      first,
      "custom:second",
      "Second",
    );
    const preferences: AutonomousGoalPreferences = {
      schemaVersion: 2,
      customPresets: [first, second],
      lastPresetId: first.id,
    };

    const next = deleteCustomAutonomousGoalPreset(preferences, first.id);
    expect(next.customPresets).toEqual([second]);
    expect(next.lastPresetId).toBe(BALANCED_AUTONOMOUS_GOAL_PRESET_ID);
    expect(second.policies).toEqual(first.policies);
  });

  it("sanitizes malformed persisted presets without losing valid ones", () => {
    window.localStorage.setItem(
      AUTONOMOUS_GOAL_PRESET_STORAGE_KEY,
      JSON.stringify({
        customPresets: [
          {
            id: "custom:valid",
            name: "Valid",
            builtIn: true,
            policies: BALANCED_AUTONOMOUS_GOAL_PRESET.policies,
          },
          { id: "custom:broken", name: "Broken", policies: {} },
          {
            id: BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
            name: "Collision",
            policies: BALANCED_AUTONOMOUS_GOAL_PRESET.policies,
          },
        ],
        lastPresetId: "custom:valid",
      }),
    );

    const loaded = loadAutonomousGoalPreferences();
    expect(loaded.customPresets).toHaveLength(1);
    expect(loaded.customPresets[0]).toMatchObject({
      id: "custom:valid",
      name: "Valid",
      builtIn: false,
    });
    saveAutonomousGoalPreferences(loaded);
    expect(
      JSON.parse(
        window.localStorage.getItem(AUTONOMOUS_GOAL_PRESET_STORAGE_KEY) ??
          "null",
      ),
    ).toEqual(loaded);
  });

  it("migrates the previous interpretation and Draft PR policies safely", () => {
    window.localStorage.setItem(
      "acorn:autonomous-goal-presets:v1",
      JSON.stringify({
        schemaVersion: 1,
        customPresets: [
          {
            id: "custom:legacy",
            name: "Legacy",
            policies: {
              interpretation: "auto",
              plan: "approval",
              implementation: "auto",
              validation: "auto",
              autoFix: "auto",
              selfReview: "auto",
              draftPr: "approval",
            },
          },
        ],
        lastPresetId: "custom:legacy",
      }),
    );

    const loaded = loadAutonomousGoalPreferences();

    expect(loaded).toMatchObject({
      schemaVersion: 2,
      lastPresetId: "custom:legacy",
      customPresets: [
        {
          policies: {
            plan: "approval",
            implementation: "auto",
            validation: "auto",
            autoFix: "auto",
            selfReview: "auto",
            openPr: "approval",
            merge: "disabled",
          },
        },
      ],
    });
    saveAutonomousGoalPreferences(loaded);
    expect(
      window.localStorage.getItem(AUTONOMOUS_GOAL_PRESET_STORAGE_KEY),
    ).not.toBeNull();
  });
});

describe("autonomous goal model presets", () => {
  beforeEach(() => window.localStorage.clear());

  it("ships immutable agent-default presets for Codex and Claude", () => {
    expect(BUILTIN_AUTONOMOUS_GOAL_MODEL_PRESETS).toHaveLength(2);
    expect(Object.isFrozen(BUILTIN_AUTONOMOUS_GOAL_MODEL_PRESETS)).toBe(true);
    expect(Object.isFrozen(CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET)).toBe(
      true,
    );
    expect(
      Object.isFrozen(CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET.modelConfig),
    ).toBe(true);
    expect(CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET).toMatchObject({
      provider: "codex",
      modelConfig: { single_model: true, default: {} },
    });
  });

  it("defaults to the selected agent and falls back from stale bindings", () => {
    const fresh = loadAutonomousGoalModelPreferences();
    expect(resolveInitialAutonomousGoalModelPresetId(fresh, "claude")).toBe(
      CLAUDE_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
    );
    expect(
      resolveInitialAutonomousGoalModelPresetId(
        { ...fresh, lastPresetId: "deleted:model-preset" },
        "codex",
      ),
    ).toBe(CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID);
  });

  it("duplicates model routing as an independent custom snapshot", () => {
    const source = {
      ...CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET,
      modelConfig: {
        ...CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET.modelConfig,
        default: { model: "gpt-test", effort: "high" },
      },
    };
    const duplicate = createCustomAutonomousGoalModelPreset(
      source,
      "custom:model",
      "My Codex route",
    );
    duplicate.modelConfig.default.model = "gpt-other";

    expect(duplicate.builtIn).toBe(false);
    expect(duplicate.provider).toBe("codex");
    expect(source.modelConfig.default.model).toBe("gpt-test");
  });

  it("deletes only the custom model preset and restores its agent default", () => {
    const custom = createCustomAutonomousGoalModelPreset(
      CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET,
      "custom:model",
      "My route",
    );
    const preferences: AutonomousGoalModelPreferences = {
      schemaVersion: 2,
      customPresets: [custom],
      lastPresetId: custom.id,
    };

    const next = deleteCustomAutonomousGoalModelPreset(
      preferences,
      custom.id,
    );
    expect(next.customPresets).toEqual([]);
    expect(next.lastPresetId).toBe(
      CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
    );
  });

  it("sanitizes malformed persisted model presets without losing valid ones", () => {
    const valid = createCustomAutonomousGoalModelPreset(
      CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET,
      "custom:valid-model",
      "Valid model route",
    );
    window.localStorage.setItem(
      AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
      JSON.stringify({
        customPresets: [
          valid,
          { ...valid, id: "custom:broken", provider: "unknown" },
          {
            ...valid,
            id: CODEX_DEFAULT_AUTONOMOUS_GOAL_MODEL_PRESET_ID,
          },
        ],
        lastPresetId: valid.id,
      }),
    );

    const loaded = loadAutonomousGoalModelPreferences();
    expect(loaded.customPresets).toEqual([valid]);
    saveAutonomousGoalModelPreferences(loaded);
    expect(
      JSON.parse(
        window.localStorage.getItem(
          AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
        ) ?? "null",
      ),
    ).toEqual(loaded);
  });

  it("migrates the previous stage model routing without enabling Merge", () => {
    window.localStorage.setItem(
      "acorn:autonomous-goal-model-presets:v1",
      JSON.stringify({
        schemaVersion: 1,
        customPresets: [
          {
            id: "custom:legacy-model",
            name: "Legacy model",
            provider: "codex",
            modelConfig: {
              single_model: false,
              default: {},
              stages: {
                interpretation: { model: "old-plan" },
                plan: { model: "plan" },
                implementation: {},
                validation: {},
                auto_fix: {},
                self_review: {},
                draft_pr: { model: "pr-model" },
              },
            },
          },
        ],
        lastPresetId: "custom:legacy-model",
      }),
    );

    const loaded = loadAutonomousGoalModelPreferences();

    expect(loaded).toMatchObject({
      schemaVersion: 2,
      customPresets: [
        {
          modelConfig: {
            stages: {
              plan: { model: "plan" },
              open_pr: { model: "pr-model" },
              merge: {},
            },
          },
        },
      ],
    });
    saveAutonomousGoalModelPreferences(loaded);
    expect(
      window.localStorage.getItem(
        AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
      ),
    ).not.toBeNull();
  });
});

describe("autonomous goal sessions", () => {
  it("persists the goal and policy snapshot in the session data contract", () => {
    const goal = createSessionGoal(
      {
        goal: "  Ship project-owned goal sessions  ",
        completionCriteria: " Sessions survive restart ",
        constraints: "   ",
      },
      "codex",
      BALANCED_AUTONOMOUS_GOAL_PRESET,
    );

    expect(goal).toMatchObject({
      objective: "Ship project-owned goal sessions",
      completion_criteria: "Sessions survive restart",
      constraints: undefined,
      provider: "codex",
      revision: 1,
      preset: {
        id: BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
        policies: {
          auto_fix: "auto",
          self_review: "auto",
          open_pr: "approval",
          merge: "approval",
        },
      },
      model_config: {
        single_model: true,
        default: {},
      },
      progress: {
        current_stage: "plan",
        state: "pending",
        approval_pending: false,
      },
    });
    expect(autonomousPresetFromSessionGoal(goal).policies).toEqual(
      BALANCED_AUTONOMOUS_GOAL_PRESET.policies,
    );
  });

  it("derives a compact name from the first meaningful goal line", () => {
    expect(
      deriveAutonomousGoalSessionName(
        "\n# Add a configurable autonomous goal session\nMore detail",
      ),
    ).toBe("Goal · Add a configurable autonomous goal session");
  });
});
