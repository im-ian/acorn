import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNode } from "../lib/layout";

vi.mock("./LayoutRenderer", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    LayoutRenderer: () =>
      React.createElement("div", { "data-testid": "layout-renderer" }),
  };
});

import { WorkspaceMain } from "./WorkspaceMain";
import { useAppStore } from "../store";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";

const REPO = "/Users/me/repo";
const LAYOUT: LayoutNode = { kind: "pane", id: "root" };

function resetStore(): void {
  const pane = { id: "root", tabIds: [], activeTabId: null };
  useAppStore.setState(
    {
      sessions: [],
      workspaces: {
        [REPO]: {
          layout: LAYOUT,
          panes: { root: pane },
          focusedPaneId: "root",
        },
      },
      activeProject: REPO,
      layout: LAYOUT,
      panes: { root: pane },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
      workspaceViewMode: "panes",
      terminalPopupSessionId: null,
    },
    false,
  );
}

function queryLayout(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='layout-renderer']");
}

function queryKanban(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='workspace-kanban']");
}

describe("WorkspaceMain", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    resetStore();
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(viewMode: "panes" | "kanban"): void {
    act(() => {
      root.render(<WorkspaceMain layout={LAYOUT} viewMode={viewMode} />);
    });
  }

  it("keeps the pane layout mounted with a stable DOM node across a kanban toggle", () => {
    render("panes");
    const initial = queryLayout();
    expect(initial).not.toBeNull();
    expect(queryKanban()).toBeNull();

    render("kanban");
    const duringKanban = queryLayout();
    // The layout must stay mounted (same DOM node) so the terminal target divs
    // appendChild'd into pane bodies keep their identity and are not orphaned.
    expect(duringKanban).toBe(initial);
    expect(queryKanban()).not.toBeNull();

    render("panes");
    expect(queryLayout()).toBe(initial);
    expect(queryKanban()).toBeNull();
  });

  it("hides the pane layout while the kanban board is shown", () => {
    render("panes");
    expect(queryLayout()?.parentElement?.className).not.toContain("hidden");

    render("kanban");
    expect(queryLayout()?.parentElement?.className).toContain("hidden");
  });
});
