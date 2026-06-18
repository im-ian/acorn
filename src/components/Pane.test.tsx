import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatSessionState,
  Project,
  Session,
  SessionStatus,
} from "../lib/types";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({}) as Session),
  listSessions: vi.fn(async () => [] as Session[]),
  listProjects: vi.fn(async () => [] as Project[]),
  detectSessionStatuses: vi.fn(
    async (_ids: string[]) =>
      [] as { id: string; status: SessionStatus }[],
  ),
  ptyInWorktreeAll: vi.fn(async () => ({} as Record<string, boolean>)),
  fsReadFile: vi.fn(async () => ({
    content: "",
    size: 0,
    truncated: false,
    binary: false,
  })),
  fsGitDiffLines: vi.fn(async () => []),
  fsGitStatus: vi.fn(),
  fsGitDiffStats: vi.fn(),
  loadChatSessionState: vi.fn(),
  agentTranscriptSummary: vi.fn(),
  agentTranscriptSummaryAtPath: vi.fn(),
  ptyWrite: vi.fn(async () => undefined),
}));

vi.mock("../lib/api", () => ({
  CHAT_SESSION_STATE_CHANGED_EVENT: "acorn:chat-session-state-changed",
  FS_CHANGED_EVENT: "acorn:fs-changed",
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
    fsReadFile: mocks.fsReadFile,
    fsGitDiffLines: mocks.fsGitDiffLines,
    fsGitStatus: mocks.fsGitStatus,
    fsGitDiffStats: mocks.fsGitDiffStats,
    loadChatSessionState: mocks.loadChatSessionState,
    agentTranscriptSummary: mocks.agentTranscriptSummary,
    agentTranscriptSummaryAtPath: mocks.agentTranscriptSummaryAtPath,
    ptyWrite: mocks.ptyWrite,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
}));

import { Pane } from "./Pane";
import { useAppStore } from "../store";
import {
  clearFileDropTargetsForTest,
  dropFilePayloadsAtPoint,
  resolveFileDropTargetAtPoint,
} from "../lib/fileDropTargets";
import { defaultTabByGroup } from "../lib/rightPanelGroups";
import {
  cancelWorkspaceTabDrag,
  getWorkspaceTabDragSession,
} from "../lib/workspaceTabDrag";
import { makeWorkSummaryWorkspaceTab } from "../lib/workspaceTabs";

const REPO = "/Users/me/repo";
const HOME = "/Users/me";
const WORKTREE = `${REPO}/.acorn/worktrees/feature`;

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

function chatStateWithTokens(totalTokens: number): ChatSessionState {
  return {
    messages: [
      {
        id: "a1",
        role: "assistant",
        metadata: {
          provider_response: {
            usage: {
              input_tokens: totalTokens - 40,
              output_tokens: 40,
              total_tokens: totalTokens,
            },
          },
        },
      },
    ],
    turns: [],
  } as unknown as ChatSessionState;
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

function seedTwoPanesWithTabs(first: Session, second: Session): void {
  const layout = {
    kind: "split" as const,
    id: "split-test",
    direction: "horizontal" as const,
    a: { kind: "pane" as const, id: "root" },
    b: { kind: "pane" as const, id: "pane-2" },
  };
  const panes = {
    root: { id: "root", tabIds: [first.id], activeTabId: first.id },
    "pane-2": { id: "pane-2", tabIds: [second.id], activeTabId: second.id },
  };

  useAppStore.setState((s) => ({
    ...s,
    sessions: [first, second],
    activeProject: REPO,
    activeProjectFolderId: REPO,
    activeSessionId: first.id,
    activeTabId: first.id,
    workspaces: {
      ...s.workspaces,
      [REPO]: {
        layout,
        panes,
        focusedPaneId: "root",
      },
    },
    layout,
    panes,
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

function mockRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  const domRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  } as DOMRect;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => domRect,
  });
}

describe("Pane empty state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStore();
    clearFileDropTargetsForTest();
    cancelWorkspaceTabDrag();
    vi.clearAllMocks();
    mocks.fsGitStatus.mockResolvedValue({
      statuses: {},
      huge: false,
      limit: 500,
    });
    mocks.fsGitDiffStats.mockResolvedValue({});
    mocks.loadChatSessionState.mockResolvedValue(chatStateWithTokens(140));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearFileDropTargetsForTest();
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

  it("starts empty-pane project sessions at the project root from an active worktree workspace", async () => {
    const folderId = `project-folder:${REPO}:feature`;
    const created = session("new-session", {
      name: "repo",
      worktree_path: REPO,
      branch: "main",
      in_worktree: false,
    });
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([created]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);
    useAppStore.setState((s) => ({
      ...s,
      projectFolders: {
        [REPO]: [
          {
            id: REPO,
            repoPath: REPO,
            name: "Default",
            cwdPath: REPO,
            position: 0,
          },
          {
            id: folderId,
            repoPath: REPO,
            name: "Feature",
            cwdPath: WORKTREE,
            position: 1,
          },
        ],
      },
      activeProject: REPO,
      activeProjectFolderId: folderId,
      workspaces: {
        ...s.workspaces,
        [folderId]: {
          layout: { kind: "pane", id: "root" },
          panes: { root: { id: "root", tabIds: [], activeTabId: null } },
          focusedPaneId: "root",
        },
      },
      layout: { kind: "pane", id: "root" },
      panes: { root: { id: "root", tabIds: [], activeTabId: null } },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
    }));

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const emptyPane = container.querySelector('[role="button"]');
    expect(emptyPane).not.toBeNull();

    await act(async () => {
      emptyPane?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
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

  it("starts tab-strip sessions at the project root when the active tab is a worktree session", async () => {
    const worker = session("worker", {
      name: "worker",
      repo_path: REPO,
      worktree_path: WORKTREE,
      branch: "feature",
      in_worktree: true,
    });
    const created = session("new-session", {
      name: "repo",
      repo_path: REPO,
      worktree_path: REPO,
      branch: "main",
      in_worktree: false,
    });
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([worker, created]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);
    seedActivePaneWithTab(worker);

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
      "repo",
      REPO,
      false,
      "regular",
      null,
    );
  });

  it("starts tab-strip sessions at the linked session root when the active tab is a work summary", async () => {
    const worker = session("worker", {
      name: "worker",
      repo_path: REPO,
      worktree_path: WORKTREE,
      branch: "feature",
      in_worktree: true,
    });
    const summaryTab = makeWorkSummaryWorkspaceTab({
      repoPath: WORKTREE,
      cwdPath: WORKTREE,
      sessionId: worker.id,
      title: "Worker Summary",
    });
    const created = session("new-session", {
      name: "repo",
      repo_path: REPO,
      worktree_path: REPO,
      branch: "main",
      in_worktree: false,
    });
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([worker, created]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);
    useAppStore.setState((s) => ({
      ...s,
      sessions: [worker],
      activeProject: REPO,
      activeProjectFolderId: REPO,
      activeSessionId: null,
      activeTabId: summaryTab.id,
      workspaceTabs: { [summaryTab.id]: summaryTab },
      workspaces: {
        ...s.workspaces,
        [REPO]: {
          layout: { kind: "pane", id: "root" },
          panes: {
            root: {
              id: "root",
              tabIds: [summaryTab.id],
              activeTabId: summaryTab.id,
            },
          },
          focusedPaneId: "root",
        },
      },
      panes: {
        root: {
          id: "root",
          tabIds: [summaryTab.id],
          activeTabId: summaryTab.id,
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
      "repo",
      REPO,
      false,
      "regular",
      null,
    );
  });

  it("keeps tab-strip double-click creation in linked work summary local scope", async () => {
    const local = session("local-session", {
      name: "terminal",
      repo_path: HOME,
      worktree_path: HOME,
      project_scoped: false,
    });
    const projectScopedSibling = session("project-session", {
      name: "project",
      repo_path: HOME,
      worktree_path: `${HOME}/.worktrees/project-session`,
      project_scoped: true,
    });
    const summaryTab = makeWorkSummaryWorkspaceTab({
      repoPath: HOME,
      cwdPath: HOME,
      sessionId: local.id,
      title: "Local Summary",
    });
    const created = session("local-session-2", {
      name: "terminal-2",
      repo_path: HOME,
      worktree_path: HOME,
      project_scoped: false,
    });
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([
      local,
      projectScopedSibling,
      created,
    ]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);
    useAppStore.setState((s) => ({
      ...s,
      sessions: [local, projectScopedSibling],
      activeProject: HOME,
      activeSessionId: null,
      activeTabId: summaryTab.id,
      workspaceTabs: { [summaryTab.id]: summaryTab },
      workspaces: {
        ...s.workspaces,
        [HOME]: {
          layout: { kind: "pane", id: "root" },
          panes: {
            root: {
              id: "root",
              tabIds: [summaryTab.id],
              activeTabId: summaryTab.id,
            },
          },
          focusedPaneId: "root",
        },
      },
      layout: { kind: "pane", id: "root" },
      panes: {
        root: {
          id: "root",
          tabIds: [summaryTab.id],
          activeTabId: summaryTab.id,
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

  it("creates root sessions from a work summary tab", async () => {
    const summaryTab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: WORKTREE,
      title: "Work Summary",
    });
    const created = session("new-session", {
      name: "repo",
      repo_path: REPO,
      worktree_path: REPO,
      branch: "main",
      in_worktree: false,
    });
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.listSessions.mockResolvedValueOnce([created]);
    mocks.listProjects.mockResolvedValueOnce([project(REPO)]);
    const pane = {
      id: "root",
      tabIds: [summaryTab.id],
      activeTabId: summaryTab.id,
    };
    useAppStore.setState((s) => ({
      ...s,
      sessions: [],
      activeProject: REPO,
      activeProjectFolderId: REPO,
      activeSessionId: null,
      activeTabId: summaryTab.id,
      workspaceTabs: { [summaryTab.id]: summaryTab },
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

    expect(mocks.createSession).toHaveBeenCalledWith(
      "repo",
      REPO,
      false,
      "regular",
      null,
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

  it("passes a work summary token baseline through pane tab rendering", async () => {
    const active = session("chat-session", { mode: "chat" });
    const summaryTab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: active.worktree_path,
      sessionId: active.id,
      title: "Chat Summary",
      tokenBaseline: {
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 50,
        messagesWithUsage: 1,
        capturedAt: "2026-01-01T00:00:00Z",
      },
    });
    const pane = {
      id: "root",
      tabIds: [summaryTab.id],
      activeTabId: summaryTab.id,
    };
    useAppStore.setState((s) => ({
      ...s,
      sessions: [active],
      activeProject: REPO,
      activeProjectFolderId: REPO,
      activeSessionId: active.id,
      activeTabId: summaryTab.id,
      workspaceTabs: { [summaryTab.id]: summaryTab },
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

    await act(async () => {
      root.render(<Pane paneId="root" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Session used");
    expect(container.textContent).toContain("Summary start");
    expect(container.textContent).toContain("50");
    expect(container.textContent).toContain("+90");
  });

  it("does not load work summary data in an unfocused pane", async () => {
    const active = session("chat-session", { mode: "chat" });
    const summaryTab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: active.worktree_path,
      sessionId: active.id,
      title: "Chat Summary",
    });
    const rootPane = {
      id: "root",
      tabIds: [active.id],
      activeTabId: active.id,
    };
    const summaryPane = {
      id: "pane-2",
      tabIds: [summaryTab.id],
      activeTabId: summaryTab.id,
    };
    const layout = {
      kind: "split" as const,
      id: "split-test",
      direction: "horizontal" as const,
      a: { kind: "pane" as const, id: "root" },
      b: { kind: "pane" as const, id: "pane-2" },
    };

    useAppStore.setState((s) => ({
      ...s,
      sessions: [active],
      activeProject: REPO,
      activeProjectFolderId: REPO,
      activeSessionId: active.id,
      activeTabId: active.id,
      workspaceTabs: { [summaryTab.id]: summaryTab },
      workspaces: {
        ...s.workspaces,
        [REPO]: {
          layout,
          panes: { root: rootPane, "pane-2": summaryPane },
          focusedPaneId: "root",
        },
      },
      layout,
      panes: { root: rootPane, "pane-2": summaryPane },
      focusedPaneId: "root",
    }));

    await act(async () => {
      root.render(<Pane paneId="pane-2" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Work Summary");
    expect(container.textContent).not.toContain("140 tokens");
    expect(mocks.fsGitStatus).not.toHaveBeenCalled();
    expect(mocks.loadChatSessionState).not.toHaveBeenCalled();
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

  it("resolves the tab strip as a file drop target and opens the file there", () => {
    const active = session("active-session");
    const filePath = `${REPO}/src/App.tsx`;
    seedActivePaneWithTab(active);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const tabStrip = container.querySelector('[data-pane-tab-strip="root"]');
    expect(tabStrip).not.toBeNull();
    mockRect(tabStrip!, { left: 0, top: 0, width: 320, height: 36 });

    const target = resolveFileDropTargetAtPoint(
      { x: 12, y: 12 },
      { path: filePath, entryKind: "file", source: "explorer" },
    );

    expect(target).toMatchObject({
      kind: "tab-strip",
      paneId: "root",
      purpose: "tab",
    });

    act(() => {
      dropFilePayloadsAtPoint(
        { x: 12, y: 12 },
        [{ path: filePath, entryKind: "file", source: "explorer" }],
      );
    });

    const state = useAppStore.getState();
    const pane = state.panes.root;
    expect(pane.tabIds).toHaveLength(2);
    expect(pane.activeTabId).not.toBe(active.id);
    expect(state.workspaceTabs[pane.activeTabId!]).toMatchObject({
      kind: "code",
      path: filePath,
      repoPath: REPO,
    });
  });

  it("ignores directories dropped on the tab strip", () => {
    const active = session("active-session");
    const dirPath = `${REPO}/src`;
    seedActivePaneWithTab(active);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const tabStrip = container.querySelector('[data-pane-tab-strip="root"]');
    expect(tabStrip).not.toBeNull();
    mockRect(tabStrip!, { left: 0, top: 0, width: 320, height: 36 });

    const target = dropFilePayloadsAtPoint(
      { x: 12, y: 12 },
      [{ path: dirPath, entryKind: "directory", source: "explorer" }],
    );

    const state = useAppStore.getState();
    const pane = state.panes.root;
    expect(target).toBeNull();
    expect(pane.tabIds).toEqual([active.id]);
    expect(pane.activeTabId).toBe(active.id);
  });

  it("writes file drops to the terminal in the hovered pane", () => {
    const first = session("pane-1-session", {
      worktree_path: `${REPO}/.worktrees/pane-1`,
    });
    const second = session("pane-2-session", {
      worktree_path: `${REPO}/.worktrees/pane-2`,
    });
    const filePath = `${second.worktree_path}/src/App.tsx`;
    seedTwoPanesWithTabs(first, second);

    act(() => {
      root.render(
        <>
          <Pane paneId="root" />
          <Pane paneId="pane-2" />
        </>,
      );
    });

    const pane2Body = container.querySelector('[data-pane-body="pane-2"]');
    expect(pane2Body).not.toBeNull();
    mockRect(pane2Body!, { left: 400, top: 40, width: 360, height: 300 });

    act(() => {
      dropFilePayloadsAtPoint(
        { x: 500, y: 120 },
        [{ path: filePath, entryKind: "file", source: "explorer" }],
      );
    });

    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
    expect(mocks.ptyWrite).toHaveBeenCalledWith(second.id, "src/App.tsx ");
    expect(useAppStore.getState().focusedPaneId).toBe("pane-2");
  });

  it("keeps the file mention prefix for Claude agent terminal drops", () => {
    const claude = session("claude-session", {
      agent_provider: "claude",
      worktree_path: `${REPO}/.worktrees/claude`,
    });
    const filePath = `${claude.worktree_path}/src/App.tsx`;
    seedActivePaneWithTab(claude);

    act(() => {
      root.render(<Pane paneId="root" />);
    });

    const paneBody = container.querySelector('[data-pane-body="root"]');
    expect(paneBody).not.toBeNull();
    mockRect(paneBody!, { left: 0, top: 40, width: 360, height: 300 });

    act(() => {
      dropFilePayloadsAtPoint(
        { x: 120, y: 120 },
        [{ path: filePath, entryKind: "file", source: "explorer" }],
      );
    });

    expect(mocks.ptyWrite).toHaveBeenCalledWith(claude.id, "@src/App.tsx ");
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
