import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_GOAL_PRESET_STORAGE_KEY,
  BALANCED_AUTONOMOUS_GOAL_PRESET,
  BALANCED_AUTONOMOUS_GOAL_PRESET_ID,
  BUILTIN_AUTONOMOUS_GOAL_PRESETS,
  FULL_AUTONOMY_GOAL_PRESET_ID,
  REVIEW_AUTONOMOUS_GOAL_PRESET,
  autonomousPresetFromSessionGoal,
  buildAutonomousGoalPrompt,
  buildAutonomousGoalRevisionPrompt,
  createSessionGoal,
  createCustomAutonomousGoalPreset,
  deleteCustomAutonomousGoalPreset,
  deriveAutonomousGoalSessionName,
  loadAutonomousGoalPreferences,
  resolveInitialAutonomousGoalPresetId,
  saveAutonomousGoalPreferences,
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
    expect(BALANCED_AUTONOMOUS_GOAL_PRESET.policies.plan).toBe("approval");
    expect(
      Object.values(
        BUILTIN_AUTONOMOUS_GOAL_PRESETS[2]?.policies ?? {},
      ),
    ).toEqual(Array(7).fill("auto"));
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
      schemaVersion: 1,
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
});

describe("autonomous goal prompt", () => {
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
          draft_pr: "approval",
        },
      },
    });
    expect(autonomousPresetFromSessionGoal(goal).policies).toEqual(
      BALANCED_AUTONOMOUS_GOAL_PRESET.policies,
    );
  });

  it("forces a revised goal through replan and confirmation before resuming", () => {
    const previous = createSessionGoal(
      { goal: "Add keyboard navigation" },
      "claude",
      BALANCED_AUTONOMOUS_GOAL_PRESET,
    );
    const next = createSessionGoal(
      { goal: "Add keyboard and screen-reader navigation" },
      "claude",
      REVIEW_AUTONOMOUS_GOAL_PRESET,
      2,
    );

    const prompt = buildAutonomousGoalRevisionPrompt(previous, next);
    expect(prompt).toContain("Revision 2 supersedes revision 1");
    expect(prompt).toContain("Add keyboard and screen-reader navigation");
    expect(prompt).toContain("Do not resume implementation");
    expect(prompt).toContain("WAITING:");
  });

  it("captures structured fields, policy, and the prototype safety boundary", () => {
    const prompt = buildAutonomousGoalPrompt({
      goal: "Fix the flaky parser test",
      completionCriteria: "The parser suite passes",
      constraints: "Do not change the public API",
      tests: "pnpm test parser",
      provider: "codex",
      preset: BALANCED_AUTONOMOUS_GOAL_PRESET,
    });

    expect(prompt).toContain("Fix the flaky parser test");
    expect(prompt).toContain("The parser suite passes");
    expect(prompt).toContain("Plan: APPROVAL");
    expect(prompt).toContain("Provider: codex");
    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("treat the latest revision as authoritative");
    expect(prompt).toContain("two consecutive fix attempts");
    expect(prompt).toContain("Do not search for or select a GitHub issue");
  });

  it("tells the provider to infer omitted optional fields", () => {
    const prompt = buildAutonomousGoalPrompt({
      goal: "Implement the feature",
      provider: "claude",
      preset: REVIEW_AUTONOMOUS_GOAL_PRESET,
    });

    expect(prompt.match(/Not provided — infer/g)).toHaveLength(3);
    expect(prompt).toContain("Interpretation: APPROVAL");
  });

  it("derives a compact name from the first meaningful goal line", () => {
    expect(
      deriveAutonomousGoalSessionName(
        "\n# Add a configurable autonomous goal session\nMore detail",
      ),
    ).toBe("Goal · Add a configurable autonomous goal session");
  });
});
