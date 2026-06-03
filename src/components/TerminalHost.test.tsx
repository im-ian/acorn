import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Session } from "../lib/types";

vi.mock("./Terminal", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Terminal: ({
      sessionId,
      isActive,
    }: {
      sessionId: string;
      isActive?: boolean;
    }) =>
      React.createElement("div", {
        "data-testid": "terminal",
        "data-session-id": sessionId,
        "data-active": String(Boolean(isActive)),
      }),
  };
});

import { TerminalHost } from "./TerminalHost";
import { useAppStore } from "../store";
import { defaultTabByGroup } from "../lib/rightPanelGroups";

const REPO = "/Users/me/repo";

function project(repoPath: string): Project {
  return {
    repo_path: repoPath,
    name: "repo",
    created_at: "2026-01-01T00:00:00Z",
    position: 0,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    repo_path: overrides.repo_path ?? REPO,
    worktree_path:
      overrides.worktree_path ?? `${overrides.repo_path ?? REPO}/.worktrees/${id}`,
    branch: `feat/${id}`,
    isolated: false,
    status: "idle",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

function resetStore(): void {
  const pane = { id: "root", tabIds: [], activeTabId: null };
  useAppStore.setState(
    {
      sessions: [],
      projects: [project(REPO)],
      workspaces: {
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: { root: pane },
          focusedPaneId: "root",
        },
      },
      activeProject: REPO,
      layout: { kind: "pane", id: "root" },
      panes: { root: pane },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
      rightTab: "commits",
      rightTabByGroup: defaultTabByGroup(),
      workspaceTabs: {},
      prAccountByRepo: {},
      pendingTerminalInput: {},
      sessionNotifications: [],
      multiInputEnabled: false,
      loading: false,
      error: null,
      pendingRemoveId: null,
      pendingRemoveProject: null,
      sessionsLoadedCleanly: true,
      liveInWorktree: {},
      generatingSessionTitleIds: {},
    },
    false,
  );
}

function terminalRows(): Array<{ id: string; active: boolean }> {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-testid='terminal']"),
  )
    .map((el) => ({
      id: el.dataset.sessionId ?? "",
      active: el.dataset.active === "true",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe("TerminalHost", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll("[data-acorn-terminal-limbo]")
      .forEach((el) => el.remove());
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(<TerminalHost />);
    });
  }

  it("mounts only terminal sessions visible in the active workspace on first render", () => {
    const active = session("active");
    const inactiveTab = session("inactive-tab");
    const sidePane = session("side-pane");
    const otherProject = session("other-project", {
      repo_path: "/Users/me/other",
      worktree_path: "/Users/me/other",
    });
    const chat = session("chat", { mode: "chat" });
    const layout = {
      kind: "split" as const,
      id: "split",
      direction: "horizontal" as const,
      a: { kind: "pane" as const, id: "root" },
      b: { kind: "pane" as const, id: "side" },
    };
    const panes = {
      root: {
        id: "root",
        tabIds: [active.id, inactiveTab.id, chat.id],
        activeTabId: active.id,
      },
      side: {
        id: "side",
        tabIds: [sidePane.id],
        activeTabId: sidePane.id,
      },
    };

    useAppStore.setState((state) => ({
      sessions: [active, inactiveTab, sidePane, otherProject, chat],
      projects: [...state.projects, project("/Users/me/other")],
      workspaces: {
        ...state.workspaces,
        [REPO]: { layout, panes, focusedPaneId: "root" },
        "/Users/me/other": {
          layout: { kind: "pane", id: "other-root" },
          panes: {
            "other-root": {
              id: "other-root",
              tabIds: [otherProject.id],
              activeTabId: otherProject.id,
            },
          },
          focusedPaneId: "other-root",
        },
      },
      layout,
      panes,
      activeTabId: active.id,
      activeSessionId: active.id,
    }));

    render();

    expect(terminalRows()).toEqual([
      { id: "active", active: true },
      { id: "side-pane", active: true },
    ]);
  });

  it("keeps a terminal mounted after it was visible once", () => {
    const first = session("first");
    const second = session("second");
    const pane = {
      id: "root",
      tabIds: [first.id, second.id],
      activeTabId: first.id,
    };
    useAppStore.setState((state) => ({
      sessions: [first, second],
      workspaces: {
        ...state.workspaces,
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: { root: pane },
          focusedPaneId: "root",
        },
      },
      panes: { root: pane },
      activeTabId: first.id,
      activeSessionId: first.id,
    }));
    render();

    act(() => {
      useAppStore.setState((state) => {
        const nextPane = { ...state.panes.root, activeTabId: second.id };
        return {
          panes: { ...state.panes, root: nextPane },
          workspaces: {
            ...state.workspaces,
            [REPO]: {
              ...state.workspaces[REPO],
              panes: { root: nextPane },
            },
          },
          activeTabId: second.id,
          activeSessionId: second.id,
        };
      });
    });

    expect(terminalRows()).toEqual([
      { id: "first", active: false },
      { id: "second", active: true },
    ]);
  });
});
