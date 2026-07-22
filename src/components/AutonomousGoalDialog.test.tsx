import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
  AUTONOMOUS_GOAL_PRESET_STORAGE_KEY,
  FULL_AUTONOMY_GOAL_PRESET,
  createSessionGoal,
} from "../lib/autonomousGoal";
import type { SessionCreateScope } from "../lib/sessionCreation";
import { useSettings } from "../lib/settings";
import type { Session } from "../lib/types";
import { AutonomousGoalDialog } from "./AutonomousGoalDialog";

vi.mock("../lib/api", () => ({
  api: {
    getGoalAgentCapabilities: vi.fn(async (provider: "claude" | "codex") =>
      provider === "codex"
        ? {
            provider,
            installed: true,
            version: "codex-cli 0.test",
            source: "codex_app_server",
            models: [
              {
                id: "gpt-test-default",
                label: "GPT Test Default",
                description: "Default test model",
                is_default: true,
                default_effort: "low",
                supported_efforts: [
                  { id: "low", description: "Fast" },
                  { id: "ultra", description: "Delegates" },
                ],
              },
            ],
            effort_options: [{ id: "low" }, { id: "ultra" }],
          }
        : {
            provider,
            installed: true,
            version: "2.test (Claude Code)",
            source: "claude_cli_help",
            models: [
              {
                id: "default",
                label: "Default",
                is_default: true,
                supported_efforts: [{ id: "low" }, { id: "high" }],
              },
              {
                id: "sonnet",
                label: "Sonnet",
                is_default: false,
                supported_efforts: [{ id: "low" }, { id: "high" }],
              },
            ],
            effort_options: [{ id: "low" }, { id: "high" }],
          },
    ),
  },
}));

describe("AutonomousGoalDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    useSettings.getState().reset();
    useSettings.getState().patchLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderDialog(session: Session | null = null) {
    const scope: SessionCreateScope = {
      placement: {
        repoPath: "/tmp/acorn-project",
        projectScoped: true,
      },
      launch: { kind: "projectRoot" },
    };
    await act(async () => {
      root.render(
        <AutonomousGoalDialog
          open
          scope={session ? null : scope}
          session={session}
          onClose={vi.fn()}
        />,
      );
    });
  }

  function goalSession(): Session {
    return {
      id: "goal-1",
      name: "Goal · Existing work",
      repo_path: "/tmp/acorn-project",
      worktree_path: "/tmp/acorn-project/.acorn/worktrees/goal-1",
      branch: "goal-1",
      isolated: true,
      project_scoped: true,
      status: "working",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message: null,
      title_source: "default",
      generated_title_transcript_id: null,
      kind: "regular",
      mode: "chat",
      owner: { kind: "user" },
      position: null,
      in_worktree: true,
      agent_provider: "claude",
      agent_transcript_id: null,
      goal: createSessionGoal(
        { goal: "Finish the existing work" },
        "claude",
        FULL_AUTONOMY_GOAL_PRESET,
      ),
    };
  }

  function button(label: string): HTMLButtonElement {
    const match = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!(match instanceof HTMLButtonElement)) {
      throw new Error(`button "${label}" not found`);
    }
    return match;
  }

  async function chooseSelectOption(label: string, optionText: string) {
    const combobox = document.body.querySelector<HTMLButtonElement>(
      `button[role="combobox"][aria-label="${label}"]`,
    );
    if (!combobox) throw new Error(`Combobox not found: ${label}`);
    await act(async () => combobox.click());
    const optionLabel = Array.from(
      document.body.querySelectorAll("[data-select-option-label]"),
    ).find((element) => element.textContent?.trim() === optionText);
    const option = optionLabel?.closest('[role="option"]');
    if (!(option instanceof HTMLElement)) {
      throw new Error(`Select option not found: ${optionText}`);
    }
    await act(async () => option.click());
  }

  it("opens on the full-autonomy built-in with a required goal", async () => {
    await renderDialog();

    expect(
      document.body.querySelector<HTMLElement>('[role="dialog"] > div')
        ?.className,
    ).toContain("max-w-5xl");
    expect(document.body.textContent).toContain(
      "New goal session",
    );
    expect(document.body.textContent).toContain("Full autonomy");
    expect(document.body.textContent).toContain(
      "This built-in preset cannot be changed",
    );
    expect(button("Start goal").disabled).toBe(true);
  });

  it("separates read-only built-ins from editable policy slots", async () => {
    await renderDialog();

    const policyPreset = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Policy preset"]',
    );
    await act(async () => policyPreset?.click());
    expect(
      document.body.querySelector(
        '[data-select-separator][aria-label="Built-ins above · read-only"]',
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).toContain("No custom presets yet");
  });

  it("separates read-only built-ins from editable model slots", async () => {
    await renderDialog();

    act(() => button("Agent & Model").click());
    const modelPreset = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        'button[role="combobox"]',
      ),
    ).find(
      (candidate) =>
        candidate.getAttribute("aria-label") === "Agent & model preset",
    );
    expect(modelPreset).toBeInstanceOf(HTMLButtonElement);
    await act(async () => modelPreset?.click());
    expect(
      document.body.querySelector(
        '[data-select-separator][aria-label="Built-ins above · read-only"]',
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(document.body.textContent).toContain("No custom presets yet");
  });

  it("duplicates and deletes an editable preset without changing built-ins", async () => {
    await renderDialog();

    act(() => button("Duplicate").click());

    const presetName = document.querySelector<HTMLInputElement>(
      'input[maxlength="80"]',
    );
    expect(presetName?.value).toBe("Full autonomy copy");
    expect(button("Delete")).toBeInstanceOf(HTMLButtonElement);

    const storedAfterDuplicate = JSON.parse(
      window.localStorage.getItem(AUTONOMOUS_GOAL_PRESET_STORAGE_KEY) ??
        "null",
    );
    expect(storedAfterDuplicate.customPresets).toHaveLength(1);

    act(() => button("Delete").click());

    expect(document.body.textContent).toContain(
      "This built-in preset cannot be changed",
    );
    const storedAfterDelete = JSON.parse(
      window.localStorage.getItem(AUTONOMOUS_GOAL_PRESET_STORAGE_KEY) ??
        "null",
    );
    expect(storedAfterDelete.customPresets).toEqual([]);
  });

  it("keeps the agent in model settings and reveals stage routes", async () => {
    await renderDialog();

    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Agent"]',
      ),
    ).toBeNull();

    act(() => button("Agent & Model").click());

    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Agent"]',
      ),
    ).toBeInstanceOf(HTMLButtonElement);

    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Agent"]',
      )?.disabled,
    ).toBe(true);
    act(() => button("Duplicate").click());

    const singleModel = document.body.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(singleModel?.checked).toBe(true);
    const modelPickers = () =>
      document.body.querySelectorAll<HTMLButtonElement>(
        'button[aria-label$=" Model"]',
      );
    expect(modelPickers()).toHaveLength(1);

    await act(async () => modelPickers()[0]?.click());
    expect(document.body.textContent).toContain("Sonnet");

    act(() => singleModel?.click());

    expect(singleModel?.checked).toBe(false);
    expect(modelPickers()).toHaveLength(7);
    expect(document.body.textContent).toContain("Automatic fixes");
    expect(document.body.textContent).toContain("Open PR");
    expect(document.body.textContent).toContain("Merge");
  });

  it("persists editable Agent & Model presets and resets routes when the agent changes", async () => {
    await renderDialog();
    act(() => button("Agent & Model").click());
    act(() => button("Duplicate").click());

    await chooseSelectOption("All stages Model", "Sonnet");
    await chooseSelectOption("Agent", "Codex");

    const stored = JSON.parse(
      window.localStorage.getItem(
        AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
      ) ?? "null",
    );
    expect(stored.customPresets).toHaveLength(1);
    expect(stored.customPresets[0]).toMatchObject({
      provider: "codex",
      modelConfig: {
        single_model: true,
        default: {},
      },
    });
    const modelPicker = document.body.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="All stages Model"]',
    );
    expect(modelPicker?.textContent).toContain("Default");

    act(() => button("Delete").click());
    const storedAfterDelete = JSON.parse(
      window.localStorage.getItem(
        AUTONOMOUS_GOAL_MODEL_PRESET_STORAGE_KEY,
      ) ?? "null",
    );
    expect(storedAfterDelete.customPresets).toEqual([]);
  });

  it("keeps current session snapshots out of reusable preset actions", async () => {
    await renderDialog(goalSession());

    expect(document.body.textContent).not.toContain("session snapshot");
    expect(button("Duplicate").disabled).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Policy preset"]',
      )?.textContent,
    ).toContain("Current session policy");

    act(() => button("Agent & Model").click());

    expect(button("Duplicate").disabled).toBe(true);
    expect(document.body.textContent).toContain("Current session settings");
  });
});
