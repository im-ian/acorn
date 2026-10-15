import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTask, ProjectTaskStatus } from "../lib/types";
import { useSettings } from "../lib/settings";

const listProjectTasks = vi.fn<() => Promise<ProjectTask[]>>();

vi.mock("../lib/api", () => ({
  api: {
    listProjectTasks: (...args: unknown[]) =>
      listProjectTasks(...(args as [])),
  },
}));

const { WorkspaceTasksTab } = await import("./WorkspaceTasksTab");

function task(number: number, status: ProjectTaskStatus): ProjectTask {
  return {
    id: `task-${number}`,
    number,
    title: `Task ${number}`,
    description: "",
    status,
    session_id: null,
    origin_session_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    comments: [],
  };
}

describe("WorkspaceTasksTab filters", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettings.getState().reset();
    useSettings.getState().patchLanguage("en");
    listProjectTasks.mockResolvedValue([
      task(1, "todo"),
      task(2, "in_progress"),
      task(3, "done"),
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  function chip(label: string): HTMLButtonElement {
    const found = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === label);
    if (!found) throw new Error(`no chip labelled ${label}`);
    return found;
  }

  function groupHeaders(): string[] {
    return Array.from(
      container.querySelectorAll("[data-task-group-header]"),
    ).map((node) => node.textContent ?? "");
  }

  async function render() {
    await act(async () => {
      root.render(
        <WorkspaceTasksTab repoPath="/repo" originSessionId={null} />,
      );
    });
  }

  it("opens on All and lists every status group", async () => {
    await render();
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
    expect(groupHeaders()).toEqual(["Todo", "In progress", "Done"]);
  });

  it("narrows to one status, then All restores the full list", async () => {
    await render();
    await act(async () => {
      chip("Todo").click();
    });
    expect(groupHeaders()).toEqual(["Todo"]);
    await act(async () => {
      chip("All").click();
    });
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
    expect(groupHeaders()).toEqual(["Todo", "In progress", "Done"]);
  });
});
