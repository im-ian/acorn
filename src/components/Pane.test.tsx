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
import { endAcornDrag } from "../lib/dnd";
import { defaultTabByGroup } from "../lib/rightPanelGroups";
import {
  cancelWorkspaceTabDrag,
  getWorkspaceTabDragSession,
} from "../lib/workspaceTabDrag";

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
      projectFolders: {
        [REPO]: [
          {
            id: REPO,
            repoPath: REPO,
            name: "Default",
            cwdPath: REPO,
            position: 0,
          },
        ],
      },
      sessionFolderIds: {},
      workspaces: {
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: { root: { id: "root", tabIds: [], activeTabId: null } },
          focusedPaneId: "root",
        },
      },
      activeProject: REPO,
      activeProjectFolderId: REPO,
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

function seedInactivePaneWithTab(tab: Session): void {
  const layout = {
    kind: "split" as const,
    id: "split-test",
    direction: "horizontal" as const,
    a: { kind: "pane" as const, id: "root" },
    b: { kind: "pane" as const, id: "pane-2" },
  };
  const panes = {
    root: { id: "root", tabIds: [], activeTabId: null },
    "pane-2": {
      id: "pane-2",
      tabIds: [tab.id],
      activeTabId: tab.id,
    },
  };

  useAppStore.setState((s) => ({
    ...s,
    sessions: [tab],
    activeProject: REPO,
    activeProjectFolderId: REPO,
    workspaces: {
      [REPO]: {
        layout,
        panes,
        focusedPaneId: "root",
      },
    },
    layout,
    panes,
    focusedPaneId: "root",
    activeTabId: null,
    activeSessionId: null,
  }));
}

function seedActivePaneWithTab(tab: Session): void {
  seedActivePaneWithTabs([tab], tab.id);
}

function seedActivePaneWithTabs(tabs: Session[], activeTabId: string): void {
  const pane = {
    id: "root",
    tabIds: tabs.map((tab) => tab.id),
    activeTabId,
  };

  useAppStore.setState((s) => ({
    ...s,
    sessions: tabs,
    activeProject: REPO,
    activeProjectFolderId: REPO,
    activeSessionId: activeTabId,
    activeTabId,
    workspaces: {
      ...s.workspaces,
      [REPO]: {
        layout: { kind: "pane", id: "root" },
        panes: { root: pane },
        focusedPaneId: "root",
      },
    },
    panes: { root: pane },
    focusedPaneId: "root",
  }));
}

function dispatchPointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { clientX: number; clientY: number; button?: number; pointerId?: number },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
  return event;
}

describe("Pane empty state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStore();
    endAcornDrag();
    cancelWorkspaceTabDrag();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    endAcornDrag();
    cancelWorkspaceTabDrag();
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

    const dragHandle = container.querySelector(
      `[data-tab-drag-handle="${active.id}"]`,
    );
    const indicator = container.querySelector(
      '[aria-label="Generating session title"]',
    );
    const title = Array.from(dragHandle?.querySelectorAll("span") ?? []).find(
      (el) => el.textContent === active.name,
    );

    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(title).toBeInstanceOf(HTMLElement);
    expect(dragHandle?.firstElementChild?.contains(indicator)).toBe(true);
    expect(
      indicator!.compareDocumentPosition(title!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
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

  it("does not focus an inactive pane on primary mousedown in its tab strip", () => {
    const inactive = session("inactive-session");
    seedInactivePaneWithTab(inactive);

    act(() => {
      root.render(<Pane paneId="pane-2" />);
    });

    const tabStrip = container.querySelector('[data-pane-tab-strip="pane-2"]');
    expect(tabStrip).not.toBeNull();

    act(() => {
      tabStrip?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          cancelable: true,
        }),
      );
    });

    expect(useAppStore.getState().focusedPaneId).toBe("root");
  });

  it("keeps secondary mousedown on a tab strip focusing the pane", () => {
    const inactive = session("inactive-session");
    seedInactivePaneWithTab(inactive);

    act(() => {
      root.render(<Pane paneId="pane-2" />);
    });

    const tabStrip = container.querySelector('[data-pane-tab-strip="pane-2"]');
    expect(tabStrip).not.toBeNull();

    act(() => {
      tabStrip?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 2,
          cancelable: true,
        }),
      );
    });

    expect(useAppStore.getState().focusedPaneId).toBe("pane-2");
  });

  it("starts tab drag from active tab chrome after pointer movement", () => {
    const active = session("active-session");
    seedActivePaneWithTab(active);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const dragHandle = container.querySelector(
      `[data-tab-drag-handle="${active.id}"]`,
    );
    const tab = dragHandle?.closest('[role="button"]');
    expect(tab).toBeInstanceOf(HTMLElement);

    act(() => {
      dispatchPointer(tab!, "pointerdown", { clientX: 32, clientY: 12 });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 48,
        clientY: 12,
      });
    });

    expect(getWorkspaceTabDragSession()?.payload).toMatchObject({
      tabId: active.id,
      fromPaneId: "root",
    });
  });

  it("keeps small pointer movement on the click path selecting the tab", () => {
    const first = session("first-session");
    const second = session("second-session");
    seedActivePaneWithTabs([first, second], first.id);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const secondTab = container
      .querySelector(`[data-tab-drag-handle="${second.id}"]`)
      ?.closest('[role="button"]');
    expect(secondTab).toBeInstanceOf(HTMLElement);

    act(() => {
      dispatchPointer(secondTab!, "pointerdown", { clientX: 32, clientY: 12 });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 34,
        clientY: 12,
      });
      dispatchPointer(window as unknown as Element, "pointerup", {
        clientX: 34,
        clientY: 12,
      });
      secondTab!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(getWorkspaceTabDragSession()).toBeNull();
    expect(useAppStore.getState().activeTabId).toBe(second.id);
  });

  it("starts tab drag from the title text area without native draggable", () => {
    const active = session("active-session");
    seedActivePaneWithTab(active);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const dragHandle = container.querySelector(
      `[data-tab-drag-handle="${active.id}"]`,
    );
    const tab = dragHandle?.closest('[role="button"]');
    expect(tab).toBeInstanceOf(HTMLElement);
    expect((tab as HTMLElement).hasAttribute("draggable")).toBe(false);
    expect((dragHandle as HTMLElement).hasAttribute("draggable")).toBe(false);

    act(() => {
      dispatchPointer(tab!, "pointerdown", { clientX: 32, clientY: 12 });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 44,
        clientY: 12,
      });
    });

    expect(getWorkspaceTabDragSession()?.payload).toMatchObject({
      tabId: active.id,
      fromPaneId: "root",
    });
  });

  it("clears a tab drag payload when the source pointer ends", () => {
    const first = session("first-session");
    const second = session("second-session");
    seedActivePaneWithTabs([first, second], first.id);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const firstTab = container
      .querySelector(`[data-tab-drag-handle="${first.id}"]`)
      ?.closest('[role="button"]');
    const secondTab = container
      .querySelector(`[data-tab-drag-handle="${second.id}"]`)
      ?.closest('[role="button"]');
    expect(firstTab).toBeInstanceOf(HTMLElement);
    expect(secondTab).toBeInstanceOf(HTMLElement);

    act(() => {
      dispatchPointer(firstTab!, "pointerdown", { clientX: 32, clientY: 12 });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 48,
        clientY: 12,
      });
    });
    expect(getWorkspaceTabDragSession()?.payload).toMatchObject({
      tabId: first.id,
      fromPaneId: "root",
    });

    act(() => {
      dispatchPointer(window as unknown as Element, "pointerup", {
        clientX: 48,
        clientY: 12,
      });
    });
    expect(getWorkspaceTabDragSession()).toBeNull();

    act(() => {
      dispatchPointer(secondTab!, "pointerdown", { clientX: 32, clientY: 12 });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 48,
        clientY: 12,
      });
    });
    expect(getWorkspaceTabDragSession()?.payload).toMatchObject({
      tabId: second.id,
      fromPaneId: "root",
    });
  });

  it("does not start tab drag from the close button", () => {
    const active = session("active-session");
    seedActivePaneWithTab(active);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const closeButton = container.querySelector(
      `[data-tab-close-button="${active.id}"]`,
    );
    const tab = closeButton?.closest('[role="button"]');
    expect(closeButton).toBeInstanceOf(HTMLElement);
    expect(tab).toBeInstanceOf(HTMLElement);

    act(() => {
      dispatchPointer(closeButton!, "pointerdown", {
        clientX: 110,
        clientY: 12,
      });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 140,
        clientY: 12,
      });
    });

    expect(getWorkspaceTabDragSession()).toBeNull();
  });

  it("does not start tab drag from the close icon SVG", () => {
    const active = session("active-session");
    seedActivePaneWithTab(active);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const closeButton = container.querySelector(
      `[data-tab-close-button="${active.id}"]`,
    );
    const closeIcon = closeButton?.querySelector("svg");
    expect(closeButton).toBeInstanceOf(HTMLElement);
    expect(closeIcon).toBeInstanceOf(SVGSVGElement);

    act(() => {
      dispatchPointer(closeIcon!, "pointerdown", {
        clientX: 110,
        clientY: 12,
      });
      dispatchPointer(window as unknown as Element, "pointermove", {
        clientX: 140,
        clientY: 12,
      });
    });

    expect(getWorkspaceTabDragSession()).toBeNull();

    act(() => {
      dispatchPointer(window as unknown as Element, "pointerup", {
        clientX: 140,
        clientY: 12,
      });
      closeIcon!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(useAppStore.getState().pendingRemoveId).toBe(active.id);
  });
});
