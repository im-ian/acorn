import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTONOMOUS_GOAL_PRESET_STORAGE_KEY } from "../lib/autonomousGoal";
import type { SessionCreateScope } from "../lib/sessionCreation";
import { useSettings } from "../lib/settings";
import { AutonomousGoalDialog } from "./AutonomousGoalDialog";

describe("AutonomousGoalDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  function renderDialog() {
    const scope: SessionCreateScope = {
      placement: {
        repoPath: "/tmp/acorn-project",
        projectScoped: true,
      },
      launch: { kind: "projectRoot" },
    };
    act(() => {
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

  it("opens on the full-autonomy built-in with a required goal", () => {
    renderDialog();

    expect(document.body.textContent).toContain(
      "New goal session",
    );
    expect(document.body.textContent).toContain("Full autonomy");
    expect(document.body.textContent).toContain(
      "This built-in preset cannot be changed",
    );
    expect(button("Start goal").disabled).toBe(true);
  });

  it("duplicates and deletes an editable preset without changing built-ins", () => {
    renderDialog();

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
});
