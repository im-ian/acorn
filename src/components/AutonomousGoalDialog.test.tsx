import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTONOMOUS_GOAL_PRESET_STORAGE_KEY } from "../lib/autonomousGoal";
import type { SessionCreateScope } from "../lib/sessionCreation";
import { useSettings } from "../lib/settings";
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

  async function renderDialog() {
    const scope: SessionCreateScope = {
      placement: {
        repoPath: "/tmp/acorn-project",
        projectScoped: true,
      },
      launch: { kind: "projectRoot" },
    };
    await act(async () => {
      root.render(
        <AutonomousGoalDialog open scope={scope} onClose={vi.fn()} />,
      );
    });
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

  it("opens on the full-autonomy built-in with a required goal", async () => {
    await renderDialog();

    expect(document.body.textContent).toContain(
      "New goal session",
    );
    expect(document.body.textContent).toContain("Full autonomy");
    expect(document.body.textContent).toContain(
      "This built-in preset cannot be changed",
    );
    expect(button("Start goal").disabled).toBe(true);
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

  it("loads CLI models and reveals seven stage routes when disabled", async () => {
    await renderDialog();

    act(() => button("Model").click());

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
    expect(document.body.textContent).toContain("Draft PR");
  });
});
