import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { api } from "./lib/api";
import { useSettings } from "./lib/settings";
import type { Project, Session } from "./lib/types";
import {
  type Direction,
  type LayoutNode,
  type PaneId,
  type SplitSide,
  listPaneIds,
  makePaneNode,
  removePaneFromLayout,
  splitPaneInLayout,
} from "./lib/layout";

type RightTab = "todos" | "commits" | "staged" | "prs";

const ROOT_PANE_ID: PaneId = "root";

export interface PaneState {
  id: PaneId;
  sessionIds: string[];
  activeSessionId: string | null;
}

export interface ProjectWorkspace {
  layout: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focusedPaneId: PaneId;
}

export interface MoveTabArgs {
  sessionId: string;
  fromPaneId: PaneId;
  toPaneId: PaneId;
  toIndex?: number;
  splitDirection?: Direction;
  splitSide?: SplitSide;
}

interface AppStateModel {
  sessions: Session[];
  projects: Project[];

  // Per-project workspace state. Each project has independent layout/panes/focus.
  workspaces: Record<string, ProjectWorkspace>;
  activeProject: string | null;

  // Mirrors of `workspaces[activeProject]` for consumers; recomputed on every change.
  layout: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focusedPaneId: PaneId;
  activeSessionId: string | null;

  rightTab: RightTab;
  /** gh login most recently resolved as having access to a given repo, keyed
   *  by repo path. Populated by the PRs tab; consumed by the StatusBar to
   *  surface "which identity am I acting as for this repo". In-memory only. */
  prAccountByRepo: Record<string, string>;
  loading: boolean;
  error: string | null;
  pendingRemoveId: string | null;
  pendingRemoveProject: string | null;

  refreshSessions: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshAll: () => Promise<void>;
  /** Probe session liveness via JSONL transcripts; updates session statuses
   *  in place without touching `updated_at`. */
  pollSessionStatuses: () => Promise<void>;
  selectSession: (id: string | null) => void;
  setActiveProject: (repoPath: string) => void;
  setFocusedPane: (paneId: PaneId) => void;
  splitFocusedPane: (direction: Direction) => void;
  closeFocusedTab: () => void;
  closePane: (paneId: PaneId) => void;
  moveTab: (args: MoveTabArgs) => void;
  createSession: (
    name: string,
    repoPath: string,
    isolated?: boolean,
  ) => Promise<void>;
  removeSession: (id: string, removeWorktree?: boolean) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  adoptSessionWorktree: (id: string, worktreePath: string) => Promise<void>;
  requestRemoveSession: (id: string) => void;
  clearPendingRemove: () => void;
  cycleTab: (direction: 1 | -1) => void;
  cycleProject: (direction: 1 | -1) => void;
  addProject: (repoPath: string) => Promise<void>;
  removeProject: (repoPath: string, removeWorktrees?: boolean) => Promise<void>;
  reorderProjects: (orderedRepoPaths: string[]) => Promise<void>;
  requestRemoveProject: (repoPath: string) => void;
  clearPendingRemoveProject: () => void;
  setRightTab: (tab: RightTab) => void;
  setPrAccountForRepo: (repoPath: string, login: string | null) => void;
}

let paneCounter = 0;
function nextPaneId(): PaneId {
  paneCounter += 1;
  return `pane-${Date.now().toString(36)}-${paneCounter}`;
}
let splitCounter = 0;
function nextSplitId(): string {
  splitCounter += 1;
  return `split-${Date.now().toString(36)}-${splitCounter}`;
}

function emptyPane(id: PaneId): PaneState {
  return { id, sessionIds: [], activeSessionId: null };
}

function emptyWorkspace(): ProjectWorkspace {
  return {
    layout: makePaneNode(ROOT_PANE_ID),
    panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) },
    focusedPaneId: ROOT_PANE_ID,
  };
}

function fallbackEmptyMirror() {
  return {
    layout: makePaneNode(ROOT_PANE_ID),
    panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) } as Record<
      PaneId,
      PaneState
    >,
    focusedPaneId: ROOT_PANE_ID as PaneId,
    activeSessionId: null as string | null,
  };
}

function mirrorActive(
  workspaces: Record<string, ProjectWorkspace>,
  activeProject: string | null,
) {
  if (!activeProject) return fallbackEmptyMirror();
  const ws = workspaces[activeProject];
  if (!ws) return fallbackEmptyMirror();
  return {
    layout: ws.layout,
    panes: ws.panes,
    focusedPaneId: ws.focusedPaneId,
    activeSessionId: ws.panes[ws.focusedPaneId]?.activeSessionId ?? null,
  };
}

/**
 * Reconcile a single project's pane state with that project's session list.
 * New sessions land in the focused pane. Removed sessions are dropped.
 * Empty non-only panes are collapsed.
 */
function reconcileWorkspace(
  ws: ProjectWorkspace,
  sessions: Session[],
): ProjectWorkspace {
  const knownIds = new Set(sessions.map((s) => s.id));
  const validPaneIds = new Set(listPaneIds(ws.layout));

  let newPanes: Record<PaneId, PaneState> = {};
  for (const pid of validPaneIds) {
    const existing = ws.panes[pid] ?? emptyPane(pid);
    const filtered = existing.sessionIds.filter((id) => knownIds.has(id));
    const active =
      existing.activeSessionId && filtered.includes(existing.activeSessionId)
        ? existing.activeSessionId
        : filtered[filtered.length - 1] ?? null;
    newPanes[pid] = {
      id: pid,
      sessionIds: filtered,
      activeSessionId: active,
    };
  }

  const assigned = new Set<string>();
  for (const p of Object.values(newPanes)) {
    for (const id of p.sessionIds) assigned.add(id);
  }
  let target = newPanes[ws.focusedPaneId] ? ws.focusedPaneId : ROOT_PANE_ID;
  if (!newPanes[target]) {
    target = Object.keys(newPanes)[0] ?? ROOT_PANE_ID;
    if (!newPanes[target]) newPanes[target] = emptyPane(target);
  }
  for (const s of sessions) {
    if (!assigned.has(s.id)) {
      const pane = newPanes[target];
      newPanes[target] = {
        ...pane,
        sessionIds: [...pane.sessionIds, s.id],
        activeSessionId: pane.activeSessionId ?? s.id,
      };
      assigned.add(s.id);
    }
  }

  // Empty panes are intentionally preserved (e.g. user split A→A+B and B is
  // a drop target waiting for a tab). User closes panes explicitly via
  // closePane / cmd+W. Reconcile must not silently delete them.
  const newLayout = ws.layout;

  let newFocused = ws.focusedPaneId;
  if (!newPanes[newFocused]) {
    newFocused = listPaneIds(newLayout)[0] ?? ROOT_PANE_ID;
    if (!newPanes[newFocused]) newPanes[newFocused] = emptyPane(newFocused);
  }

  return {
    layout: newLayout,
    panes: newPanes,
    focusedPaneId: newFocused,
  };
}

function reconcileWorkspaces(
  sessions: Session[],
  projects: Project[],
  workspaces: Record<string, ProjectWorkspace>,
  activeProject: string | null,
): {
  workspaces: Record<string, ProjectWorkspace>;
  activeProject: string | null;
} {
  // Group sessions per project repo path. Include known projects even if empty.
  const byProject: Record<string, Session[]> = {};
  for (const p of projects) byProject[p.repo_path] = [];
  for (const s of sessions) {
    if (!byProject[s.repo_path]) byProject[s.repo_path] = [];
    byProject[s.repo_path].push(s);
  }

  const newWorkspaces: Record<string, ProjectWorkspace> = {};
  for (const [repoPath, projSessions] of Object.entries(byProject)) {
    const existing = workspaces[repoPath] ?? emptyWorkspace();
    newWorkspaces[repoPath] = reconcileWorkspace(existing, projSessions);
  }

  // Resolve active project: keep current if still valid; else first project
  // with a session; else first project; else null.
  let newActive = activeProject;
  if (newActive && !newWorkspaces[newActive]) newActive = null;
  if (!newActive) {
    const withSession = projects.find(
      (p) => (byProject[p.repo_path]?.length ?? 0) > 0,
    );
    newActive = withSession?.repo_path ?? projects[0]?.repo_path ?? null;
  }

  return { workspaces: newWorkspaces, activeProject: newActive };
}

function findPaneContainingSession(
  panes: Record<PaneId, PaneState>,
  sessionId: string,
): PaneId | null {
  for (const [pid, p] of Object.entries(panes)) {
    if (p.sessionIds.includes(sessionId)) return pid;
  }
  return null;
}

function updateActiveWorkspace(
  s: AppStateModel,
  updater: (ws: ProjectWorkspace) => ProjectWorkspace,
): Partial<AppStateModel> | null {
  if (!s.activeProject) return null;
  const ws = s.workspaces[s.activeProject];
  if (!ws) return null;
  const next = updater(ws);
  if (next === ws) return null;
  const workspaces = { ...s.workspaces, [s.activeProject]: next };
  return {
    workspaces,
    ...mirrorActive(workspaces, s.activeProject),
  };
}

export const useAppStore = create<AppStateModel>()(
  persist(
    (set, get) => ({
  sessions: [],
  projects: [],

  workspaces: {},
  activeProject: null,

  layout: makePaneNode(ROOT_PANE_ID),
  panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) },
  focusedPaneId: ROOT_PANE_ID,
  activeSessionId: null,

  rightTab: "commits",
  prAccountByRepo: {},
  loading: false,
  error: null,
  pendingRemoveId: null,
  pendingRemoveProject: null,

  async refreshSessions() {
    set({ loading: true, error: null });
    try {
      const sessions = await api.listSessions();
      set((s) => {
        const reconciled = reconcileWorkspaces(
          sessions,
          s.projects,
          s.workspaces,
          s.activeProject,
        );
        return {
          sessions,
          loading: false,
          workspaces: reconciled.workspaces,
          activeProject: reconciled.activeProject,
          ...mirrorActive(reconciled.workspaces, reconciled.activeProject),
        };
      });
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
    }
  },

  async refreshProjects() {
    try {
      const projects = await api.listProjects();
      set((s) => {
        const reconciled = reconcileWorkspaces(
          s.sessions,
          projects,
          s.workspaces,
          s.activeProject,
        );
        return {
          projects,
          workspaces: reconciled.workspaces,
          activeProject: reconciled.activeProject,
          ...mirrorActive(reconciled.workspaces, reconciled.activeProject),
        };
      });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async refreshAll() {
    await Promise.all([get().refreshSessions(), get().refreshProjects()]);
  },

  async pollSessionStatuses() {
    const ids = get().sessions.map((s) => s.id);
    if (ids.length === 0) return;
    try {
      const updates = await api.detectSessionStatuses(ids);
      const map = new Map(updates.map((u) => [u.id, u.status]));
      set((s) => {
        let changed = false;
        const nextSessions = s.sessions.map((sess) => {
          const next = map.get(sess.id);
          if (next && next !== sess.status) {
            changed = true;
            return { ...sess, status: next };
          }
          return sess;
        });
        return changed ? { sessions: nextSessions } : s;
      });
    } catch (e) {
      // Polling errors are non-fatal: log and move on.
      console.warn("[acorn] pollSessionStatuses failed", e);
    }
  },

  selectSession(id) {
    set((s) => {
      // Clear within active workspace
      if (id === null) {
        const patch = updateActiveWorkspace(s, (ws) => {
          const pane = ws.panes[ws.focusedPaneId];
          if (!pane) return ws;
          return {
            ...ws,
            panes: {
              ...ws.panes,
              [ws.focusedPaneId]: { ...pane, activeSessionId: null },
            },
          };
        });
        return patch ?? s;
      }

      // Find session, switch active project to its repo, set active in pane
      const session = s.sessions.find((x) => x.id === id);
      if (!session) return s;

      const targetProject = session.repo_path;
      const ws = s.workspaces[targetProject];
      if (!ws) return s;

      const containing = findPaneContainingSession(ws.panes, id);
      const targetPaneId = containing ?? ws.focusedPaneId;
      const pane =
        ws.panes[targetPaneId] ?? emptyPane(targetPaneId);
      const sessionIds = pane.sessionIds.includes(id)
        ? pane.sessionIds
        : [...pane.sessionIds, id];
      const newWs: ProjectWorkspace = {
        ...ws,
        panes: {
          ...ws.panes,
          [targetPaneId]: {
            ...pane,
            sessionIds,
            activeSessionId: id,
          },
        },
        focusedPaneId: targetPaneId,
      };
      const workspaces = { ...s.workspaces, [targetProject]: newWs };
      return {
        workspaces,
        activeProject: targetProject,
        ...mirrorActive(workspaces, targetProject),
      };
    });
  },

  setActiveProject(repoPath) {
    set((s) => {
      if (!s.workspaces[repoPath]) return s;
      if (s.activeProject === repoPath) return s;
      return {
        activeProject: repoPath,
        ...mirrorActive(s.workspaces, repoPath),
      };
    });
  },

  setFocusedPane(paneId) {
    set((s) => {
      const patch = updateActiveWorkspace(s, (ws) => {
        if (!ws.panes[paneId]) return ws;
        if (ws.focusedPaneId === paneId) return ws;
        return { ...ws, focusedPaneId: paneId };
      });
      return patch ?? s;
    });
  },

  splitFocusedPane(direction) {
    set((s) => {
      const patch = updateActiveWorkspace(s, (ws) => {
        const focusPane = ws.panes[ws.focusedPaneId];
        if (!focusPane) return ws;
        const newPaneId = nextPaneId();
        const newLayout = splitPaneInLayout(
          ws.layout,
          ws.focusedPaneId,
          direction,
          newPaneId,
          "after",
          nextSplitId(),
        );
        return {
          layout: newLayout,
          panes: { ...ws.panes, [newPaneId]: emptyPane(newPaneId) },
          focusedPaneId: newPaneId,
        };
      });
      return patch ?? s;
    });
  },

  cycleTab(direction) {
    set((s) => {
      const patch = updateActiveWorkspace(s, (ws) => {
        const pane = ws.panes[ws.focusedPaneId];
        if (!pane || pane.sessionIds.length === 0) return ws;
        const ids = pane.sessionIds;
        const currentIdx = pane.activeSessionId
          ? ids.indexOf(pane.activeSessionId)
          : -1;
        const nextIdx =
          currentIdx < 0
            ? direction > 0
              ? 0
              : ids.length - 1
            : (currentIdx + direction + ids.length) % ids.length;
        const nextId = ids[nextIdx];
        if (nextId === pane.activeSessionId) return ws;
        return {
          ...ws,
          panes: {
            ...ws.panes,
            [ws.focusedPaneId]: { ...pane, activeSessionId: nextId },
          },
        };
      });
      return patch ?? s;
    });
  },

  cycleProject(direction) {
    const { projects, activeProject } = get();
    if (projects.length === 0) return;
    const order = projects.map((p) => p.repo_path);
    const currentIdx = activeProject ? order.indexOf(activeProject) : -1;
    const nextIdx =
      currentIdx < 0
        ? direction > 0
          ? 0
          : order.length - 1
        : (currentIdx + direction + order.length) % order.length;
    const target = order[nextIdx];
    if (!target || target === activeProject) return;
    get().setActiveProject(target);
  },

  closeFocusedTab() {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    get().requestRemoveSession(activeSessionId);
  },

  closePane(paneId) {
    set((s) => {
      const patch = updateActiveWorkspace(s, (ws) => {
        const total = Object.keys(ws.panes).length;
        if (total <= 1) return ws;
        const pane = ws.panes[paneId];
        if (!pane) return ws;
        const collapsed = removePaneFromLayout(ws.layout, paneId);
        if (!collapsed) return ws;
        const newPanes: Record<PaneId, PaneState> = { ...ws.panes };
        delete newPanes[paneId];
        const surviving = listPaneIds(collapsed);
        const fallback = surviving[0] ?? ROOT_PANE_ID;
        if (newPanes[fallback] && pane.sessionIds.length > 0) {
          const target = newPanes[fallback];
          newPanes[fallback] = {
            ...target,
            sessionIds: [...target.sessionIds, ...pane.sessionIds],
            activeSessionId: target.activeSessionId ?? pane.activeSessionId,
          };
        }
        return {
          layout: collapsed,
          panes: newPanes,
          focusedPaneId: fallback,
        };
      });
      return patch ?? s;
    });
  },

  moveTab(args) {
    set((s) => {
      // moveTab is intra-workspace only — tabs can't cross projects.
      const patch = updateActiveWorkspace(s, (ws) => {
        const fromPane = ws.panes[args.fromPaneId];
        if (!fromPane || !fromPane.sessionIds.includes(args.sessionId))
          return ws;

        const srcSessionIds = fromPane.sessionIds.filter(
          (id) => id !== args.sessionId,
        );
        const srcActive =
          fromPane.activeSessionId === args.sessionId
            ? srcSessionIds[srcSessionIds.length - 1] ?? null
            : fromPane.activeSessionId;
        let newPanes: Record<PaneId, PaneState> = {
          ...ws.panes,
          [args.fromPaneId]: {
            ...fromPane,
            sessionIds: srcSessionIds,
            activeSessionId: srcActive,
          },
        };

        let newLayout = ws.layout;
        let toPaneId = args.toPaneId;

        if (args.splitDirection && args.splitSide) {
          const newPaneId = nextPaneId();
          newLayout = splitPaneInLayout(
            newLayout,
            args.toPaneId,
            args.splitDirection,
            newPaneId,
            args.splitSide,
            nextSplitId(),
          );
          newPanes[newPaneId] = emptyPane(newPaneId);
          toPaneId = newPaneId;
        }

        const toPane = newPanes[toPaneId];
        if (!toPane) return ws;

        const safeIndex =
          typeof args.toIndex === "number"
            ? Math.max(0, Math.min(args.toIndex, toPane.sessionIds.length))
            : toPane.sessionIds.length;
        const targetIds = [...toPane.sessionIds];
        targetIds.splice(safeIndex, 0, args.sessionId);
        newPanes[toPaneId] = {
          ...toPane,
          sessionIds: targetIds,
          activeSessionId: args.sessionId,
        };

        const totalPanes = Object.keys(newPanes).length;
        if (
          srcSessionIds.length === 0 &&
          totalPanes > 1 &&
          args.fromPaneId !== toPaneId
        ) {
          const collapsed = removePaneFromLayout(newLayout, args.fromPaneId);
          if (collapsed) {
            newLayout = collapsed;
            delete newPanes[args.fromPaneId];
          }
        }

        return {
          layout: newLayout,
          panes: newPanes,
          focusedPaneId: toPaneId,
        };
      });
      return patch ?? s;
    });
  },

  async createSession(name, repoPath, isolated = false) {
    set({ loading: true, error: null });
    try {
      // Snapshot the current global startup mode onto the session so a
      // later change to `sessionStartup.mode` does not retroactively swap
      // how this session respawns after an app restart.
      const startupMode = useSettings.getState().settings.sessionStartup.mode;
      await api.createSession(name, repoPath, isolated, startupMode);
      await get().refreshAll();
      // Ensure the project of the new session is active so its tab shows up.
      set((s) => {
        if (s.workspaces[repoPath] && s.activeProject !== repoPath) {
          return {
            activeProject: repoPath,
            ...mirrorActive(s.workspaces, repoPath),
          };
        }
        return s;
      });
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
    }
  },

  async removeSession(id, removeWorktree = false) {
    try {
      await api.removeSession(id, removeWorktree);
      await get().refreshAll();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async renameSession(id, name) {
    try {
      await api.renameSession(id, name);
      await get().refreshSessions();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async adoptSessionWorktree(id, worktreePath) {
    try {
      await api.updateSessionWorktree(id, worktreePath);
      await get().refreshSessions();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  requestRemoveSession(id) {
    set({ pendingRemoveId: id });
  },

  clearPendingRemove() {
    set({ pendingRemoveId: null });
  },

  async addProject(repoPath) {
    try {
      await api.addProject(repoPath);
      await get().refreshProjects();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async removeProject(repoPath, removeWorktrees = false) {
    try {
      await api.removeProject(repoPath, true, removeWorktrees);
      // Drop the project's workspace from local state explicitly — refreshAll
      // also reconciles, but pre-clearing avoids a flash of stale state.
      set((s) => {
        const { [repoPath]: _, ...rest } = s.workspaces;
        const nextActive =
          s.activeProject === repoPath ? null : s.activeProject;
        return {
          workspaces: rest,
          activeProject: nextActive,
          ...mirrorActive(rest, nextActive),
        };
      });
      await get().refreshAll();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async reorderProjects(orderedRepoPaths) {
    const previous = get().projects;
    const indexOf = new Map<string, number>();
    orderedRepoPaths.forEach((path, i) => indexOf.set(path, i));
    const optimistic = [...previous].sort((a, b) => {
      const ai = indexOf.get(a.repo_path) ?? Number.POSITIVE_INFINITY;
      const bi = indexOf.get(b.repo_path) ?? Number.POSITIVE_INFINITY;
      if (ai === bi) return a.name.localeCompare(b.name);
      return ai - bi;
    });
    set({ projects: optimistic });
    try {
      const updated = await api.reorderProjects(orderedRepoPaths);
      set({ projects: updated });
    } catch (e) {
      set({ projects: previous, error: errorMessage(e) });
    }
  },

  requestRemoveProject(repoPath) {
    set({ pendingRemoveProject: repoPath });
  },

  clearPendingRemoveProject() {
    set({ pendingRemoveProject: null });
  },

  setRightTab(tab) {
    set({ rightTab: tab });
  },

  setPrAccountForRepo(repoPath, login) {
    set((s) => {
      const prev = s.prAccountByRepo[repoPath] ?? null;
      if (login === null) {
        if (prev === null) return s;
        const { [repoPath]: _, ...rest } = s.prAccountByRepo;
        return { prAccountByRepo: rest };
      }
      if (prev === login) return s;
      return {
        prAccountByRepo: { ...s.prAccountByRepo, [repoPath]: login },
      };
    });
  },
    }),
    {
      name: "acorn-workspaces",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        workspaces: state.workspaces,
        activeProject: state.activeProject,
        rightTab: state.rightTab,
      }),
      // Recompute the active-workspace mirror after hydration so consumers
      // see the persisted layout immediately, before the first refreshAll.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        Object.assign(
          state,
          mirrorActive(state.workspaces, state.activeProject),
        );
      },
    },
  ),
);

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
