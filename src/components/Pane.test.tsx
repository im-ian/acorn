import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Session, SessionStatus } from "../lib/types";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({}) as Session),
  listSessions: vi.fn(async () => [] as Session[]),
  listProjects: vi.fn(async () => [] as Project[]),
  detectSessionStatuses: vi.fn(
    async (_ids: string[]) =>
      [] as { id: string; status: SessionStatus }[],
  ),
  ptyInWorktreeAll: vi.fn(async () => ({} as Record<string, boolean>)),
}));

vi.mock("../lib/api", () => ({
  api: {
    loadStatus: vi.fn(async () => ({
      sessionsClean: true,
      projectsClean: true,
    })),
    createSession: mocks.createSession,
    listSessions: mocks.listSessions,
    listProjects: mocks.listProjects,
    detectSessionStatuses: mocks.detectSessionStatuses,
    ptyInWorktreeAll: mocks.ptyInWorktreeAll,
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
}));

import { Pane } from "./Pane";
import { useAppStore } from "../store";
import { defaultTabByGroup } from "../lib/rightPanelGroups";

const REPO = "/Users/me/repo";
const HOME = "/Users/me";

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
  useAppStore.setState(
    {
      sessions: [],
      projects: [project(REPO)],
      workspaces: {
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: { root: { id: "root", tabIds: [], activeTabId: null } },
          focusedPaneId: "root",
        },
      },
      activeProject: REPO,
      layout: { kind: "pane", id: "root" },
      panes: { root: { id: "root", tabIds: [], activeTabId: null } },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
      rightTab: "commits",
      rightTabByGroup: defaultTabByGroup(),
      workspaceTabs: {},
      prAccountByRepo: {},
      pendingTerminalInput: {},
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

describe("Pane empty state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens a terminal when Space is pressed twice while an empty pane is focused", async () => {
    const created = session("new-session");
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([created]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    expect(document.querySelector('[role="button"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          code: "Space",
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          code: "Space",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      "repo",
      REPO,
      false,
      "regular",
      null,
    );
  });

  it("keeps tab-strip double-click creation in local chat scope", async () => {
    const local = session("local-session", {
      name: "terminal",
      repo_path: HOME,
      worktree_path: HOME,
      project_scoped: false,
    });
    const created = session("local-session-2", {
      name: "terminal-2",
      repo_path: HOME,
      worktree_path: HOME,
      project_scoped: false,
    });
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([local, created]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);
    useAppStore.setState((s) => ({
      ...s,
      sessions: [local],
      activeProject: HOME,
      activeSessionId: local.id,
      activeTabId: local.id,
      workspaces: {
        ...s.workspaces,
        [HOME]: {
          layout: { kind: "pane", id: "root" },
          panes: {
            root: {
              id: "root",
              tabIds: [local.id],
              activeTabId: local.id,
            },
          },
          focusedPaneId: "root",
        },
      },
      layout: { kind: "pane", id: "root" },
      panes: {
        root: {
          id: "root",
          tabIds: [local.id],
          activeTabId: local.id,
        },
      },
      focusedPaneId: "root",
    }));

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const filler = container.querySelector('[data-pane-tab-filler="root"]');
    expect(filler).not.toBeNull();

    await act(async () => {
      filler?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      "terminal-2",
      HOME,
      false,
      "regular",
      null,
      false,
    );
  });

  it("shows a session-title generation indicator on the tab", async () => {
    const active = session("agent-session", { agent_provider: "codex" });
    useAppStore.setState((s) => ({
      ...s,
      sessions: [active],
      activeProject: REPO,
      activeSessionId: active.id,
      activeTabId: active.id,
      generatingSessionTitleIds: { [active.id]: true },
      workspaces: {
        ...s.workspaces,
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: {
            root: {
              id: "root",
              tabIds: [active.id],
              activeTabId: active.id,
            },
          },
          focusedPaneId: "root",
        },
      },
      panes: {
        root: {
          id: "root",
          tabIds: [active.id],
          activeTabId: active.id,
        },
      },
    }));

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    expect(
      container.querySelector('[aria-label="Generating session title"]'),
    ).toBeInstanceOf(HTMLElement);
  });

  it("does not enter tab rename while title generation is active", async () => {
    const active = session("agent-session", { agent_provider: "codex" });
    useAppStore.setState((s) => ({
      ...s,
      sessions: [active],
      activeProject: REPO,
      activeSessionId: active.id,
      activeTabId: active.id,
      generatingSessionTitleIds: { [active.id]: true },
      workspaces: {
        ...s.workspaces,
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: {
            root: {
              id: "root",
              tabIds: [active.id],
              activeTabId: active.id,
            },
          },
          focusedPaneId: "root",
        },
      },
      panes: {
        root: {
          id: "root",
          tabIds: [active.id],
          activeTabId: active.id,
        },
      },
    }));

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const dragHandle = container.querySelector(
      `[data-tab-drag-handle="${active.id}"]`,
    );
    const tab = dragHandle?.closest('[role="button"]');

    await act(async () => {
      tab?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });

    expect(container.querySelector("[data-tab-rename-input]")).toBeNull();
  });
});
