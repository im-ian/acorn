import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerateSessionTitleResult,
  ChatSessionState,
  Project,
  Session,
  SessionNotification,
  SessionStatus,
} from "./lib/types";

// Mock the Tauri-backed API surface used by the store.
// Each method is a vi.fn so individual tests can stub return values.
vi.mock("./lib/api", () => {
  return {
    api: {
      loadStatus: vi.fn(async () => ({
        sessionsClean: true,
        projectsClean: true,
      })),
      listSessions: vi.fn(async () => [] as Session[]),
      listProjects: vi.fn(async () => [] as Project[]),
      detectSessionStatuses: vi.fn(
        async (_ids: string[]) =>
          [] as { id: string; status: SessionStatus }[],
      ),
      ptyInWorktreeAll: vi.fn(async () => ({} as Record<string, boolean>)),
      createSession: vi.fn(async () => ({}) as Session),
      removeSession: vi.fn(async () => null),
      removeWorktree: vi.fn(async () => null),
      renameSession: vi.fn(async () => ({}) as Session),
      generateSessionTitle: vi.fn(
        async () =>
          ({
            status: "skipped",
            session: {} as Session,
          }) as GenerateSessionTitleResult,
      ),
      loadChatSessionState: vi.fn(async () => ({
        messages: [],
        turns: [],
      }) as unknown as ChatSessionState),
      agentTranscriptSummary: vi.fn(async () => null),
      agentTranscriptSummaryAtPath: vi.fn(async () => null),
      addProject: vi.fn(async () => ({}) as Project),
      createNewProject: vi.fn(async () => ({}) as Project),
      removeProject: vi.fn(async () => []),
      reorderProjects: vi.fn(async (paths: string[]) =>
        paths.map<Project>((repo_path, i) => ({
          repo_path,
          name: repo_path,
          created_at: "2026-01-01",
          position: i,
        })),
      ),
      reorderSessions: vi.fn(async (_repoPath: string, _ids: string[]) =>
        [] as Session[],
      ),
    },
  };
});

import { api } from "./lib/api";
import { useAppStore } from "./store";
import { defaultTabByGroup } from "./lib/rightPanelGroups";
import { DEFAULT_SETTINGS, useSettings } from "./lib/settings";

const mockApi = vi.mocked(api);

const REPO_A = "/Users/me/repo-a";
const REPO_B = "/Users/me/repo-b";

function project(repoPath: string, position: number): Project {
  return {
    repo_path: repoPath,
    name: repoPath.split("/").pop() ?? repoPath,
    created_at: "2026-01-01T00:00:00Z",
    position,
  };
}

function session(
  id: string,
  repoPath: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    name: id,
    repo_path: repoPath,
    worktree_path: `${repoPath}/.worktrees/${id}`,
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

function notification(
  id: string,
  overrides: Partial<SessionNotification> = {},
): SessionNotification {
  return {
    id,
    sessionId: "s1",
    kind: "needs_input",
    status: "needs_input",
    previousStatus: "running",
    sessionName: "s1",
    projectName: "repo-a",
    repoPath: REPO_A,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function chatStateWithTokenTotal(totalTokens: number): ChatSessionState {
  return {
    schema_version: 1,
    session_id: "a1",
    session: {
      id: "a1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    messages: [
      {
        id: "a1",
        role: "assistant",
        content: "done",
        created_at: "2026-01-01T00:00:00Z",
        metadata: {
          provider_response: {
            usage: {
              input_tokens: totalTokens,
              total_tokens: totalTokens,
            },
          },
        },
      },
    ],
    turns: [],
    provider_threads: [],
    context_snapshots: [],
    memory: {
      session_id: "a1",
      important_decisions: [],
      facts: [],
      updated_at: "2026-01-01T00:00:00Z",
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * Reset the zustand store to a clean slate. We re-import the initial-shape
 * fields directly since zustand has no built-in reset.
 */
function resetStore(): void {
  useAppStore.setState(
    {
      sessions: [],
      projects: [],
      workspaces: {},
      projectFolders: {},
      sessionFolderIds: {},
      activeProject: null,
      activeProjectFolderId: null,
      layout: { kind: "pane", id: "root" },
      panes: { root: { id: "root", tabIds: [], activeTabId: null } },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
      workspaceViewMode: "panes",
      terminalPopupSessionId: null,
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
      autoCloseSessionIds: {},
      generatingSessionTitleIds: {},
    },
    false,
  );
}

async function seed(
  projects: Project[],
  sessions: Session[],
): Promise<void> {
  mockApi.listProjects.mockResolvedValueOnce(projects);
  mockApi.listSessions.mockResolvedValueOnce(sessions);
  await useAppStore.getState().refreshAll();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  // resetAllMocks clears both call history *and* the queued
  // mockResolvedValueOnce return values; clearAllMocks leaves the queue
  // intact, which can leak between tests under some runtimes.
  vi.resetAllMocks();
  // Re-establish the safe defaults that resetAllMocks just wiped.
  mockApi.loadStatus.mockResolvedValue({
    sessionsClean: true,
    projectsClean: true,
  });
  mockApi.listSessions.mockResolvedValue([]);
  mockApi.listProjects.mockResolvedValue([]);
  mockApi.detectSessionStatuses.mockResolvedValue([]);
  mockApi.removeSession.mockResolvedValue(null);
  mockApi.removeWorktree.mockResolvedValue(null);
  mockApi.removeProject.mockResolvedValue([]);
  mockApi.loadChatSessionState.mockResolvedValue({
    messages: [],
    turns: [],
  } as unknown as ChatSessionState);
  mockApi.agentTranscriptSummary.mockResolvedValue(null);
  useSettings.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    open: false,
    pendingTab: null,
  });
  resetStore();
});

describe("multi-input", () => {
  it("starts disabled and toggles in memory", () => {
    expect(useAppStore.getState().multiInputEnabled).toBe(false);
    expect(useAppStore.getState().toggleMultiInput()).toBe(true);
    expect(useAppStore.getState().multiInputEnabled).toBe(true);
    expect(useAppStore.getState().toggleMultiInput()).toBe(false);
    expect(useAppStore.getState().multiInputEnabled).toBe(false);
  });
});

describe("sessionNotifications", () => {
  it("adds newest notifications first and caps the in-memory list", () => {
    for (let i = 0; i < 105; i += 1) {
      useAppStore.getState().addSessionNotification(notification(`n${i}`));
    }

    const maxHistory = DEFAULT_SETTINGS.notifications.maxHistory;
    const items = useAppStore.getState().sessionNotifications;
    expect(items).toHaveLength(maxHistory);
    expect(items[0]?.id).toBe("n104");
    expect(items[items.length - 1]?.id).toBe(`n${105 - maxHistory}`);
  });

  it("marks individual and all notifications read, then clears read items when auto-delete is disabled", () => {
    useSettings.getState().patchNotifications({ autoDeleteRead: false });
    useAppStore.getState().addSessionNotification(notification("n1"));
    useAppStore.getState().addSessionNotification(notification("n2"));

    useAppStore.getState().markSessionNotificationRead("n1");
    expect(
      useAppStore
        .getState()
        .sessionNotifications.find((item) => item.id === "n1")?.readAt,
    ).toBeTruthy();
    expect(
      useAppStore
        .getState()
        .sessionNotifications.find((item) => item.id === "n2")?.readAt,
    ).toBeFalsy();

    useAppStore.getState().markAllSessionNotificationsRead();
    expect(
      useAppStore
        .getState()
        .sessionNotifications.every((item) => item.readAt),
    ).toBe(true);

    useAppStore.getState().clearReadSessionNotifications();
    expect(useAppStore.getState().sessionNotifications).toEqual([]);
  });

  it("dismisses one notification without touching others", () => {
    useAppStore.getState().addSessionNotification(notification("n1"));
    useAppStore.getState().addSessionNotification(notification("n2"));

    useAppStore.getState().dismissSessionNotification("n1");

    expect(
      useAppStore.getState().sessionNotifications.map((item) => item.id),
    ).toEqual(["n2"]);
  });
});

describe("session auto-close flags", () => {
  it("toggles per-session auto-close state", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A, { agent_provider: "codex" })],
    );

    useAppStore.getState().toggleSessionAutoClose("a1");
    expect(useAppStore.getState().autoCloseSessionIds).toEqual({ a1: true });

    useAppStore.getState().toggleSessionAutoClose("a1");
    expect(useAppStore.getState().autoCloseSessionIds).toEqual({});
  });

  it("ignores unknown session ids", () => {
    useAppStore.getState().toggleSessionAutoClose("missing");

    expect(useAppStore.getState().autoCloseSessionIds).toEqual({});
  });

  it("does not enable auto-close for plain terminal sessions", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("plain", REPO_A, { agent_provider: null })],
    );

    useAppStore.getState().toggleSessionAutoClose("plain");

    expect(useAppStore.getState().autoCloseSessionIds).toEqual({});
  });

  it("ignores control sessions because removing them can cascade", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("ctl", REPO_A, { kind: "control" })],
    );

    useAppStore.getState().toggleSessionAutoClose("ctl");

    expect(useAppStore.getState().autoCloseSessionIds).toEqual({});
  });
});

describe("refreshAll", () => {
  it("populates sessions, projects, workspaces and activates the first project with a session", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("s1", REPO_B)],
    );
    const s = useAppStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.projects).toHaveLength(2);
    expect(Object.keys(s.workspaces).sort()).toEqual([REPO_A, REPO_B].sort());
    expect(s.activeProject).toBe(REPO_B);
    expect(s.activeSessionId).toBe("s1");
  });

  it("falls back to the first project when no session exists", async () => {
    await seed([project(REPO_A, 0), project(REPO_B, 1)], []);
    expect(useAppStore.getState().activeProject).toBe(REPO_A);
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  it("can activate a local session workspace when there are no projects", async () => {
    const local = session("local", "/Users/me", { project_scoped: false });
    await seed([], [local]);
    expect(useAppStore.getState().activeProject).toBe("/Users/me");
    expect(useAppStore.getState().activeSessionId).toBe("local");
  });

  it("sets error on api failure and leaves loading false", async () => {
    mockApi.listSessions.mockRejectedValueOnce(new Error("boom"));
    mockApi.listProjects.mockResolvedValueOnce([]);
    await useAppStore.getState().refreshAll();
    expect(useAppStore.getState().error).toBe("boom");
    expect(useAppStore.getState().loading).toBe(false);
  });

  it("keeps successful session refresh data when project refresh fails", async () => {
    const root = session("root", REPO_A, { worktree_path: REPO_A });
    const web = session("web", REPO_A, { worktree_path: REPO_A });
    await seed([project(REPO_A, 0)], [root, web]);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    useAppStore.getState().moveSessionToProjectFolder("web", folder.id);

    mockApi.listSessions.mockResolvedValueOnce([root, web]);
    mockApi.listProjects.mockRejectedValueOnce(new Error("projects unavailable"));

    await useAppStore.getState().refreshAll();

    const s = useAppStore.getState();
    expect(s.error).toBe("projects unavailable");
    expect(s.loading).toBe(false);
    expect(s.sessionFolderIds.web).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["web"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual(["root"]);
  });
});

describe("selectSession", () => {
  it("switches the active project to the session's repo and focuses its pane", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("a1", REPO_A), session("b1", REPO_B)],
    );
    // After seed, activeProject is whichever project sorts first with sessions;
    // explicitly select b1 then switch to a1 to confirm cross-project selection.
    useAppStore.getState().selectSession("a1");
    expect(useAppStore.getState().activeProject).toBe(REPO_A);
    expect(useAppStore.getState().activeSessionId).toBe("a1");

    useAppStore.getState().selectSession("b1");
    expect(useAppStore.getState().activeProject).toBe(REPO_B);
    expect(useAppStore.getState().activeSessionId).toBe("b1");
  });

  it("clears the active session in the focused pane when given null", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    useAppStore.getState().selectSession(null);
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  it("is a no-op for unknown session ids", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    const before = useAppStore.getState();
    useAppStore.getState().selectSession("does-not-exist");
    const after = useAppStore.getState();
    expect(after.activeProject).toBe(before.activeProject);
    expect(after.activeSessionId).toBe(before.activeSessionId);
  });
});

describe("focusLocalSessions", () => {
  it("activates a local session so project focus is cleared in the UI", async () => {
    const local = session("local", "/Users/me", { project_scoped: false });
    await seed([project(REPO_A, 0)], [session("a1", REPO_A), local]);

    useAppStore.getState().focusLocalSessions();

    expect(useAppStore.getState().activeProject).toBe("/Users/me");
    expect(useAppStore.getState().activeSessionId).toBe("local");
  });

  it("clears project focus when there are no local sessions", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);

    useAppStore.getState().focusLocalSessions();

    expect(useAppStore.getState().activeProject).toBeNull();
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });
});

describe("local workspaces", () => {
  it("creates and preserves an empty local workspace", async () => {
    await seed([], []);

    const folder = useAppStore
      .getState()
      .createProjectFolder("/Users/me", "Scratch");

    expect(folder).toMatchObject({
      repoPath: "/Users/me",
      name: "Scratch",
      cwdPath: "/Users/me",
    });
    expect(useAppStore.getState().activeProject).toBe("/Users/me");
    expect(useAppStore.getState().activeProjectFolderId).toBe(folder!.id);
    expect(useAppStore.getState().workspaces[folder!.id]).toBeDefined();

    mockApi.listProjects.mockResolvedValueOnce([]);
    mockApi.listSessions.mockResolvedValueOnce([]);
    await useAppStore.getState().refreshAll();

    const s = useAppStore.getState();
    expect(s.projectFolders["/Users/me"].map((item) => item.id)).toEqual([
      "/Users/me",
      folder!.id,
    ]);
    expect(s.workspaces[folder!.id]).toBeDefined();
    expect(s.activeProjectFolderId).toBe(folder!.id);
  });

  it("moves local sessions between local workspaces", async () => {
    const local = session("local", "/Users/me", {
      project_scoped: false,
      worktree_path: "/Users/me",
    });
    await seed([], [local]);
    const folder = useAppStore
      .getState()
      .createProjectFolder("/Users/me", "Scratch")!;

    useAppStore.getState().moveSessionToProjectFolder("local", folder.id);

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.local).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["local"]);
    expect(s.workspaces["/Users/me"].panes.root.tabIds).toEqual([]);
  });

  it("assigns newly created local sessions to the requested local workspace", async () => {
    await seed([], []);
    const folder = useAppStore
      .getState()
      .createProjectFolder("/Users/me", "Scratch")!;
    const created = session("local-new", "/Users/me", {
      project_scoped: false,
      worktree_path: "/Users/me",
    });
    mockApi.createSession.mockResolvedValueOnce(created);
    mockApi.listProjects.mockResolvedValueOnce([]);
    mockApi.listSessions.mockResolvedValueOnce([created]);

    await useAppStore
      .getState()
      .createSession(
        "local-new",
        "/Users/me",
        false,
        "regular",
        null,
        false,
        "terminal",
        folder.id,
      );

    const s = useAppStore.getState();
    expect(s.sessionFolderIds["local-new"]).toBe(folder.id);
    expect(s.activeProject).toBe("/Users/me");
    expect(s.activeProjectFolderId).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["local-new"]);
  });
});

describe("setActiveProject", () => {
  it("recreates a missing workspace mirror for a known project", async () => {
    await seed([project(REPO_A, 0)], []);
    useAppStore.setState({
      activeProject: null,
      activeTabId: null,
      activeSessionId: null,
      workspaces: {},
    });

    useAppStore.getState().setActiveProject(REPO_A);

    const s = useAppStore.getState();
    expect(s.activeProject).toBe(REPO_A);
    expect(s.workspaces[REPO_A]).toBeDefined();
    expect(s.activeTabId).toBeNull();
    expect(s.activeSessionId).toBeNull();
  });
});

describe("project folders", () => {
  it("creates a named conceptual folder and moves sessions into it explicitly", async () => {
    const root = session("root", REPO_A, { worktree_path: REPO_A });
    const web = session("web", REPO_A, {
      worktree_path: `${REPO_A}/apps/web`,
    });
    await seed([project(REPO_A, 0)], [root, web]);

    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend");

    expect(folder).toMatchObject({
      repoPath: REPO_A,
      name: "Frontend",
      cwdPath: REPO_A,
    });
    const createdState = useAppStore.getState();
    expect(createdState.activeProject).toBe(REPO_A);
    expect(createdState.activeProjectFolderId).toBe(folder!.id);
    expect(createdState.workspaces[folder!.id].panes.root.tabIds).toEqual([]);
    expect(createdState.workspaces[REPO_A].panes.root.tabIds).toEqual([
      "root",
      "web",
    ]);

    useAppStore.getState().moveSessionToProjectFolder("web", folder!.id);

    const movedState = useAppStore.getState();
    expect(movedState.sessionFolderIds.web).toBe(folder!.id);
    expect(movedState.workspaces[folder!.id].panes.root.tabIds).toEqual(["web"]);
    expect(movedState.workspaces[REPO_A].panes.root.tabIds).toEqual(["root"]);
  });

  it("creates a session from the project root and assigns it to the folder", async () => {
    await seed([project(REPO_A, 0)], []);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    const created = session("web1", REPO_A, { worktree_path: REPO_A });
    mockApi.createSession.mockResolvedValueOnce(created);
    mockApi.listSessions.mockResolvedValueOnce([created]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);

    await useAppStore
      .getState()
      .createSession(
        "web",
        folder.cwdPath,
        false,
        "regular",
        null,
        true,
        "terminal",
        folder.id,
      );

    expect(mockApi.createSession).toHaveBeenCalledWith(
      "web",
      REPO_A,
      false,
      "regular",
      null,
    );
    const s = useAppStore.getState();
    expect(s.sessionFolderIds.web1).toBe(folder.id);
    expect(s.activeProject).toBe(REPO_A);
    expect(s.activeProjectFolderId).toBe(folder.id);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["web1"]);
  });

  it("places an ipc-created root session into an exact workspace id", async () => {
    await seed([project(REPO_A, 0)], []);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    const created = session("ipc", REPO_A, { worktree_path: REPO_A });
    mockApi.listSessions.mockResolvedValueOnce([created]);

    await useAppStore.getState().refreshSessions();
    useAppStore.getState().placeSessionInWorkspace("ipc", {
      workspaceId: folder.id,
      workspacePath: REPO_A,
    });

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.ipc).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["ipc"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual([]);
  });

  it("does not guess a named root workspace from a path-only ipc hint", async () => {
    await seed([project(REPO_A, 0)], []);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    const created = session("ipc", REPO_A, { worktree_path: REPO_A });
    mockApi.listSessions.mockResolvedValueOnce([created]);

    await useAppStore.getState().refreshSessions();
    useAppStore.getState().placeSessionInWorkspace("ipc", {
      workspacePath: REPO_A,
    });

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.ipc).toBeUndefined();
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual([]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual(["ipc"]);
  });

  it("creates a session in a worktree workspace using the project root plus cwd", async () => {
    await seed([project(REPO_A, 0)], []);
    const worktreePath = `${REPO_A}/.acorn/worktrees/repo-a-worktree-123456789abc`;
    const folder = useAppStore
      .getState()
      .createProjectFolder(REPO_A, "repo-a-worktree-123456789abc", worktreePath)!;
    const created = session("wt-session", REPO_A, {
      worktree_path: worktreePath,
    });
    mockApi.createSession.mockResolvedValueOnce(created);
    mockApi.listSessions.mockResolvedValueOnce([created]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);

    await useAppStore
      .getState()
      .createSession(
        "worker",
        REPO_A,
        false,
        "regular",
        null,
        true,
        "terminal",
        folder.id,
        folder.cwdPath,
      );

    expect(mockApi.createSession).toHaveBeenCalledWith(
      "worker",
      REPO_A,
      false,
      "regular",
      null,
      true,
      "terminal",
      worktreePath,
    );
    const s = useAppStore.getState();
    expect(s.sessionFolderIds["wt-session"]).toBe(folder.id);
    expect(s.activeProject).toBe(REPO_A);
    expect(s.activeProjectFolderId).toBe(folder.id);
  });

  it("does not place a new isolated session into a different worktree workspace", async () => {
    const worktreePath = `${REPO_A}/.acorn/worktrees/repo-a-worktree-123`;
    const root = session("root", REPO_A, { worktree_path: REPO_A });
    const worktreeSession = session("wt-session", REPO_A, {
      worktree_path: worktreePath,
      branch: "repo-a-worktree-123",
    });
    await seed([project(REPO_A, 0)], [root, worktreeSession]);
    const folder = useAppStore
      .getState()
      .createProjectFolder(REPO_A, "Worktree", worktreePath)!;
    useAppStore.getState().moveSessionToProjectFolder("wt-session", folder.id);
    useAppStore.getState().selectSession("wt-session");

    const created = session("isolated-new", REPO_A, {
      isolated: true,
      worktree_path: `${REPO_A}/.acorn/worktrees/isolated-new`,
      branch: "isolated-new",
    });
    mockApi.createSession.mockResolvedValueOnce(created);
    mockApi.listSessions.mockResolvedValueOnce([root, worktreeSession, created]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);

    await useAppStore
      .getState()
      .createSession(
        "isolated-new",
        REPO_A,
        true,
        "regular",
        null,
        true,
        "terminal",
        folder.id,
        worktreePath,
      );

    const s = useAppStore.getState();
    expect(s.sessionFolderIds["isolated-new"]).toBeUndefined();
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["wt-session"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toContain("isolated-new");
  });

  it("keeps a new session workspace assignment when project refresh wins the race", async () => {
    await seed([project(REPO_A, 0)], []);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    const created = session("web1", REPO_A, { worktree_path: REPO_A });
    const sessionsRefresh = deferred<Session[]>();
    mockApi.createSession.mockResolvedValueOnce(created);
    mockApi.listSessions.mockImplementationOnce(() => sessionsRefresh.promise);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);

    const create = useAppStore
      .getState()
      .createSession(
        "web",
        REPO_A,
        false,
        "regular",
        null,
        true,
        "terminal",
        folder.id,
      );

    await Promise.resolve();
    await Promise.resolve();
    sessionsRefresh.resolve([created]);
    await create;

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.web1).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["web1"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual([]);
  });

  it("preserves a new session workspace assignment when session refresh fails", async () => {
    await seed([project(REPO_A, 0)], []);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    const created = session("web1", REPO_A, { worktree_path: REPO_A });
    mockApi.createSession.mockResolvedValueOnce(created);
    mockApi.listSessions.mockRejectedValueOnce(new Error("sessions unavailable"));
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);

    await useAppStore
      .getState()
      .createSession(
        "web",
        REPO_A,
        false,
        "regular",
        null,
        true,
        "terminal",
        folder.id,
      );

    expect(useAppStore.getState().sessionFolderIds.web1).toBe(folder.id);

    mockApi.listSessions.mockResolvedValueOnce([created]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    await useAppStore.getState().refreshAll();

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.web1).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["web1"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual([]);
  });

  it("rehydrates workspace assignments before the first refresh", async () => {
    window.localStorage.clear();
    const root = session("root", REPO_A, { worktree_path: REPO_A });
    const web = session("web", REPO_A, { worktree_path: REPO_A });
    await seed([project(REPO_A, 0)], [root, web]);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    useAppStore.getState().moveSessionToProjectFolder("web", folder.id);

    const raw = window.localStorage.getItem("acorn-workspaces");
    expect(raw).not.toBeNull();

    resetStore();
    window.localStorage.setItem("acorn-workspaces", raw!);
    await useAppStore.persist.rehydrate();
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    mockApi.listSessions.mockResolvedValueOnce([root, web]);
    await useAppStore.getState().refreshAll();

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.web).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["web"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual(["root"]);
  });

  it("keeps rehydrated workspace assignments when projects refresh before sessions", async () => {
    window.localStorage.clear();
    const root = session("root", REPO_A, { worktree_path: REPO_A });
    const web = session("web", REPO_A, { worktree_path: REPO_A });
    await seed([project(REPO_A, 0)], [root, web]);
    const folder = useAppStore.getState().createProjectFolder(REPO_A, "Frontend")!;
    useAppStore.getState().moveSessionToProjectFolder("web", folder.id);

    const raw = window.localStorage.getItem("acorn-workspaces");
    expect(raw).not.toBeNull();

    resetStore();
    window.localStorage.setItem("acorn-workspaces", raw!);
    await useAppStore.persist.rehydrate();

    const sessionsRefresh = deferred<Session[]>();
    mockApi.listSessions.mockImplementationOnce(() => sessionsRefresh.promise);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    const refresh = useAppStore.getState().refreshAll();

    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().sessionFolderIds.web).toBe(folder.id);

    sessionsRefresh.resolve([root, web]);
    await refresh;

    const s = useAppStore.getState();
    expect(s.sessionFolderIds.web).toBe(folder.id);
    expect(s.workspaces[folder.id].panes.root.tabIds).toEqual(["web"]);
    expect(s.workspaces[REPO_A].panes.root.tabIds).toEqual(["root"]);
  });

  it("creates a named workspace rooted at a supplied worktree path", async () => {
    await seed([project(REPO_A, 0)], []);
    const folder = useAppStore
      .getState()
      .createProjectFolder(
        REPO_A,
        "repo-a-worktree-123456789abc",
        `${REPO_A}/.acorn/worktrees/repo-a-worktree-123456789abc`,
      );

    expect(folder).toMatchObject({
      repoPath: REPO_A,
      name: "repo-a-worktree-123456789abc",
      cwdPath: `${REPO_A}/.acorn/worktrees/repo-a-worktree-123456789abc`,
    });
    const s = useAppStore.getState();
    expect(s.activeProject).toBe(REPO_A);
    expect(s.activeProjectFolderId).toBe(folder!.id);
    expect(s.workspaces[folder!.id]).toBeDefined();
  });

  it("reorders named project folders without moving the default folder", async () => {
    await seed([project(REPO_A, 0)], []);
    const frontend = useAppStore
      .getState()
      .createProjectFolder(REPO_A, "Frontend")!;
    const backend = useAppStore
      .getState()
      .createProjectFolder(REPO_A, "Backend")!;

    useAppStore
      .getState()
      .reorderProjectFolders(REPO_A, [backend.id, frontend.id]);

    const folders = useAppStore.getState().projectFolders[REPO_A];
    expect(folders.map((folder) => folder.id)).toEqual([
      REPO_A,
      backend.id,
      frontend.id,
    ]);
    expect(folders.map((folder) => folder.position)).toEqual([0, 1, 2]);
  });
});

describe("workspace tabs", () => {
  it("opens a code viewer as a workspace tab without making it the active session", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);

    useAppStore.getState().openCodeViewerTab(`${REPO_A}/src/App.tsx`);

    const s = useAppStore.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.activeTabId).toMatch(/^code-viewer:/);
    expect(s.sessions.map((x) => x.id)).toEqual(["a1"]);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual([
      "a1",
      s.activeTabId,
    ]);
    expect(s.workspaceTabs[s.activeTabId!]).toMatchObject({
      kind: "code",
      lifecycle: "ephemeral",
      path: `${REPO_A}/src/App.tsx`,
      repoPath: REPO_A,
      title: "App.tsx",
    });
  });

  it("opens a work summary tab for the active session worktree", async () => {
    const active = session("a1", REPO_A, {
      name: "Feature runner",
      worktree_path: `${REPO_A}/.worktrees/a1`,
      mode: "chat",
    });
    await seed([project(REPO_A, 0)], [active]);
    mockApi.loadChatSessionState.mockResolvedValueOnce(
      chatStateWithTokenTotal(120),
    );

    await useAppStore.getState().openWorkSummaryTab();
    await flushPromises();

    const s = useAppStore.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.activeTabId).toMatch(/^work-summary:/);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1", s.activeTabId]);
    expect(s.workspaceTabs[s.activeTabId!]).toMatchObject({
      kind: "work-summary",
      lifecycle: "ephemeral",
      repoPath: REPO_A,
      cwdPath: `${REPO_A}/.worktrees/a1`,
      sessionId: "a1",
      title: "Feature runner Summary",
      tokenBaseline: expect.objectContaining({
        inputTokens: 120,
        totalTokens: 120,
        messagesWithUsage: 1,
      }),
    });
  });

  it("records a work summary token baseline from a terminal agent transcript", async () => {
    const active = session("a1", REPO_A, {
      name: "Feature runner",
      worktree_path: `${REPO_A}/.worktrees/a1`,
      mode: "terminal",
      agent_transcript_id: "transcript-1",
    });
    await seed([project(REPO_A, 0)], [active]);
    mockApi.agentTranscriptSummary.mockResolvedValueOnce({
      provider: "codex",
      id: "transcript-1",
      transcript_path: "/Users/me/.codex/sessions/transcript-1.jsonl",
      updated_at: 1_766_000_000,
      message_count: 4,
      user_messages: 2,
      assistant_messages: 2,
      turn_count: 2,
      complete_turns: 2,
      running_turns: 0,
      token_usage: {
        input_tokens: 220,
        output_tokens: 80,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
        reasoning_tokens: 12,
        total_tokens: 320,
        messages_with_usage: 1,
      },
    });

    await useAppStore.getState().openWorkSummaryTab();
    await flushPromises();

    const s = useAppStore.getState();
    expect(mockApi.agentTranscriptSummary).toHaveBeenCalledWith(
      REPO_A,
      "transcript-1",
    );
    expect(s.workspaceTabs[s.activeTabId!]).toMatchObject({
      kind: "work-summary",
      sessionId: "a1",
      tokenBaseline: expect.objectContaining({
        inputTokens: 220,
        outputTokens: 80,
        cacheReadTokens: 20,
        reasoningTokens: 12,
        totalTokens: 320,
        messagesWithUsage: 1,
      }),
    });
  });

  it("opens a work summary tab before terminal token baseline loading finishes", async () => {
    const active = session("a1", REPO_A, {
      name: "Feature runner",
      worktree_path: `${REPO_A}/.worktrees/a1`,
      mode: "terminal",
      agent_transcript_id: "transcript-1",
    });
    await seed([project(REPO_A, 0)], [active]);
    const pendingSummary = deferred<Awaited<
      ReturnType<typeof mockApi.agentTranscriptSummary>
    >>();
    mockApi.agentTranscriptSummary.mockReturnValueOnce(pendingSummary.promise);

    const openPromise = useAppStore.getState().openWorkSummaryTab();
    await Promise.resolve();

    let state = useAppStore.getState();
    expect(state.activeTabId).toMatch(/^work-summary:/);
    const tabId = state.activeTabId!;
    expect(state.workspaceTabs[tabId]).toMatchObject({
      kind: "work-summary",
      sessionId: "a1",
    });
    expect(state.workspaceTabs[tabId]).not.toHaveProperty("tokenBaseline");

    pendingSummary.resolve({
      provider: "codex",
      id: "transcript-1",
      transcript_path: "/Users/me/.codex/sessions/transcript-1.jsonl",
      updated_at: 1_766_000_000,
      message_count: 4,
      user_messages: 2,
      assistant_messages: 2,
      turn_count: 2,
      complete_turns: 2,
      running_turns: 0,
      token_usage: {
        input_tokens: 220,
        output_tokens: 80,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
        reasoning_tokens: 12,
        total_tokens: 320,
        messages_with_usage: 1,
      },
    });
    await openPromise;
    await Promise.resolve();
    await Promise.resolve();

    state = useAppStore.getState();
    expect(state.workspaceTabs[tabId]).toMatchObject({
      tokenBaseline: expect.objectContaining({
        totalTokens: 320,
      }),
    });
  });

  it("reuses an existing work summary tab for the same session", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);

    await useAppStore.getState().openWorkSummaryTab();
    const tabId = useAppStore.getState().activeTabId!;
    useAppStore.getState().selectSession("a1");
    await useAppStore.getState().openWorkSummaryTab();

    const s = useAppStore.getState();
    expect(s.activeTabId).toBe(tabId);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1", tabId]);
    expect(
      Object.values(s.workspaceTabs).filter(
        (tab) => tab.kind === "work-summary",
      ),
    ).toHaveLength(1);
  });

  it("scopes code viewer tabs to the active session worktree", async () => {
    const s1 = session("a1", REPO_A, {
      worktree_path: `${REPO_A}/.worktrees/a1`,
    });
    await seed([project(REPO_A, 0)], [s1]);

    useAppStore
      .getState()
      .openCodeViewerTab(`${s1.worktree_path}/src/App.tsx`, s1.worktree_path);

    const s = useAppStore.getState();
    expect(s.workspaceTabs[s.activeTabId!]).toMatchObject({
      kind: "code",
      path: `${s1.worktree_path}/src/App.tsx`,
      repoPath: s1.worktree_path,
    });
  });

  it("updates an existing code viewer tab with a line target", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);

    useAppStore
      .getState()
      .openCodeViewerTab(`${REPO_A}/src/App.tsx`, REPO_A, { line: 78 });
    const tabId = useAppStore.getState().activeTabId!;
    const firstTab = useAppStore.getState().workspaceTabs[tabId];
    if (firstTab?.kind !== "code") throw new Error("expected code tab");
    const firstTarget = firstTab.target;

    useAppStore
      .getState()
      .openCodeViewerTab(`${REPO_A}/src/App.tsx`, REPO_A, { line: 12 });

    const s = useAppStore.getState();
    const updatedTab = s.workspaceTabs[tabId];
    if (updatedTab?.kind !== "code") throw new Error("expected code tab");
    expect(s.activeTabId).toBe(tabId);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1", tabId]);
    expect(updatedTab.target).toMatchObject({ line: 12 });
    expect(updatedTab.target?.token).not.toBe(firstTarget?.token);
  });

  it("merges code viewer scroll and zoom state into the existing tab", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);

    useAppStore.getState().openCodeViewerTab(`${REPO_A}/src/App.tsx`, REPO_A);
    const tabId = useAppStore.getState().activeTabId!;

    useAppStore.getState().updateCodeViewerTabViewState(tabId, {
      code: { scrollTop: 120, scrollLeft: 4 },
    });
    useAppStore.getState().updateCodeViewerTabViewState(tabId, {
      media: { imageZoom: 1.5 },
    });
    useAppStore.getState().updateCodeViewerTabViewState(tabId, {
      code: { previewMarkdown: true },
    });

    const tab = useAppStore.getState().workspaceTabs[tabId];
    expect(tab).toMatchObject({
      kind: "code",
      viewState: {
        code: {
          scrollTop: 120,
          scrollLeft: 4,
          previewMarkdown: true,
        },
        media: {
          imageZoom: 1.5,
        },
      },
    });
  });

  it("reselects a worktree-scoped code tab after switching projects", async () => {
    const a1 = session("a1", REPO_A, {
      worktree_path: `${REPO_A}/.worktrees/a1`,
    });
    const b1 = session("b1", REPO_B);
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [a1, b1],
    );

    useAppStore
      .getState()
      .openCodeViewerTab(`${a1.worktree_path}/README.md`, a1.worktree_path);
    const tabId = useAppStore.getState().activeTabId!;

    useAppStore.getState().selectSession("a1");
    useAppStore.getState().setActiveProject(REPO_B);
    useAppStore.getState().setActiveProject(REPO_A);
    useAppStore.getState().selectTab(tabId);

    const s = useAppStore.getState();
    expect(s.activeProject).toBe(REPO_A);
    expect(s.activeTabId).toBe(tabId);
    expect(s.activeSessionId).toBeNull();
    expect(s.workspaceTabs[tabId]).toMatchObject({
      path: `${a1.worktree_path}/README.md`,
      repoPath: a1.worktree_path,
    });
  });

  it("closes the active code viewer instead of requesting session removal", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    useAppStore.getState().openCodeViewerTab(`${REPO_A}/src/App.tsx`);
    const tabId = useAppStore.getState().activeTabId!;

    useAppStore.getState().closeFocusedTab();

    const s = useAppStore.getState();
    expect(s.pendingRemoveId).toBeNull();
    expect(s.workspaceTabs[tabId]).toBeUndefined();
    expect(s.activeTabId).toBe("a1");
    expect(s.activeSessionId).toBe("a1");
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1"]);
  });

  it("returns to the last focused session when closing an active code viewer", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    useAppStore.getState().selectSession("a2");
    useAppStore.getState().openCodeViewerTab(`${REPO_A}/src/App.tsx`);
    const tabId = useAppStore.getState().activeTabId!;

    useAppStore.getState().closeWorkspaceTab(tabId);

    const s = useAppStore.getState();
    expect(s.workspaceTabs[tabId]).toBeUndefined();
    expect(s.activeTabId).toBe("a2");
    expect(s.activeSessionId).toBe("a2");
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1", "a2"]);
  });

  it("uses pane activation history when closing an active code viewer", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    useAppStore.getState().openCodeViewerTab(`${REPO_A}/src/App.tsx`);
    const appTabId = useAppStore.getState().activeTabId!;
    useAppStore.getState().selectSession("a1");
    useAppStore.getState().openCodeViewerTab(`${REPO_A}/README.md`);
    const readmeTabId = useAppStore.getState().activeTabId!;
    useAppStore.getState().selectTab(appTabId);

    useAppStore.getState().closeWorkspaceTab(appTabId);

    const s = useAppStore.getState();
    expect(s.activeTabId).toBe(readmeTabId);
    expect(s.activeSessionId).toBeNull();
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1", readmeTabId]);
  });
});

describe("removeSession", () => {
  it("removes the tab locally before the backend worktree delete finishes", async () => {
    const a1 = session("a1", REPO_A, {
      worktree_path: `${REPO_A}/.worktrees/a1`,
    });
    const a2 = session("a2", REPO_A, {
      worktree_path: `${REPO_A}/.worktrees/a2`,
    });
    await seed([project(REPO_A, 0)], [a1, a2]);
    useAppStore.getState().selectSession("a1");

    const pending = deferred<null>();
    mockApi.removeSession.mockReturnValueOnce(pending.promise);
    mockApi.listSessions.mockResolvedValue([a2]);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);

    const removal = useAppStore.getState().removeSession("a1", true);

    expect(mockApi.removeSession).toHaveBeenCalledWith("a1", true);
    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual(["a2"]);
    expect(useAppStore.getState().activeSessionId).toBe("a2");

    pending.resolve(null);
    await removal;
    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual(["a2"]);
  });

  it("removes session activity locally before the backend delete finishes", async () => {
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    await seed([project(REPO_A, 0)], [a1, a2]);
    useAppStore.getState().addSessionNotification(
      notification("n1", { sessionId: "a1" }),
    );
    useAppStore.getState().addSessionNotification(
      notification("n2", { sessionId: "a2" }),
    );
    useAppStore.setState({
      autoCloseSessionIds: { a1: true, a2: true },
    });

    const pending = deferred<null>();
    mockApi.removeSession.mockReturnValueOnce(pending.promise);
    mockApi.listSessions.mockResolvedValue([a2]);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);

    const removal = useAppStore.getState().removeSession("a1", true);

    expect(
      useAppStore.getState().sessionNotifications.map((item) => item.id),
    ).toEqual(["n2"]);
    expect(useAppStore.getState().autoCloseSessionIds).toEqual({ a2: true });

    pending.resolve(null);
    await removal;
  });

  it("refreshes from the backend if optimistic removal fails", async () => {
    const a1 = session("a1", REPO_A);
    await seed([project(REPO_A, 0)], [a1]);

    mockApi.removeSession.mockRejectedValueOnce(new Error("delete failed"));
    mockApi.listSessions.mockResolvedValue([a1]);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);

    await useAppStore.getState().removeSession("a1", true);

    const s = useAppStore.getState();
    expect(s.error).toBe("delete failed");
    expect(s.sessions.map((session) => session.id)).toEqual(["a1"]);
    expect(s.activeSessionId).toBe("a1");
  });

  it("refuses to delete a worktree while another session still uses it", async () => {
    const worktreePath = `${REPO_A}/.worktrees/shared`;
    const a1 = session("a1", REPO_A, {
      isolated: true,
      worktree_path: worktreePath,
    });
    const a2 = session("a2", REPO_A, {
      repo_path: REPO_B,
      isolated: true,
      worktree_path: `${worktreePath}/`,
    });
    await seed([project(REPO_A, 0), project(REPO_B, 1)], [a1, a2]);

    const removed = await useAppStore.getState().removeSession("a1", true);

    expect(removed).toBeNull();
    expect(mockApi.removeSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(useAppStore.getState().error).toBe(
      "Close other sessions using this worktree before removing it.",
    );
  });

  it("allows worktree deletion when only control-owned workers share it", async () => {
    const worktreePath = `${REPO_A}/.worktrees/shared`;
    const control = session("ctl", REPO_A, {
      kind: "control",
      isolated: true,
      worktree_path: worktreePath,
    });
    const worker = session("worker", REPO_A, {
      worktree_path: `${worktreePath}/`,
      owner: { kind: "control", session_id: "ctl" },
    });
    await seed([project(REPO_A, 0)], [control, worker]);

    mockApi.removeSession.mockResolvedValueOnce(null);
    mockApi.listSessions.mockResolvedValue([]);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);

    const removed = await useAppStore.getState().removeSession("ctl", true);

    expect(removed).toBeNull();
    expect(mockApi.removeSession).toHaveBeenCalledWith("ctl", true);
    expect(useAppStore.getState().error).toBeNull();
  });

  it("collapses an empty split pane before the backend worktree delete finishes", async () => {
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    await seed([project(REPO_A, 0)], [a1, a2]);
    // Split, then move a2 to the new pane so each pane holds exactly one tab.
    useAppStore.getState().splitFocusedPane("horizontal");
    const focusedAfterSplit = useAppStore.getState().focusedPaneId;
    const sourcePaneId = Object.keys(useAppStore.getState().panes).find(
      (pid) => pid !== focusedAfterSplit,
    )!;
    useAppStore.getState().moveTab({
      tabId: "a2",
      fromPaneId: sourcePaneId,
      toPaneId: focusedAfterSplit,
    });
    expect(useAppStore.getState().layout.kind).toBe("split");

    const pending = deferred<null>();
    mockApi.removeSession.mockReturnValueOnce(pending.promise);
    mockApi.listSessions.mockResolvedValue([a1]);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);

    const removal = useAppStore.getState().removeSession("a2", true);

    // Backend hasn't resolved yet — but the empty pane should already be gone.
    const mid = useAppStore.getState();
    expect(mid.layout.kind).toBe("pane");
    expect(Object.keys(mid.panes)).toHaveLength(1);
    expect(mid.panes[mid.focusedPaneId].tabIds).toEqual(["a1"]);
    expect(mid.activeSessionId).toBe("a1");

    pending.resolve(null);
    await removal;

    const after = useAppStore.getState();
    expect(after.layout.kind).toBe("pane");
    expect(after.sessions.map((s) => s.id)).toEqual(["a1"]);
  });

  it("does not collapse panes in a workspace that is not active", async () => {
    const a1 = session("a1", REPO_A);
    const b1 = session("b1", REPO_B);
    const b2 = session("b2", REPO_B);
    await seed([project(REPO_A, 0), project(REPO_B, 1)], [a1, b1, b2]);

    // Set up REPO_B with a split where each pane has one tab.
    useAppStore.getState().setActiveProject(REPO_B);
    useAppStore.getState().splitFocusedPane("horizontal");
    const bFocused = useAppStore.getState().focusedPaneId;
    const bSource = Object.keys(useAppStore.getState().panes).find(
      (pid) => pid !== bFocused,
    )!;
    useAppStore.getState().moveTab({
      tabId: "b2",
      fromPaneId: bSource,
      toPaneId: bFocused,
    });
    expect(useAppStore.getState().layout.kind).toBe("split");

    // Switch active project to REPO_A before the remove. The pane-collapse
    // side effect must only run for the *active* workspace.
    useAppStore.getState().setActiveProject(REPO_A);
    const aLayoutBefore = useAppStore.getState().layout;

    mockApi.listSessions.mockResolvedValue([a1, b1]);
    mockApi.listProjects.mockResolvedValue([
      project(REPO_A, 0),
      project(REPO_B, 1),
    ]);

    await useAppStore.getState().removeSession("b2", true);

    const after = useAppStore.getState();
    // REPO_A workspace was active during the remove — its layout is untouched.
    expect(after.activeProject).toBe(REPO_A);
    expect(after.layout).toEqual(aLayoutBefore);
    // REPO_B still has the split structure (collapse only happens for the
    // active workspace; the empty pane is left for B to clean up next time).
    expect(Object.keys(after.workspaces[REPO_B].panes)).toHaveLength(2);
    expect(after.sessions.map((s) => s.id).sort()).toEqual(["a1", "b1"]);
  });
});

describe("splitFocusedPane", () => {
  it("uses the configured default workspace mode for new project workspaces", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        interface: {
          ...DEFAULT_SETTINGS.interface,
          defaultWorkspaceViewMode: "kanban",
        },
      },
    });

    await seed([project(REPO_A, 0)], []);

    const state = useAppStore.getState();
    expect(state.workspaceViewMode).toBe("kanban");
    expect(state.workspaces[REPO_A].viewMode).toBe("kanban");
  });

  it("preserves an explicit project mode when hydrating old workspaces with a missing default view mode", async () => {
    window.localStorage.clear();
    await seed(
      [project(REPO_A, 0)],
      [session("root", REPO_A), session("web", REPO_A)],
    );
    const folder = useAppStore
      .getState()
      .createProjectFolder(REPO_A, "Frontend", `${REPO_A}/web`);
    expect(folder).not.toBeNull();
    useAppStore.getState().setWorkspaceViewMode("kanban");

    const raw = window.localStorage.getItem("acorn-workspaces");
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    delete persisted.state.workspaces[REPO_A].viewMode;
    persisted.state.activeProject = REPO_A;
    persisted.state.activeProjectFolderId = REPO_A;

    resetStore();
    window.localStorage.setItem("acorn-workspaces", JSON.stringify(persisted));
    await useAppStore.persist.rehydrate();

    const state = useAppStore.getState();
    expect(state.workspaceViewMode).toBe("kanban");
    expect(state.workspaces[REPO_A].viewMode).toBe("kanban");
    expect(state.workspaces[folder!.id].viewMode).toBe("kanban");
  });

  it("materializes a missing workspace view mode even when selecting the apparent fallback mode", async () => {
    await seed([project(REPO_A, 0)], []);
    useAppStore.setState((state) => {
      const { viewMode: _viewMode, ...workspaceWithoutMode } =
        state.workspaces[REPO_A];
      return {
        workspaces: {
          ...state.workspaces,
          [REPO_A]: workspaceWithoutMode,
        },
      };
    });

    useAppStore.getState().setWorkspaceViewMode("panes");

    expect(useAppStore.getState().workspaces[REPO_A].viewMode).toBe("panes");
  });

  it("stores the workspace view mode per project", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("a1", REPO_A), session("b1", REPO_B)],
    );

    useAppStore.getState().setActiveProject(REPO_A);
    useAppStore.getState().setWorkspaceViewMode("kanban");
    expect(useAppStore.getState().workspaceViewMode).toBe("kanban");

    const folder = useAppStore
      .getState()
      .createProjectFolder(REPO_A, "Feature", `${REPO_A}/feature`);
    expect(folder).not.toBeNull();
    expect(useAppStore.getState().workspaceViewMode).toBe("kanban");
    expect(useAppStore.getState().workspaces[folder!.id].viewMode).toBe(
      "kanban",
    );

    useAppStore.getState().setWorkspaceViewMode("panes");
    expect(useAppStore.getState().workspaceViewMode).toBe("panes");
    expect(useAppStore.getState().workspaces[REPO_A].viewMode).toBe("panes");
    expect(useAppStore.getState().workspaces[folder!.id].viewMode).toBe(
      "panes",
    );

    useAppStore.getState().setWorkspaceViewMode("kanban");
    useAppStore.getState().setActiveProject(REPO_B);
    expect(useAppStore.getState().workspaceViewMode).toBe("panes");

    useAppStore.getState().setActiveProject(REPO_A);
    expect(useAppStore.getState().workspaceViewMode).toBe("kanban");
  });

  it("tracks the terminal popup session independently from pane selection", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A), session("a2", REPO_A)]);

    expect(useAppStore.getState().activeSessionId).toBe("a1");

    useAppStore.getState().openTerminalPopup("a2");
    expect(useAppStore.getState().terminalPopupSessionId).toBe("a2");
    expect(useAppStore.getState().activeSessionId).toBe("a1");

    useAppStore.getState().closeTerminalPopup();
    expect(useAppStore.getState().terminalPopupSessionId).toBeNull();
    expect(useAppStore.getState().activeSessionId).toBe("a1");
  });

  it("clears the terminal popup when the popup session is removed", async () => {
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    await seed([project(REPO_A, 0)], [a1, a2]);

    useAppStore.getState().openTerminalPopup("a2");
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    mockApi.listSessions.mockResolvedValueOnce([a1]);

    await useAppStore.getState().removeSession("a2", true);

    expect(useAppStore.getState().terminalPopupSessionId).toBeNull();
    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual(["a1"]);
  });

  it("creates a new pane and focuses it; layout becomes a split", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    expect(useAppStore.getState().layout.kind).toBe("pane");

    useAppStore.getState().splitFocusedPane("horizontal");
    const s = useAppStore.getState();
    expect(s.layout.kind).toBe("split");
    expect(Object.keys(s.panes)).toHaveLength(2);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual([]);
    expect(s.activeSessionId).toBeNull();
  });

  it("focuses the adjacent pane by visual direction", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    const rootPaneId = useAppStore.getState().focusedPaneId;

    useAppStore.getState().splitFocusedPane("horizontal");
    const rightPaneId = useAppStore.getState().focusedPaneId;
    expect(rightPaneId).not.toBe(rootPaneId);

    useAppStore.getState().focusAdjacentPane("left");
    expect(useAppStore.getState().focusedPaneId).toBe(rootPaneId);

    useAppStore.getState().focusAdjacentPane("right");
    expect(useAppStore.getState().focusedPaneId).toBe(rightPaneId);
  });

  it("persists resized split ratios per project across project switches and reload storage", async () => {
    window.localStorage.clear();
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [
        session("a1", REPO_A, { agent_provider: "codex" }),
        session("b1", REPO_B),
      ],
    );
    useAppStore.getState().splitFocusedPane("horizontal");
    const split = useAppStore.getState().layout;
    expect(split.kind).toBe("split");

    useAppStore.getState().setPaneSplitSizes(split.id, [25, 75]);
    useAppStore.getState().setActiveProject(REPO_B);
    useAppStore.getState().setActiveProject(REPO_A);
    useAppStore.getState().addSessionNotification(
      notification("n-persist", { sessionId: "a1" }),
    );
    useAppStore.getState().toggleSessionAutoClose("a1");

    const restored = useAppStore.getState().layout;
    expect(restored.kind).toBe("split");
    if (restored.kind !== "split") throw new Error("expected split layout");
    expect(restored.sizes).toEqual([25, 75]);

    const raw = window.localStorage.getItem("acorn-workspaces");
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    expect(persisted.state.workspaces[REPO_A].layout.sizes).toEqual([25, 75]);
    expect(persisted.state.sessionNotifications).toEqual([
      notification("n-persist", { sessionId: "a1" }),
    ]);
    expect(persisted.state.autoCloseSessionIds).toEqual({ a1: true });

    resetStore();
    window.localStorage.setItem("acorn-workspaces", raw!);
    await useAppStore.persist.rehydrate();

    const rehydrated = useAppStore.getState().layout;
    expect(rehydrated.kind).toBe("split");
    if (rehydrated.kind !== "split") throw new Error("expected split layout");
    expect(rehydrated.sizes).toEqual([25, 75]);
    expect(useAppStore.getState().sessionNotifications).toEqual([
      notification("n-persist", { sessionId: "a1" }),
    ]);
    expect(useAppStore.getState().autoCloseSessionIds).toEqual({ a1: true });
  });
});

describe("moveTab", () => {
  it("moves a session from one pane to another and focuses the destination", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    useAppStore.getState().splitFocusedPane("horizontal");
    const fromPaneId = Object.keys(useAppStore.getState().panes).find(
      (pid) => useAppStore.getState().panes[pid].tabIds.length === 2,
    )!;
    const toPaneId = useAppStore.getState().focusedPaneId;
    expect(fromPaneId).not.toBe(toPaneId);

    useAppStore.getState().moveTab({
      tabId: "a1",
      fromPaneId,
      toPaneId,
    });

    const s = useAppStore.getState();
    expect(s.panes[fromPaneId].tabIds).toEqual(["a2"]);
    expect(s.panes[toPaneId].tabIds).toEqual(["a1"]);
    expect(s.focusedPaneId).toBe(toPaneId);
    expect(s.activeSessionId).toBe("a1");
  });

  it("collapses the source pane when it becomes empty after the move", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    useAppStore.getState().splitFocusedPane("horizontal");
    // After splitting, the new pane is focused (empty); a1 lives in the other.
    const focusedAfterSplit = useAppStore.getState().focusedPaneId;
    const sourcePaneId = Object.keys(useAppStore.getState().panes).find(
      (pid) => pid !== focusedAfterSplit,
    )!;

    useAppStore.getState().moveTab({
      tabId: "a1",
      fromPaneId: sourcePaneId,
      toPaneId: focusedAfterSplit,
    });

    const s = useAppStore.getState();
    expect(s.layout.kind).toBe("pane");
    expect(Object.keys(s.panes)).toHaveLength(1);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1"]);
  });

  it("creates a new pane when splitDirection/splitSide are provided; empty source collapses", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    const fromPaneId = useAppStore.getState().focusedPaneId;

    useAppStore.getState().moveTab({
      tabId: "a1",
      fromPaneId,
      toPaneId: fromPaneId,
      splitDirection: "horizontal",
      splitSide: "after",
    });

    const s = useAppStore.getState();
    // Splitting then immediately collapsing the empty source leaves a single pane.
    expect(s.layout.kind).toBe("pane");
    expect(Object.keys(s.panes)).toHaveLength(1);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1"]);
    expect(s.activeSessionId).toBe("a1");
  });

  it("preserves the split when destination is a brand-new pane and source still has sessions", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    const fromPaneId = useAppStore.getState().focusedPaneId;

    useAppStore.getState().moveTab({
      tabId: "a1",
      fromPaneId,
      toPaneId: fromPaneId,
      splitDirection: "horizontal",
      splitSide: "after",
    });

    const s = useAppStore.getState();
    expect(s.layout.kind).toBe("split");
    expect(Object.keys(s.panes)).toHaveLength(2);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1"]);
  });

  it("uses the destination pane history after moving and closing a code viewer", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    useAppStore.getState().splitFocusedPane("horizontal");
    const sourcePaneId = Object.keys(useAppStore.getState().panes).find(
      (pid) => useAppStore.getState().panes[pid].tabIds.length === 2,
    )!;
    const destinationPaneId = useAppStore.getState().focusedPaneId;
    useAppStore.getState().moveTab({
      tabId: "a1",
      fromPaneId: sourcePaneId,
      toPaneId: destinationPaneId,
    });
    useAppStore.getState().setFocusedPane(sourcePaneId);
    useAppStore.getState().selectSession("a2");
    useAppStore.getState().openCodeViewerTab(`${REPO_A}/src/App.tsx`);
    const codeTabId = useAppStore.getState().activeTabId!;

    useAppStore.getState().moveTab({
      tabId: codeTabId,
      fromPaneId: sourcePaneId,
      toPaneId: destinationPaneId,
    });
    useAppStore.getState().closeWorkspaceTab(codeTabId);

    const s = useAppStore.getState();
    expect(s.focusedPaneId).toBe(destinationPaneId);
    expect(s.activeTabId).toBe("a1");
    expect(s.activeSessionId).toBe("a1");
    expect(s.panes[destinationPaneId].tabIds).toEqual(["a1"]);
    expect(s.panes[sourcePaneId].tabIds).toEqual(["a2"]);
  });
});

describe("closePane", () => {
  it("merges the closed pane's sessions into the surviving pane", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    useAppStore.getState().splitFocusedPane("horizontal");
    const focusedAfterSplit = useAppStore.getState().focusedPaneId;
    const otherPaneId = Object.keys(useAppStore.getState().panes).find(
      (pid) => pid !== focusedAfterSplit,
    )!;
    // Move a2 to the new (focused) pane so both panes hold sessions.
    useAppStore.getState().moveTab({
      tabId: "a2",
      fromPaneId: otherPaneId,
      toPaneId: focusedAfterSplit,
    });

    useAppStore.getState().closePane(focusedAfterSplit);
    const s = useAppStore.getState();
    expect(s.layout.kind).toBe("pane");
    expect(Object.keys(s.panes)).toHaveLength(1);
    const surviving = s.panes[s.focusedPaneId];
    expect(surviving.tabIds.sort()).toEqual(["a1", "a2"]);
  });

  it("is a no-op when only one pane exists", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    const before = useAppStore.getState();
    useAppStore.getState().closePane(before.focusedPaneId);
    const after = useAppStore.getState();
    expect(after.layout).toBe(before.layout);
    expect(after.panes).toBe(before.panes);
  });
});

describe("cycleTab", () => {
  it("wraps forward through the session list within the focused pane", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A), session("a3", REPO_A)],
    );
    // Reconcile assigns the FIRST seen session as the active one.
    expect(useAppStore.getState().activeSessionId).toBe("a1");

    useAppStore.getState().cycleTab(1);
    expect(useAppStore.getState().activeSessionId).toBe("a2");
    useAppStore.getState().cycleTab(1);
    expect(useAppStore.getState().activeSessionId).toBe("a3");
    // Wrap.
    useAppStore.getState().cycleTab(1);
    expect(useAppStore.getState().activeSessionId).toBe("a1");
  });

  it("wraps backward starting from the first id", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    // Active starts at a1; cycle(-1) wraps to a2; cycle(-1) → a1 again.
    expect(useAppStore.getState().activeSessionId).toBe("a1");
    useAppStore.getState().cycleTab(-1);
    expect(useAppStore.getState().activeSessionId).toBe("a2");
    useAppStore.getState().cycleTab(-1);
    expect(useAppStore.getState().activeSessionId).toBe("a1");
  });
});

describe("cycleProject", () => {
  it("rotates active project through the project list", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("a1", REPO_A), session("b1", REPO_B)],
    );
    const start = useAppStore.getState().activeProject;
    useAppStore.getState().cycleProject(1);
    expect(useAppStore.getState().activeProject).not.toBe(start);
    useAppStore.getState().cycleProject(1);
    expect(useAppStore.getState().activeProject).toBe(start);
  });
});

describe("reconcile via refreshSessions", () => {
  it("drops removed sessions from the pane that held them", async () => {
    // Single-pane variant — this exercises filter-out without depending on
    // the cross-pane collapse path, which has a runtime-specific divergence
    // we still need to investigate. See the disabled test below.
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    expect(useAppStore.getState().panes[useAppStore.getState().focusedPaneId].tabIds.sort()).toEqual([
      "a1",
      "a2",
    ]);

    mockApi.listSessions.mockResolvedValueOnce([session("a1", REPO_A)]);
    await useAppStore.getState().refreshSessions();

    const s = useAppStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(["a1"]);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1"]);
  });

  it("drops activity for sessions removed by backend refresh", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    useAppStore.getState().addSessionNotification(
      notification("n1", { sessionId: "a1" }),
    );
    useAppStore.getState().addSessionNotification(
      notification("n2", { sessionId: "a2" }),
    );

    mockApi.listSessions.mockResolvedValueOnce([session("a1", REPO_A)]);
    await useAppStore.getState().refreshSessions();

    expect(
      useAppStore.getState().sessionNotifications.map((item) => item.id),
    ).toEqual(["n1"]);
  });

  it("keeps activity when an unclean empty session load may be transient", async () => {
    useAppStore.setState({ sessionsLoadedCleanly: false });
    useAppStore.getState().addSessionNotification(
      notification("n1", { sessionId: "a1" }),
    );

    mockApi.listSessions.mockResolvedValueOnce([]);
    await useAppStore.getState().refreshSessions();

    expect(
      useAppStore.getState().sessionNotifications.map((item) => item.id),
    ).toEqual(["n1"]);
  });

  it("places newly seen sessions in the focused pane", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    mockApi.listSessions.mockResolvedValueOnce([
      session("a1", REPO_A),
      session("a2", REPO_A),
    ]);
    await useAppStore.getState().refreshSessions();
    const s = useAppStore.getState();
    expect(s.panes[s.focusedPaneId].tabIds.sort()).toEqual(["a1", "a2"]);
  });

  it("ignores stale refresh results that resolve after a newer session list", async () => {
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    await seed([project(REPO_A, 0)], [a1]);

    const stale = deferred<Session[]>();
    const fresh = deferred<Session[]>();
    mockApi.listSessions
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);

    const staleRefresh = useAppStore.getState().refreshSessions();
    const freshRefresh = useAppStore.getState().refreshSessions();

    fresh.resolve([a1, a2]);
    await freshRefresh;
    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual([
      "a1",
      "a2",
    ]);

    stale.resolve([a1]);
    await staleRefresh;

    const s = useAppStore.getState();
    expect(s.sessions.map((session) => session.id)).toEqual(["a1", "a2"]);
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["a1", "a2"]);
  });

  it("does NOT wipe persisted tabIds when load_status reports unclean", async () => {
    // Seed: persisted layout with two sessions in one pane.
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    expect(
      useAppStore.getState().panes[useAppStore.getState().focusedPaneId]
        .tabIds.sort(),
    ).toEqual(["a1", "a2"]);

    // Simulate boot-time corruption: backend returns empty + reports unclean.
    mockApi.loadStatus.mockResolvedValueOnce({
      sessionsClean: false,
      projectsClean: true,
    });
    mockApi.listSessions.mockResolvedValueOnce([]);
    await useAppStore.getState().loadInitialStatus();
    await useAppStore.getState().refreshSessions();

    // Pane retains the original ids — guard prevented wipe.
    const s = useAppStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.sessionsLoadedCleanly).toBe(false);
    expect(s.panes[s.focusedPaneId].tabIds.sort()).toEqual(["a1", "a2"]);
  });

  it("clears the wipe guard once backend returns at least one session", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    mockApi.loadStatus.mockResolvedValueOnce({
      sessionsClean: false,
      projectsClean: true,
    });
    await useAppStore.getState().loadInitialStatus();
    expect(useAppStore.getState().sessionsLoadedCleanly).toBe(false);

    mockApi.listSessions.mockResolvedValueOnce([session("a1", REPO_A)]);
    await useAppStore.getState().refreshSessions();
    // Non-empty result → guard armed off → subsequent empty wipes work.
    expect(useAppStore.getState().sessionsLoadedCleanly).toBe(true);
  });
});

describe("pollSessionStatuses", () => {
  it("merges status updates without touching unmodified sessions", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A, { status: "running" })],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      { id: "a1", status: "needs_input", branch: null },
      { id: "a2", status: "running", branch: null }, // unchanged
    ]);
    await useAppStore.getState().pollSessionStatuses();
    const sessions = useAppStore.getState().sessions;
    expect(sessions.find((s) => s.id === "a1")?.status).toBe("needs_input");
    expect(sessions.find((s) => s.id === "a2")?.status).toBe("running");
  });

  it("polls only the requested existing session ids", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      { id: "a2", status: "running", branch: "feat/a2-live" },
    ]);

    await useAppStore
      .getState()
      .pollSessionStatuses(["a2", "missing", "a2"]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledWith(["a2"]);
    const sessions = useAppStore.getState().sessions;
    expect(sessions.find((s) => s.id === "a1")?.status).toBe("idle");
    expect(sessions.find((s) => s.id === "a2")?.status).toBe("running");
    expect(sessions.find((s) => s.id === "a2")?.branch).toBe("feat/a2-live");
  });

  it("merges live agent transcript ids from status polling", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          agent_provider: "claude",
          agent_transcript_id: "claude-old",
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "running",
        agent_provider: "claude",
        agent_transcript_id: "claude-new",
        branch: null,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.agent_transcript_id).toBe(
      "claude-new",
    );
  });

  it("merges active process summaries from status polling", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          status: "running",
          active_processes: [{ pid: 10, name: "node", depth: 1 }],
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "running",
        branch: null,
        git_context_path: "/repo/acorn-worktree",
        active_processes: [
          { pid: 11, name: "codex", depth: 2 },
          { pid: 12, name: "rg", depth: 3 },
        ],
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.active_processes).toEqual([
      { pid: 11, name: "codex", depth: 2 },
      { pid: 12, name: "rg", depth: 3 },
    ]);
    expect(useAppStore.getState().sessions[0]?.git_context_path).toBe(
      "/repo/acorn-worktree",
    );
  });

  it("merges last messages from status polling even when status is unchanged", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          status: "running",
          last_message: "Older transcript preview",
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "running",
        last_message: "New transcript preview",
        branch: null,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.last_message).toBe(
      "New transcript preview",
    );
  });

  it("merges split conversation previews from status polling", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          status: "running",
          last_user_message: "Older user prompt",
          last_agent_message: "Older agent response",
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "running",
        last_user_message: "New user prompt",
        last_agent_message: "New agent response",
        branch: null,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.last_user_message).toBe(
      "New user prompt",
    );
    expect(useAppStore.getState().sessions[0]?.last_agent_message).toBe(
      "New agent response",
    );
  });

  it("preserves last messages when status polling omits the field", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          status: "running",
          last_message: "Current transcript preview",
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "running",
        branch: null,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.last_message).toBe(
      "Current transcript preview",
    );
  });

  it("merges status reasons from status polling even when status is unchanged", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          status: "needs_input",
          agent_provider: "codex",
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "needs_input",
        status_reason: "turn_complete",
        agent_provider: "codex",
        branch: null,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.status_reason).toBe(
      "turn_complete",
    );
  });

  it("clears the live agent provider when status polling reports null", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          agent_provider: "codex",
          agent_transcript_id: "codex-old",
        }),
      ],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "idle",
        agent_provider: null,
        agent_transcript_id: "codex-old",
        branch: null,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.agent_provider).toBeNull();
    expect(useAppStore.getState().sessions[0]?.agent_transcript_id).toBe(
      "codex-old",
    );
  });

  it("does not call the backend when the requested ids are absent", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);

    await useAppStore.getState().pollSessionStatuses(["missing"]);

    expect(mockApi.detectSessionStatuses).not.toHaveBeenCalled();
  });

  it("merges the backend auto-title promotion from status polling", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A, { auto_title_enabled: false })],
    );
    mockApi.detectSessionStatuses.mockResolvedValueOnce([
      {
        id: "a1",
        status: "running",
        branch: null,
        auto_title_enabled: true,
      },
    ]);

    await useAppStore.getState().pollSessionStatuses(["a1"]);

    expect(useAppStore.getState().sessions[0]?.auto_title_enabled).toBe(true);
  });

  it("serializes overlapping polls and runs queued subsets afterward", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockApi.detectSessionStatuses
      .mockImplementationOnce(async () => {
        await firstBlocker;
        return [{ id: "a1", status: "running", branch: null }];
      })
      .mockResolvedValueOnce([
        { id: "a2", status: "needs_input", branch: null },
      ]);

    const first = useAppStore.getState().pollSessionStatuses(["a1"]);
    const second = useAppStore.getState().pollSessionStatuses(["a2"]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledTimes(1);
    expect(mockApi.detectSessionStatuses).toHaveBeenNthCalledWith(1, ["a1"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledTimes(2);
    expect(mockApi.detectSessionStatuses).toHaveBeenNthCalledWith(2, ["a2"]);
    const sessions = useAppStore.getState().sessions;
    expect(sessions.find((s) => s.id === "a1")?.status).toBe("running");
    expect(sessions.find((s) => s.id === "a2")?.status).toBe("needs_input");
  });

  it("coalesces subset requests covered by an active full poll", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A), session("a2", REPO_A)],
    );
    let releaseFull!: () => void;
    const fullBlocker = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    mockApi.detectSessionStatuses.mockImplementationOnce(async () => {
      await fullBlocker;
      return [
        { id: "a1", status: "running", branch: null },
        { id: "a2", status: "needs_input", branch: null },
      ];
    });

    const full = useAppStore.getState().pollSessionStatuses();
    const subset = useAppStore.getState().pollSessionStatuses(["a2"]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledTimes(1);
    expect(mockApi.detectSessionStatuses).toHaveBeenCalledWith(["a1", "a2"]);

    releaseFull();
    await Promise.all([full, subset]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledTimes(1);
    const sessions = useAppStore.getState().sessions;
    expect(sessions.find((s) => s.id === "a1")?.status).toBe("running");
    expect(sessions.find((s) => s.id === "a2")?.status).toBe("needs_input");
  });

  it("queues new session ids that appear during an active full poll", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    let releaseFull!: () => void;
    const fullBlocker = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    mockApi.detectSessionStatuses
      .mockImplementationOnce(async () => {
        await fullBlocker;
        return [{ id: "a1", status: "running", branch: null }];
      })
      .mockResolvedValueOnce([
        { id: "a2", status: "needs_input", branch: null },
      ]);

    const full = useAppStore.getState().pollSessionStatuses();
    useAppStore.setState((s) => ({
      sessions: [...s.sessions, session("a2", REPO_A)],
    }));
    const newSessionPoll = useAppStore
      .getState()
      .pollSessionStatuses(["a2"]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledTimes(1);
    expect(mockApi.detectSessionStatuses).toHaveBeenCalledWith(["a1"]);

    releaseFull();
    await Promise.all([full, newSessionPoll]);

    expect(mockApi.detectSessionStatuses).toHaveBeenCalledTimes(2);
    expect(mockApi.detectSessionStatuses).toHaveBeenNthCalledWith(2, ["a2"]);
    const sessions = useAppStore.getState().sessions;
    expect(sessions.find((s) => s.id === "a1")?.status).toBe("running");
    expect(sessions.find((s) => s.id === "a2")?.status).toBe("needs_input");
  });

  it("is a no-op when there are no sessions to poll", async () => {
    await useAppStore.getState().pollSessionStatuses();
    expect(mockApi.detectSessionStatuses).not.toHaveBeenCalled();
  });
});

describe("generateSessionTitle", () => {
  it("does not manually rename a session while title generation is active", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    useAppStore.setState({
      generatingSessionTitleIds: { a1: true },
    });

    await useAppStore.getState().renameSession("a1", "Manual title");

    expect(mockApi.renameSession).not.toHaveBeenCalled();
  });

  it("merges the generated session title without refreshing all sessions", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    mockApi.generateSessionTitle.mockResolvedValueOnce(
      {
        status: "generated",
        session: session("a1", REPO_A, {
          name: "Fix Release Workflow",
          title_source: "generated",
        }),
      },
    );

    const ai = { provider: "codex" as const, ollamaModel: "", llmModel: "" };
    const status = await useAppStore
      .getState()
      .generateSessionTitle("a1", ai, "Title prompt");

    expect(status).toBe("generated");
    expect(mockApi.generateSessionTitle).toHaveBeenCalledWith(
      "a1",
      ai,
      "Title prompt",
      false,
    );
    expect(mockApi.listSessions).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sessions[0]?.name).toBe(
      "Fix Release Workflow",
    );
    expect(useAppStore.getState().sessions[0]?.title_source).toBe("generated");
  });

  it("skips automatic title generation for auto-close sessions", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A, { agent_provider: "codex" })],
    );
    useAppStore.setState({ autoCloseSessionIds: { a1: true } });

    const ai = { provider: "codex" as const, ollamaModel: "", llmModel: "" };
    const status = await useAppStore
      .getState()
      .generateSessionTitle("a1", ai, "Title prompt");

    expect(status).toBe("skipped");
    expect(mockApi.generateSessionTitle).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessions[0]?.name).toBe("a1");
    expect(useAppStore.getState().generatingSessionTitleIds).toEqual({});
  });

  it("does not apply an automatic title result after auto-close is enabled", async () => {
    await seed(
      [project(REPO_A, 0)],
      [session("a1", REPO_A, { agent_provider: "codex" })],
    );
    let resolveTitle!: (value: GenerateSessionTitleResult) => void;
    mockApi.generateSessionTitle.mockImplementationOnce(
      () =>
        new Promise<GenerateSessionTitleResult>((resolve) => {
          resolveTitle = resolve;
        }),
    );

    const ai = { provider: "codex" as const, ollamaModel: "", llmModel: "" };
    const request = useAppStore
      .getState()
      .generateSessionTitle("a1", ai, "Title prompt");
    useAppStore.setState({ autoCloseSessionIds: { a1: true } });

    resolveTitle({
      status: "generated",
      session: session("a1", REPO_A, {
        name: "Should Not Apply",
        title_source: "generated",
      }),
    });

    await expect(request).resolves.toBe("skipped");
    expect(useAppStore.getState().sessions[0]?.name).toBe("a1");
    expect(useAppStore.getState().sessions[0]?.title_source).toBe("default");
    expect(useAppStore.getState().generatingSessionTitleIds).toEqual({});
  });

  it("passes force when manually regenerating a generated session title", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          name: "Manual title",
          title_source: "manual",
          agent_provider: "codex",
          agent_transcript_id: "codex-1",
        }),
      ],
    );
    useAppStore.setState({ autoCloseSessionIds: { a1: true } });
    mockApi.generateSessionTitle.mockResolvedValueOnce({
      status: "generated",
      session: session("a1", REPO_A, {
        name: "fresh-title",
        title_source: "generated",
      }),
    });

    const ai = { provider: "codex" as const, ollamaModel: "", llmModel: "" };
    const status = await useAppStore
      .getState()
      .generateSessionTitle("a1", ai, "Title prompt", true);

    expect(status).toBe("generated");
    expect(mockApi.generateSessionTitle).toHaveBeenCalledWith(
      "a1",
      ai,
      "Title prompt",
      true,
    );
    expect(useAppStore.getState().sessions[0]?.name).toBe("fresh-title");
  });

  it("skips forced title generation for sessions without agent chat work", async () => {
    await seed(
      [project(REPO_A, 0)],
      [
        session("a1", REPO_A, {
          name: "Manual title",
          title_source: "manual",
          agent_provider: null,
          agent_transcript_id: null,
        }),
      ],
    );

    const ai = { provider: "codex" as const, ollamaModel: "", llmModel: "" };
    const status = await useAppStore
      .getState()
      .generateSessionTitle("a1", ai, "Title prompt", true);

    expect(status).toBe("skipped");
    expect(mockApi.generateSessionTitle).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessions[0]?.name).toBe("Manual title");
    expect(useAppStore.getState().generatingSessionTitleIds).toEqual({});
  });

  it("returns not_ready without replacing the session title", async () => {
    await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
    mockApi.generateSessionTitle.mockResolvedValueOnce({
      status: "not_ready",
      session: session("a1", REPO_A, {
        name: "Backend no-op title",
        title_source: "default",
      }),
    });

    const status = await useAppStore.getState().generateSessionTitle(
      "a1",
      { provider: "codex", ollamaModel: "", llmModel: "" },
      "Title prompt",
    );

    expect(status).toBe("not_ready");
    expect(useAppStore.getState().sessions[0]?.name).toBe("a1");
    expect(useAppStore.getState().sessions[0]?.title_source).toBe("default");
    expect(useAppStore.getState().generatingSessionTitleIds).toEqual({});
  });

  it("tracks title generation while the backend request is in flight", async () => {
    vi.useFakeTimers();
    try {
      await seed([project(REPO_A, 0)], [session("a1", REPO_A)]);
      let resolveTitle!: (value: GenerateSessionTitleResult) => void;
      mockApi.generateSessionTitle.mockImplementationOnce(
        () =>
          new Promise<GenerateSessionTitleResult>((resolve) => {
            resolveTitle = resolve;
          }),
      );

      const request = useAppStore.getState().generateSessionTitle(
        "a1",
        { provider: "codex", ollamaModel: "", llmModel: "" },
        "Title prompt",
      );

      expect(useAppStore.getState().generatingSessionTitleIds).toEqual({
        a1: true,
      });

      resolveTitle(
        {
          status: "generated",
          session: session("a1", REPO_A, {
            name: "Fix Release Workflow",
            title_source: "generated",
          }),
        },
      );
      await Promise.resolve();

      expect(useAppStore.getState().generatingSessionTitleIds).toEqual({
        a1: true,
      });

      await vi.advanceTimersByTimeAsync(900);
      await request;

      expect(useAppStore.getState().generatingSessionTitleIds).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("removeProject", () => {
  it("optimistically drops the workspace and clears active project when removed one was active", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("b1", REPO_B)],
    );
    expect(useAppStore.getState().activeProject).toBe(REPO_B);

    // After remove, refreshAll re-pulls projects/sessions; return both stripped of B.
    mockApi.removeProject.mockResolvedValueOnce([]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    mockApi.listSessions.mockResolvedValueOnce([]);

    await useAppStore.getState().removeProject(REPO_B, true);

    const s = useAppStore.getState();
    expect(s.workspaces[REPO_B]).toBeUndefined();
    // After refreshAll with one remaining project (no sessions), it becomes active.
    expect(s.activeProject).toBe(REPO_A);
  });
});

describe("removeProjectWorktree", () => {
  it("removes sessions and matching worktree workspaces after backend deletion", async () => {
    const worktreePath = `${REPO_B}/.acorn/worktrees/feature-alpha`;
    const repo = project(REPO_B, 0);
    await seed(
      [repo],
      [
        session("b1", REPO_B, {
          worktree_path: worktreePath,
          in_worktree: true,
        }),
      ],
    );
    const folder = useAppStore
      .getState()
      .createProjectFolder(REPO_B, "feature-alpha", worktreePath);
    expect(folder).not.toBeNull();
    mockApi.listProjects.mockResolvedValueOnce([repo]);
    mockApi.listSessions.mockResolvedValueOnce([]);

    await useAppStore
      .getState()
      .removeProjectWorktree(REPO_B, worktreePath, true);

    const state = useAppStore.getState();
    expect(mockApi.removeWorktree).toHaveBeenCalledWith(
      REPO_B,
      worktreePath,
      true,
    );
    expect(state.sessions).toEqual([]);
    expect(
      state.projectFolders[REPO_B]?.some(
        (candidate) => candidate.id === folder?.id,
      ),
    ).toBe(false);
    expect(state.workspaces[folder!.id]).toBeUndefined();
  });

  it("refuses to delete a worktree while another session uses it", async () => {
    const worktreePath = `${REPO_B}/.acorn/worktrees/feature-alpha`;
    const repo = project(REPO_B, 0);
    await seed(
      [repo],
      [
        session("b1", REPO_B, {
          worktree_path: worktreePath,
          in_worktree: true,
        }),
        session("b2", REPO_B, {
          worktree_path: `${worktreePath}/`,
          in_worktree: true,
        }),
      ],
    );
    useAppStore.getState().selectSession("b1");

    await expect(
      useAppStore.getState().removeProjectWorktree(REPO_B, worktreePath, true),
    ).rejects.toThrow("Close other sessions using this worktree");

    const state = useAppStore.getState();
    expect(mockApi.removeWorktree).not.toHaveBeenCalled();
    expect(state.sessions.map((candidate) => candidate.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(state.error).toBe(
      "Close other sessions using this worktree before removing it.",
    );
  });

  it("refuses to delete a worktree while another project session uses the same path", async () => {
    const worktreePath = `${REPO_B}/.acorn/worktrees/feature-alpha`;
    const repo = project(REPO_B, 0);
    await seed(
      [repo, project(REPO_A, 1)],
      [
        session("b1", REPO_B, {
          worktree_path: worktreePath,
          in_worktree: true,
        }),
        session("a1", REPO_A, {
          worktree_path: `${worktreePath}/`,
          in_worktree: true,
        }),
      ],
    );
    useAppStore.getState().selectSession("b1");

    await expect(
      useAppStore.getState().removeProjectWorktree(REPO_B, worktreePath, true),
    ).rejects.toThrow("Close other sessions using this worktree");

    const state = useAppStore.getState();
    expect(mockApi.removeWorktree).not.toHaveBeenCalled();
    expect(state.sessions.map((candidate) => candidate.id)).toEqual([
      "b1",
      "a1",
    ]);
    expect(state.error).toBe(
      "Close other sessions using this worktree before removing it.",
    );
  });

  it("refuses to delete a worktree path used only by another project session", async () => {
    const worktreePath = `${REPO_B}/.acorn/worktrees/feature-alpha`;
    const repo = project(REPO_B, 0);
    await seed(
      [repo, project(REPO_A, 1)],
      [
        session("a1", REPO_A, {
          worktree_path: worktreePath,
          in_worktree: true,
        }),
      ],
    );

    await expect(
      useAppStore.getState().removeProjectWorktree(REPO_B, worktreePath, false),
    ).rejects.toThrow("Close other sessions using this worktree");

    const state = useAppStore.getState();
    expect(mockApi.removeWorktree).not.toHaveBeenCalled();
    expect(state.sessions.map((candidate) => candidate.id)).toEqual(["a1"]);
    expect(state.error).toBe(
      "Close other sessions using this worktree before removing it.",
    );
  });
});

describe("requestRemoveProject", () => {
  it("opens the confirmation modal when the project still has sessions", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("b1", REPO_B)],
    );

    useAppStore.getState().requestRemoveProject(REPO_B);

    expect(useAppStore.getState().pendingRemoveProject).toBe(REPO_B);
    expect(mockApi.removeProject).not.toHaveBeenCalled();
  });

  it("removes the project directly without a confirmation modal when no sessions remain", async () => {
    await seed([project(REPO_A, 0), project(REPO_B, 1)], []);
    mockApi.removeProject.mockResolvedValueOnce([]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    mockApi.listSessions.mockResolvedValueOnce([]);

    useAppStore.getState().requestRemoveProject(REPO_B);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAppStore.getState().pendingRemoveProject).toBeNull();
    expect(mockApi.removeProject).toHaveBeenCalledWith(
      REPO_B,
      true,
      false,
      false,
    );
    expect(useAppStore.getState().workspaces[REPO_B]).toBeUndefined();
  });
});

describe("reorderProjects", () => {
  it("optimistically reorders, then commits the server-returned order", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [],
    );
    mockApi.reorderProjects.mockResolvedValueOnce([
      project(REPO_B, 0),
      project(REPO_A, 1),
    ]);
    await useAppStore.getState().reorderProjects([REPO_B, REPO_A]);
    expect(useAppStore.getState().projects.map((p) => p.repo_path)).toEqual([
      REPO_B,
      REPO_A,
    ]);
  });

  it("rolls back to the previous order on failure", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [],
    );
    const before = useAppStore.getState().projects;
    mockApi.reorderProjects.mockRejectedValueOnce(new Error("nope"));
    await useAppStore.getState().reorderProjects([REPO_B, REPO_A]);
    expect(useAppStore.getState().projects).toEqual(before);
    expect(useAppStore.getState().error).toBe("nope");
  });
});

describe("createSession", () => {
  // Each control-session test reaches into localStorage; clear it so
  // an earlier test's "don't show again" flag does not leak forward.
  const guideKey = "acorn:control-guide-dismissed-v1";

  beforeEach(() => {
    window.localStorage.removeItem(guideKey);
  });

  it("defaults the kind to regular when the caller omits it", async () => {
    mockApi.createSession.mockResolvedValueOnce(session("new", REPO_A));
    await useAppStore.getState().createSession("foo", REPO_A);
    expect(mockApi.createSession).toHaveBeenCalledWith(
      "foo",
      REPO_A,
      false,
      "regular",
      null,
    );
  });

  it("forwards control kind to the backend", async () => {
    mockApi.createSession.mockResolvedValueOnce(
      session("ctl", REPO_A, { kind: "control" }),
    );
    await useAppStore
      .getState()
      .createSession("ctl", REPO_A, false, "control");
    expect(mockApi.createSession).toHaveBeenCalledWith(
      "ctl",
      REPO_A,
      false,
      "control",
      null,
    );
  });

  it("forwards an explicit agent provider to the backend", async () => {
    mockApi.createSession.mockResolvedValueOnce(
      session("agent", REPO_A, { agent_provider: "codex" }),
    );
    await useAppStore
      .getState()
      .createSession("agent", REPO_A, false, "regular", "codex");
    expect(mockApi.createSession).toHaveBeenCalledWith(
      "agent",
      REPO_A,
      false,
      "regular",
      "codex",
    );
  });

  it("forwards local session scope only when requested", async () => {
    mockApi.createSession.mockResolvedValueOnce(
      session("terminal", "/Users/me", { project_scoped: false }),
    );
    await useAppStore
      .getState()
      .createSession("terminal", "/Users/me", false, "regular", null, false);
    expect(mockApi.createSession).toHaveBeenCalledWith(
      "terminal",
      "/Users/me",
      false,
      "regular",
      null,
      false,
    );
  });

  it("emits the guide event the first time a control session is created", async () => {
    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener("acorn:show-control-guide", listener);
    try {
      mockApi.createSession.mockResolvedValueOnce(
        session("ctl", REPO_A, { kind: "control" }),
      );
      await useAppStore
        .getState()
        .createSession("ctl", REPO_A, false, "control");
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener("acorn:show-control-guide", listener);
    }
  });

  it("suppresses the guide event when the dismissed flag is set", async () => {
    window.localStorage.setItem(guideKey, "1");
    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener("acorn:show-control-guide", listener);
    try {
      mockApi.createSession.mockResolvedValueOnce(
        session("ctl", REPO_A, { kind: "control" }),
      );
      await useAppStore
        .getState()
        .createSession("ctl", REPO_A, false, "control");
      expect(events).toHaveLength(0);
    } finally {
      window.removeEventListener("acorn:show-control-guide", listener);
    }
  });

  it("does not emit the guide event for regular sessions", async () => {
    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener("acorn:show-control-guide", listener);
    try {
      mockApi.createSession.mockResolvedValueOnce(session("reg", REPO_A));
      await useAppStore.getState().createSession("reg", REPO_A);
      expect(events).toHaveLength(0);
    } finally {
      window.removeEventListener("acorn:show-control-guide", listener);
    }
  });

  it("inserts the new tab right after the previously-active tab", async () => {
    // Seed three sessions in REPO_A; reconcile makes "a1" active.
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    const a3 = session("a3", REPO_A);
    await seed([project(REPO_A, 0)], [a1, a2, a3]);
    // Move active to "a2" so the next tab should land between a2 and a3.
    useAppStore.getState().selectSession("a2");
    expect(useAppStore.getState().activeSessionId).toBe("a2");

    const newSess = session("a4", REPO_A);
    mockApi.createSession.mockResolvedValueOnce(newSess);
    mockApi.listSessions.mockResolvedValueOnce([a1, a2, a3, newSess]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    await useAppStore.getState().createSession("new", REPO_A);

    const s = useAppStore.getState();
    expect(s.panes[s.focusedPaneId].tabIds).toEqual([
      "a1",
      "a2",
      "a4",
      "a3",
    ]);
    expect(s.activeSessionId).toBe("a4");
  });

  it("keeps concurrent new tabs in request order when completions resolve out of order", async () => {
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    const c1 = session("c1", REPO_A);
    const c2 = session("c2", REPO_A);
    await seed([project(REPO_A, 0)], [a1, a2]);
    useAppStore.getState().selectSession("a1");

    const firstCreate = deferred<Session>();
    const secondCreate = deferred<Session>();
    let backendSessions = [a1, a2];
    mockApi.createSession
      .mockImplementationOnce(() => firstCreate.promise)
      .mockImplementationOnce(() => secondCreate.promise);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);
    mockApi.listSessions.mockImplementation(async () => backendSessions);

    const first = useAppStore.getState().createSession("c1", REPO_A);
    const second = useAppStore.getState().createSession("c2", REPO_A);

    backendSessions = [a1, a2, c2];
    secondCreate.resolve(c2);
    await second;

    backendSessions = [a1, a2, c2, c1];
    firstCreate.resolve(c1);
    await first;

    const s = useAppStore.getState();
    expect(s.panes[s.focusedPaneId].tabIds).toEqual([
      "a1",
      "c1",
      "c2",
      "a2",
    ]);
  });

  it("keeps placement intents until delayed sibling sessions are visible", async () => {
    const a1 = session("a1", REPO_A);
    const a2 = session("a2", REPO_A);
    const c1 = session("c1", REPO_A);
    const c2 = session("c2", REPO_A);
    await seed([project(REPO_A, 0)], [a1, a2]);
    useAppStore.getState().selectSession("a1");

    const firstCreate = deferred<Session>();
    const secondCreate = deferred<Session>();
    let backendSessions = [a1, a2];
    mockApi.createSession
      .mockImplementationOnce(() => firstCreate.promise)
      .mockImplementationOnce(() => secondCreate.promise);
    mockApi.listProjects.mockResolvedValue([project(REPO_A, 0)]);
    mockApi.listSessions.mockImplementation(async () => backendSessions);

    const first = useAppStore.getState().createSession("c1", REPO_A);
    const second = useAppStore.getState().createSession("c2", REPO_A);

    secondCreate.resolve(c2);
    await second;
    expect(useAppStore.getState().panes.root.tabIds).toEqual(["a1", "a2"]);

    backendSessions = [a1, a2, c1];
    firstCreate.resolve(c1);
    await first;
    expect(useAppStore.getState().panes.root.tabIds).toEqual([
      "a1",
      "c1",
      "a2",
    ]);

    backendSessions = [a1, a2, c1, c2];
    await useAppStore.getState().refreshSessions();

    expect(useAppStore.getState().panes.root.tabIds).toEqual([
      "a1",
      "c1",
      "c2",
      "a2",
    ]);
  });

  it("appends when the focused pane has no active tab yet", async () => {
    await seed([project(REPO_A, 0)], []);
    const newSess = session("first", REPO_A);
    mockApi.createSession.mockResolvedValueOnce(newSess);
    mockApi.listSessions.mockResolvedValueOnce([newSess]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    await useAppStore.getState().createSession("first", REPO_A);

    const s = useAppStore.getState();
    expect(s.panes[s.focusedPaneId].tabIds).toEqual(["first"]);
    expect(s.activeSessionId).toBe("first");
  });
});

describe("reorderSessions", () => {
  it("optimistically assigns positions and commits server-returned sessions", async () => {
    const s1 = session("s1", REPO_A);
    const s2 = session("s2", REPO_A);
    const s3 = session("s3", REPO_B);
    await seed([project(REPO_A, 0), project(REPO_B, 1)], [s1, s2, s3]);

    mockApi.reorderSessions.mockResolvedValueOnce([
      { ...s2, position: 0 },
      { ...s1, position: 1 },
      s3,
    ]);

    await useAppStore.getState().reorderSessions(REPO_A, ["s2", "s1"]);
    const result = useAppStore.getState().sessions;
    expect(result.find((s) => s.id === "s2")?.position).toBe(0);
    expect(result.find((s) => s.id === "s1")?.position).toBe(1);
    expect(result.find((s) => s.id === "s3")?.position).toBeNull();
    expect(mockApi.reorderSessions).toHaveBeenCalledWith(REPO_A, ["s2", "s1"]);
  });

  it("rolls back sessions on failure", async () => {
    const s1 = session("s1", REPO_A);
    const s2 = session("s2", REPO_A);
    await seed([project(REPO_A, 0)], [s1, s2]);
    const before = useAppStore.getState().sessions;
    mockApi.reorderSessions.mockRejectedValueOnce(new Error("boom"));
    await useAppStore.getState().reorderSessions(REPO_A, ["s2", "s1"]);
    expect(useAppStore.getState().sessions).toEqual(before);
    expect(useAppStore.getState().error).toBe("boom");
  });
});

describe("pendingTerminalInput", () => {
  it("queues and consumes a command for a session id", () => {
    const { setPendingTerminalInput, consumePendingTerminalInput } =
      useAppStore.getState();
    setPendingTerminalInput("sess-1", "gh auth login");
    expect(useAppStore.getState().pendingTerminalInput["sess-1"]).toEqual({
      command: "gh auth login",
      adoptWorktreeOnExit: false,
    });
    const consumed = consumePendingTerminalInput("sess-1");
    expect(consumed).toEqual({
      command: "gh auth login",
      adoptWorktreeOnExit: false,
    });
    expect(useAppStore.getState().pendingTerminalInput["sess-1"]).toBeUndefined();
  });

  it("returns null and is a no-op when no command is queued", () => {
    const consumed = useAppStore
      .getState()
      .consumePendingTerminalInput("nope");
    expect(consumed).toBeNull();
  });

  it("overwrites a previously queued command for the same session", () => {
    const { setPendingTerminalInput, consumePendingTerminalInput } =
      useAppStore.getState();
    setPendingTerminalInput("sess-1", "first");
    setPendingTerminalInput("sess-1", "second");
    expect(consumePendingTerminalInput("sess-1")).toEqual({
      command: "second",
      adoptWorktreeOnExit: false,
    });
  });

  it("preserves Unicode spaces in queued commands", () => {
    const { setPendingTerminalInput, consumePendingTerminalInput } =
      useAppStore.getState();
    setPendingTerminalInput("sess-1", "cd '/tmp/a\u00a0b'\n");
    expect(consumePendingTerminalInput("sess-1")).toEqual({
      command: "cd '/tmp/a\u00a0b'\n",
      adoptWorktreeOnExit: false,
    });
  });

  it("does not cross-contaminate session ids", () => {
    const { setPendingTerminalInput, consumePendingTerminalInput } =
      useAppStore.getState();
    setPendingTerminalInput("sess-1", "one");
    setPendingTerminalInput("sess-2", "two");
    expect(consumePendingTerminalInput("sess-1")).toEqual({
      command: "one",
      adoptWorktreeOnExit: false,
    });
    expect(useAppStore.getState().pendingTerminalInput["sess-2"]).toEqual({
      command: "two",
      adoptWorktreeOnExit: false,
    });
  });

  it("marks explicit claude worktree commands for after-exit adoption", () => {
    const { setPendingTerminalInput, consumePendingTerminalInput } =
      useAppStore.getState();
    setPendingTerminalInput("sess-1", "claude --worktree");
    expect(consumePendingTerminalInput("sess-1")).toEqual({
      command: "claude --worktree",
      adoptWorktreeOnExit: true,
    });
  });

  it("keeps queued provider metadata with pending terminal input", () => {
    const { setPendingTerminalInput, consumePendingTerminalInput } =
      useAppStore.getState();
    setPendingTerminalInput("sess-1", "codex resume abc", {
      agentProvider: "codex",
    });
    expect(consumePendingTerminalInput("sess-1")).toEqual({
      command: "codex resume abc",
      adoptWorktreeOnExit: false,
      agentProvider: "codex",
    });
  });
});

describe("createSession returns the created session", () => {
  it("resolves to the api result on success so callers can react with the new id", async () => {
    const created: Session = session("new-id", REPO_A);
    mockApi.createSession.mockResolvedValueOnce(created);
    await seed([project(REPO_A, 0)], []);
    mockApi.listSessions.mockResolvedValueOnce([created]);
    mockApi.listProjects.mockResolvedValueOnce([project(REPO_A, 0)]);
    const result = await useAppStore
      .getState()
      .createSession("new-id", REPO_A);
    expect(result?.id).toBe("new-id");
  });

  it("resolves to null when the api call fails", async () => {
    mockApi.createSession.mockRejectedValueOnce(new Error("nope"));
    const result = await useAppStore
      .getState()
      .createSession("x", REPO_A);
    expect(result).toBeNull();
    expect(useAppStore.getState().error).toBe("nope");
  });
});

describe("right panel groups", () => {
  it("setRightTab records the tab and assigns it to its group's memory slot", () => {
    useAppStore.getState().setRightTab("prs");
    let s = useAppStore.getState();
    expect(s.rightTab).toBe("prs");
    expect(s.rightTabByGroup.github).toBe("prs");

    useAppStore.getState().setRightTab("actions");
    s = useAppStore.getState();
    expect(s.rightTab).toBe("actions");
    expect(s.rightTabByGroup.github).toBe("actions");
    // Other groups untouched.
    expect(s.rightTabByGroup.code).toBe("files");
    expect(s.rightTabByGroup.agents).toBe("history");
  });

  it("setRightGroup restores the group's last sub-tab", () => {
    useAppStore.getState().setRightTab("commits");
    useAppStore.getState().setRightTab("actions");
    useAppStore.getState().setRightTab("history");
    expect(useAppStore.getState().rightTab).toBe("history");

    useAppStore.getState().setRightGroup("code");
    expect(useAppStore.getState().rightTab).toBe("commits");

    useAppStore.getState().setRightGroup("github");
    expect(useAppStore.getState().rightTab).toBe("actions");

    useAppStore.getState().setRightGroup("agents");
    expect(useAppStore.getState().rightTab).toBe("history");
  });

  it("setRightGroup falls back to the group's default tab when no memory exists", () => {
    // Fresh store — rightTabByGroup is seeded with defaults; switching to a
    // group whose memory was never written returns the default.
    useAppStore.getState().setRightGroup("github");
    expect(useAppStore.getState().rightTab).toBe("prs");
  });

  it("keeps the selected tab and sub-tab memory per project", async () => {
    await seed(
      [project(REPO_A, 0), project(REPO_B, 1)],
      [session("a1", REPO_A), session("b1", REPO_B)],
    );

    useAppStore.getState().setActiveProject(REPO_A);
    useAppStore.getState().setRightTab("actions");
    useAppStore.getState().setRightTab("history");

    useAppStore.getState().setActiveProject(REPO_B);
    expect(useAppStore.getState().rightTab).toBe("commits");
    useAppStore.getState().setRightTab("prs");
    useAppStore.getState().setRightTab("todos");

    useAppStore.getState().setActiveProject(REPO_A);
    let s = useAppStore.getState();
    expect(s.rightTab).toBe("history");
    expect(s.rightTabByGroup.github).toBe("actions");
    s.setRightGroup("github");
    expect(useAppStore.getState().rightTab).toBe("actions");

    useAppStore.getState().setActiveProject(REPO_B);
    s = useAppStore.getState();
    expect(s.rightTab).toBe("todos");
    expect(s.rightTabByGroup.github).toBe("prs");
    s.setRightGroup("github");
    expect(useAppStore.getState().rightTab).toBe("prs");
  });
});

describe("auto initial session on first project add", () => {
  it("spawns one regular session when an existing project is added", async () => {
    mockApi.addProject.mockResolvedValueOnce(project(REPO_B, 1));
    mockApi.listProjects.mockResolvedValue([project(REPO_B, 1)]);
    mockApi.createSession.mockResolvedValueOnce(session("s-new", REPO_B));
    mockApi.listSessions.mockResolvedValue([session("s-new", REPO_B)]);

    await useAppStore.getState().addProject("Select project");

    expect(mockApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockApi.createSession).toHaveBeenCalledWith(
      "new session",
      REPO_B,
      false,
      "regular",
      null,
    );
    expect(useAppStore.getState().activeProject).toBe(REPO_B);
  });

  it("spawns one regular session when a new project is created", async () => {
    mockApi.createNewProject.mockResolvedValueOnce(project(REPO_B, 1));
    mockApi.listProjects.mockResolvedValue([project(REPO_B, 1)]);
    mockApi.createSession.mockResolvedValueOnce(session("s-new", REPO_B));
    mockApi.listSessions.mockResolvedValue([session("s-new", REPO_B)]);

    await useAppStore.getState().createNewProject("/Users/me", "repo-b");

    expect(mockApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockApi.createSession).toHaveBeenCalledWith(
      "new session",
      REPO_B,
      false,
      "regular",
      null,
    );
  });

  it("does not spawn a session when the folder picker is cancelled", async () => {
    mockApi.addProject.mockResolvedValueOnce(null);

    await useAppStore.getState().addProject("Select project");

    expect(mockApi.createSession).not.toHaveBeenCalled();
  });

  it("does not pile on a session when re-adding a project that already has one", async () => {
    await seed([project(REPO_A, 0)], [session("s1", REPO_A)]);
    mockApi.addProject.mockResolvedValueOnce(project(REPO_A, 0));

    await useAppStore.getState().addProject("Select project");

    expect(mockApi.createSession).not.toHaveBeenCalled();
  });
});
