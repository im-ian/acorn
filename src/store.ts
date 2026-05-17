import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { api } from "./lib/api";
import type { Project, Session, SessionKind } from "./lib/types";
import { commandRequestsWorktreeAdoption } from "./lib/worktreeAdoption";
import { CONTROL_GUIDE_DISMISSED_KEY } from "./components/ControlSessionGuideModal";
import {
  type Direction,
  type LayoutNode,
  type PaneFocusDirection,
  type PaneId,
  type SplitSide,
  findAdjacentPaneId,
  listPaneIds,
  makePaneNode,
  removePaneFromLayout,
  splitPaneInLayout,
} from "./lib/layout";
import {
  activeSessionIdFromTabId,
  isRestorableWorkspaceTab,
  isWorkspaceTabId,
  makeCodeWorkspaceTab,
  type FrontendWorkspaceTab,
} from "./lib/workspaceTabs";
import {
  defaultTabByGroup,
  defaultTabForGroup,
  groupOfTab,
  isRightTab,
  type RightGroup,
  type RightTab,
} from "./lib/rightPanelGroups";

export type { RightGroup, RightTab };

const ROOT_PANE_ID: PaneId = "root";

export interface PaneState {
  id: PaneId;
  tabIds: string[];
  activeTabId: string | null;
}

export interface ProjectWorkspace {
  layout: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focusedPaneId: PaneId;
}

export interface MoveTabArgs {
  tabId: string;
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
  activeTabId: string | null;
  activeSessionId: string | null;

  rightTab: RightTab;
  /**
   * Last sub-tab selected per group. Lets the user switch groups via the
   * top-level group bar and return to their previous sub-tab in each group
   * without re-clicking.
   */
  rightTabByGroup: Record<RightGroup, RightTab>;
  /**
   * Frontend-owned tabs such as readonly code viewers. Terminal sessions
   * use their backend session id directly as the tab id and therefore do
   * not appear in this map.
   */
  workspaceTabs: Record<string, FrontendWorkspaceTab>;
  /** gh login most recently resolved as having access to a given repo, keyed
   *  by repo path. Populated by the PRs tab; consumed by the StatusBar to
   *  surface "which identity am I acting as for this repo". In-memory only. */
  prAccountByRepo: Record<string, string>;
  /**
   * One-shot command metadata to write into a session's PTY immediately after
   * its shell finishes spawning. Used by `CommandRunDialog` to launch a
   * freshly created session that then executes a fixed command (e.g. `gh auth
   * login`). Terminal.tsx consumes and clears the entry inside the `pty_spawn`
   * resolver, so the value is in-memory only and never persisted.
   */
  pendingTerminalInput: Record<string, PendingTerminalInput>;
  multiInputEnabled: boolean;
  loading: boolean;
  error: string | null;
  pendingRemoveId: string | null;
  pendingRemoveProject: string | null;

  /**
   * Set to false at boot if the backend reports that `sessions.json` failed
   * to load (file existed but could not be read or parsed). When false,
   * `reconcileWorkspace` refuses to wipe a pane's `tabIds` on the basis
   * of an empty backend list — protecting layouts from being destroyed by a
   * transient disk failure or a schema-incompatible build run from another
   * worktree. Cleared (set back to true) once the user takes any action that
   * results in a non-empty backend session list.
   */
  sessionsLoadedCleanly: boolean;
  /**
   * Session ids whose *live* PTY cwd resolves inside a linked git worktree
   * (`.git` is a file). Separate from `Session.in_worktree`, which only
   * reflects the recorded `worktree_path` at spawn / adoption time — this
   * map catches the user typing `cd /some/other/worktree` interactively.
   * Populated event-driven (after `refreshSessions` and on window focus),
   * never on an interval, so the batched probe stays cheap.
   */
  liveInWorktree: Record<string, boolean>;
  loadInitialStatus: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** Re-probe every session's live cwd in one batched backend call. */
  refreshLiveInWorktree: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshAll: () => Promise<void>;
  /** Probe session liveness via JSONL transcripts; updates session statuses
   *  in place without touching `updated_at`. */
  pollSessionStatuses: () => Promise<void>;
  selectTab: (id: string | null) => void;
  selectSession: (id: string | null) => void;
  setActiveProject: (repoPath: string) => void;
  setFocusedPane: (paneId: PaneId) => void;
  focusAdjacentPane: (direction: PaneFocusDirection) => void;
  splitFocusedPane: (direction: Direction) => void;
  closeFocusedTab: () => void;
  closePane: (paneId: PaneId) => void;
  moveTab: (args: MoveTabArgs) => void;
  createSession: (
    name: string,
    repoPath: string,
    isolated?: boolean,
    kind?: SessionKind,
  ) => Promise<Session | null>;
  removeSession: (id: string, removeWorktree?: boolean) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  adoptSessionWorktree: (id: string, worktreePath: string) => Promise<void>;
  requestRemoveSession: (id: string) => void;
  clearPendingRemove: () => void;
  cycleTab: (direction: 1 | -1) => void;
  cycleProject: (direction: 1 | -1) => void;
  addProject: (repoPath: string) => Promise<void>;
  createNewProject: (
    parentPath: string,
    name: string,
    ignoreSafeName?: boolean,
  ) => Promise<Project>;
  removeProject: (repoPath: string, removeWorktrees?: boolean) => Promise<void>;
  reorderProjects: (orderedRepoPaths: string[]) => Promise<void>;
  reorderSessions: (repoPath: string, orderedIds: string[]) => Promise<void>;
  requestRemoveProject: (repoPath: string) => void;
  clearPendingRemoveProject: () => void;
  setRightTab: (tab: RightTab) => void;
  /** Switch to `group` and restore that group's last sub-tab. */
  setRightGroup: (group: RightGroup) => void;
  setPrAccountForRepo: (repoPath: string, login: string | null) => void;
  /** Queue a command for the next successful `pty_spawn` of `sessionId`. */
  setPendingTerminalInput: (
    sessionId: string,
    command: string,
    options?: PendingTerminalInputOptions,
  ) => void;
  /** Atomically read and remove the queued command for `sessionId`. */
  consumePendingTerminalInput: (sessionId: string) => PendingTerminalInput | null;
  toggleMultiInput: () => boolean;
  /** Open a readonly code viewer tab for `path` in the focused pane. */
  openCodeViewerTab: (path: string) => void;
  /** Close any frontend-owned tab and remove it from panes. */
  closeWorkspaceTab: (id: string) => void;
}

export interface PendingTerminalInput {
  command: string;
  adoptWorktreeOnExit: boolean;
}

export interface PendingTerminalInputOptions {
  adoptWorktreeOnExit?: boolean;
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
  return { id, tabIds: [], activeTabId: null };
}

type PersistedPaneState = Partial<PaneState> & {
  sessionIds?: string[];
  activeSessionId?: string | null;
};

function normalizePaneState(
  pane: PersistedPaneState | undefined,
  id: PaneId,
): PaneState {
  const tabIds = Array.isArray(pane?.tabIds)
    ? pane.tabIds
    : Array.isArray(pane?.sessionIds)
      ? pane.sessionIds
      : [];
  const activeTabId =
    pane?.activeTabId !== undefined
      ? pane.activeTabId
      : pane?.activeSessionId !== undefined
        ? pane.activeSessionId
        : null;
  return { id, tabIds, activeTabId };
}

function emptyWorkspace(): ProjectWorkspace {
  return {
    layout: makePaneNode(ROOT_PANE_ID),
    panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) },
    focusedPaneId: ROOT_PANE_ID,
  };
}

function fallbackEmptyMirror() {
  const activeTabId = null as string | null;
  return {
    layout: makePaneNode(ROOT_PANE_ID),
    panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) } as Record<
      PaneId,
      PaneState
    >,
    focusedPaneId: ROOT_PANE_ID as PaneId,
    activeTabId,
    activeSessionId: activeSessionIdFromTabId(activeTabId),
  };
}

function mirrorActive(
  workspaces: Record<string, ProjectWorkspace>,
  activeProject: string | null,
) {
  if (!activeProject) return fallbackEmptyMirror();
  const ws = workspaces[activeProject];
  if (!ws) return fallbackEmptyMirror();
  const activeTabId = ws.panes[ws.focusedPaneId]?.activeTabId ?? null;
  return {
    layout: ws.layout,
    panes: ws.panes,
    focusedPaneId: ws.focusedPaneId,
    activeTabId,
    activeSessionId: activeSessionIdFromTabId(activeTabId),
  };
}

/**
 * Reconcile a single project's pane state with that project's session list.
 * New sessions land in the focused pane. Removed sessions are dropped.
 * Empty non-only panes are collapsed.
 *
 * `allowEmptyWipe` is the safety knob for the boot-time disk-corruption
 * scenario. When `false` and `sessions` is empty *while the workspace still
 * remembers session ids*, this function returns the workspace unchanged
 * rather than zeroing every pane's `tabIds`. This avoids the cascade
 * where a transient `sessions.json` read failure (or a schema-incompatible
 * build from another worktree) erases the persisted layout permanently.
 */
function reconcileWorkspace(
  ws: ProjectWorkspace,
  sessions: Session[],
  allowEmptyWipe = true,
): ProjectWorkspace {
  if (
    !allowEmptyWipe &&
    sessions.length === 0 &&
    Object.values(ws.panes).some((p) => p.tabIds.length > 0)
  ) {
    return ws;
  }
  const knownIds = new Set(sessions.map((s) => s.id));
  const validPaneIds = new Set(listPaneIds(ws.layout));

  let newPanes: Record<PaneId, PaneState> = {};
  for (const pid of validPaneIds) {
    const existing = normalizePaneState(ws.panes[pid], pid);
    // Frontend-owned tab ids live alongside session ids in the same array
    // but are not tracked by the backend, so the session-list filter must
    // preserve them explicitly.
    const filtered = existing.tabIds.filter(
      (id) => knownIds.has(id) || isWorkspaceTabId(id),
    );
    const active =
      existing.activeTabId && filtered.includes(existing.activeTabId)
        ? existing.activeTabId
        : filtered[filtered.length - 1] ?? null;
    newPanes[pid] = {
      id: pid,
      tabIds: filtered,
      activeTabId: active,
    };
  }

  const assigned = new Set<string>();
  for (const p of Object.values(newPanes)) {
    for (const id of p.tabIds) assigned.add(id);
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
        tabIds: [...pane.tabIds, s.id],
        activeTabId: pane.activeTabId ?? s.id,
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
  allowEmptyWipe = true,
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
    newWorkspaces[repoPath] = reconcileWorkspace(
      existing,
      projSessions,
      allowEmptyWipe,
    );
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

function findPaneContainingTab(
  panes: Record<PaneId, PaneState>,
  tabId: string,
): PaneId | null {
  for (const [pid, p] of Object.entries(panes)) {
    if (p.tabIds.includes(tabId)) return pid;
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

  async loadInitialStatus() {
    try {
      const status = await api.loadStatus();
      set({ sessionsLoadedCleanly: status.sessionsClean });
      if (!status.sessionsClean) {
        console.warn(
          "[store] backend reports sessions.json failed to load; pane wipe guard active",
        );
      }
    } catch (e) {
      // Treat status RPC failure as "assume unclean" so we err on the side
      // of preserving the persisted layout. The user can still recover by
      // creating sessions, which clears the guard automatically.
      console.warn("[store] load_status RPC failed", e);
      set({ sessionsLoadedCleanly: false });
    }
  },

  async refreshSessions() {
    set({ loading: true, error: null });
    try {
      const sessions = await api.listSessions();
      set((s) => {
        const allowEmptyWipe = s.sessionsLoadedCleanly;
        const reconciled = reconcileWorkspaces(
          sessions,
          s.projects,
          s.workspaces,
          s.activeProject,
          allowEmptyWipe,
        );
        // Once the backend returns any sessions we trust subsequent empty
        // results to be intentional (user removed them all). Drop the guard.
        const nextSessionsLoadedCleanly =
          s.sessionsLoadedCleanly || sessions.length > 0;
        return {
          sessions,
          loading: false,
          sessionsLoadedCleanly: nextSessionsLoadedCleanly,
          workspaces: reconciled.workspaces,
          activeProject: reconciled.activeProject,
          ...mirrorActive(reconciled.workspaces, reconciled.activeProject),
        };
      });
      void get().refreshLiveInWorktree();
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
    }
  },

  async refreshLiveInWorktree() {
    try {
      const map = await api.ptyInWorktreeAll();
      // Components do `s.liveInWorktree[id]`; null would crash that access.
      // Backend returns an object in practice, but the mock fallback path
      // (and any future RPC that returns null on degraded states) needs the
      // guard to keep the store contract intact.
      set({ liveInWorktree: map ?? {} });
    } catch (e) {
      console.debug("[store] refreshLiveInWorktree failed", e);
    }
  },

  async refreshProjects() {
    try {
      const projects = await api.listProjects();
      set((s) => {
        const allowEmptyWipe = s.sessionsLoadedCleanly;
        const reconciled = reconcileWorkspaces(
          s.sessions,
          projects,
          s.workspaces,
          s.activeProject,
          allowEmptyWipe,
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
      const map = new Map(updates.map((u) => [u.id, u]));
      set((s) => {
        let changed = false;
        const nextSessions = s.sessions.map((sess) => {
          const update = map.get(sess.id);
          if (!update) return sess;
          const nextStatus = update.status;
          const nextBranch = update.branch ?? sess.branch;
          if (nextStatus !== sess.status || nextBranch !== sess.branch) {
            changed = true;
            return { ...sess, status: nextStatus, branch: nextBranch };
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

  selectTab(id) {
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
              [ws.focusedPaneId]: { ...pane, activeTabId: null },
            },
          };
        });
        return patch ?? s;
      }

      if (isWorkspaceTabId(id)) {
        const tab = s.workspaceTabs[id];
        const targetProject = tab?.repoPath ?? s.activeProject;
        if (!targetProject) return s;
        const ws = s.workspaces[targetProject];
        if (!ws) return s;
        const containing = findPaneContainingTab(ws.panes, id);
        if (!containing) return s;
        const pane = ws.panes[containing];
        if (!pane) return s;
        const nextWs: ProjectWorkspace = {
          ...ws,
          panes: {
            ...ws.panes,
            [containing]: { ...pane, activeTabId: id },
          },
          focusedPaneId: containing,
        };
        const workspaces = { ...s.workspaces, [targetProject]: nextWs };
        return {
          workspaces,
          activeProject: targetProject,
          ...mirrorActive(workspaces, targetProject),
        };
      }

      // Find session, switch active project to its repo, set active in pane.
      const session = s.sessions.find((x) => x.id === id);
      if (!session) return s;

      const targetProject = session.repo_path;
      const ws = s.workspaces[targetProject];
      if (!ws) return s;

      const containing = findPaneContainingTab(ws.panes, id);
      const targetPaneId = containing ?? ws.focusedPaneId;
      const pane =
        ws.panes[targetPaneId] ?? emptyPane(targetPaneId);
      const tabIds = pane.tabIds.includes(id)
        ? pane.tabIds
        : [...pane.tabIds, id];
      const newWs: ProjectWorkspace = {
        ...ws,
        panes: {
          ...ws.panes,
          [targetPaneId]: {
            ...pane,
            tabIds,
            activeTabId: id,
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

  selectSession(id) {
    get().selectTab(id);
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

  focusAdjacentPane(direction) {
    set((s) => {
      const patch = updateActiveWorkspace(s, (ws) => {
        const nextPaneId = findAdjacentPaneId(
          ws.layout,
          ws.focusedPaneId,
          direction,
        );
        if (!nextPaneId || !ws.panes[nextPaneId]) return ws;
        return { ...ws, focusedPaneId: nextPaneId };
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
        if (!pane || pane.tabIds.length === 0) return ws;
        const ids = pane.tabIds;
        const currentIdx = pane.activeTabId
          ? ids.indexOf(pane.activeTabId)
          : -1;
        const nextIdx =
          currentIdx < 0
            ? direction > 0
              ? 0
              : ids.length - 1
            : (currentIdx + direction + ids.length) % ids.length;
        const nextId = ids[nextIdx];
        if (nextId === pane.activeTabId) return ws;
        return {
          ...ws,
          panes: {
            ...ws.panes,
            [ws.focusedPaneId]: { ...pane, activeTabId: nextId },
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
    const { activeTabId } = get();
    if (!activeTabId) return;
    if (isWorkspaceTabId(activeTabId)) {
      get().closeWorkspaceTab(activeTabId);
      return;
    }
    get().requestRemoveSession(activeTabId);
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
        if (newPanes[fallback] && pane.tabIds.length > 0) {
          const target = newPanes[fallback];
          newPanes[fallback] = {
            ...target,
            tabIds: [...target.tabIds, ...pane.tabIds],
            activeTabId: target.activeTabId ?? pane.activeTabId,
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
        if (!fromPane || !fromPane.tabIds.includes(args.tabId))
          return ws;

        const srcTabIds = fromPane.tabIds.filter(
          (id) => id !== args.tabId,
        );
        const srcActive =
          fromPane.activeTabId === args.tabId
            ? srcTabIds[srcTabIds.length - 1] ?? null
            : fromPane.activeTabId;
        let newPanes: Record<PaneId, PaneState> = {
          ...ws.panes,
          [args.fromPaneId]: {
            ...fromPane,
            tabIds: srcTabIds,
            activeTabId: srcActive,
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
            ? Math.max(0, Math.min(args.toIndex, toPane.tabIds.length))
            : toPane.tabIds.length;
        const targetIds = [...toPane.tabIds];
        targetIds.splice(safeIndex, 0, args.tabId);
        newPanes[toPaneId] = {
          ...toPane,
          tabIds: targetIds,
          activeTabId: args.tabId,
        };

        const totalPanes = Object.keys(newPanes).length;
        if (
          srcTabIds.length === 0 &&
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

  async createSession(name, repoPath, isolated = false, kind = "regular") {
    set({ loading: true, error: null });
    try {
      // Snapshot the previously-active tab's index in the focused pane so
      // we can land the new tab right after it (browser-style). Captured
      // before `api.createSession` so the post-refresh reorder is anchored
      // to the user's view at hotkey-press time, not the post-reconcile
      // append position.
      const beforeSnap = (() => {
        const s = get();
        const ws = s.workspaces[repoPath];
        if (!ws) return null;
        const paneId = ws.focusedPaneId;
        const pane = ws.panes[paneId];
        if (!pane?.activeTabId) return null;
        const idx = pane.tabIds.indexOf(pane.activeTabId);
        return idx >= 0 ? { paneId, idx } : null;
      })();

      const created = await api.createSession(name, repoPath, isolated, kind);
      await get().refreshAll();

      // Reorder so the new tab sits immediately after the previously-active
      // tab in the same pane. `reconcileWorkspace` always appends new
      // sessions at the end of `focusedPaneId.tabIds`; this step
      // converts that to "next to active" without changing reconcile's
      // boot-time behavior.
      if (beforeSnap) {
        set((s) => {
          const ws = s.workspaces[repoPath];
          if (!ws) return s;
          const pane = ws.panes[beforeSnap.paneId];
          if (!pane) return s;
          const currentIdx = pane.tabIds.indexOf(created.id);
          if (currentIdx < 0) return s;
          const targetIdx = Math.min(
            beforeSnap.idx + 1,
            pane.tabIds.length - 1,
          );
          if (currentIdx === targetIdx) return s;
          const ids = pane.tabIds.filter((id) => id !== created.id);
          ids.splice(targetIdx, 0, created.id);
          const newPane = { ...pane, tabIds: ids };
          const newWs = {
            ...ws,
            panes: { ...ws.panes, [beforeSnap.paneId]: newPane },
          };
          const workspaces = { ...s.workspaces, [repoPath]: newWs };
          return {
            workspaces,
            ...(s.activeProject === repoPath
              ? mirrorActive(workspaces, repoPath)
              : {}),
          };
        });
      }

      // Focus the new session so Cmd+T (and any other entry point that goes
      // through the store) immediately surfaces it in its pane instead of
      // silently appending behind the existing active tab.
      get().selectSession(created.id);
      // Grab keyboard focus for the new session's xterm. rAF defers past the
      // portal reattach in `TerminalHost` so the slot is mounted in its pane
      // body by the time `Terminal` calls `term.focus()`.
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent("acorn:focus-session", {
              detail: { sessionId: created.id },
            }),
          );
        });
      }
      // First-run guidance for control sessions. Gated on a localStorage
      // flag so power users only see it once. App.tsx hosts the modal.
      if (
        kind === "control" &&
        typeof window !== "undefined" &&
        !window.localStorage.getItem(CONTROL_GUIDE_DISMISSED_KEY)
      ) {
        window.dispatchEvent(new CustomEvent("acorn:show-control-guide"));
      }
      return created;
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
      return null;
    }
  },

  async removeSession(id, removeWorktree = false) {
    try {
      // Track which project + pane held this session so we can collapse the
      // pane after reconcile if removing the tab leaves it empty. We only
      // collapse panes that *became* empty as a side effect of this close —
      // pre-existing empty panes (e.g. a split waiting for a drop target)
      // stay untouched.
      const before = get();
      let owning: { repoPath: string; paneId: PaneId } | null = null;
      for (const [repoPath, ws] of Object.entries(before.workspaces)) {
        for (const [pid, p] of Object.entries(ws.panes)) {
          if (p.tabIds.includes(id)) {
            owning = { repoPath, paneId: pid as PaneId };
            break;
          }
        }
        if (owning) break;
      }

      await api.removeSession(id, removeWorktree);
      await get().refreshAll();

      if (!owning) return;
      const after = get();
      const ws = after.workspaces[owning.repoPath];
      if (!ws) return;
      const pane = ws.panes[owning.paneId];
      if (!pane) return;
      if (pane.tabIds.length > 0) return;
      if (Object.keys(ws.panes).length <= 1) return;
      // Only auto-collapse for the currently active workspace's panes —
      // closePane operates on the active workspace, so applying it to a
      // background project would silently misfire.
      if (after.activeProject !== owning.repoPath) return;
      get().closePane(owning.paneId);
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

  async createNewProject(parentPath, name, ignoreSafeName = false) {
    try {
      const project = await api.createNewProject(
        parentPath,
        name,
        ignoreSafeName,
      );
      await get().refreshProjects();
      get().setActiveProject(project.repo_path);
      set({ error: null });
      return project;
    } catch (e) {
      set({ error: errorMessage(e) });
      throw e;
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

  async reorderSessions(repoPath, orderedIds) {
    const previous = get().sessions;
    const indexOf = new Map<string, number>();
    orderedIds.forEach((id, i) => indexOf.set(id, i));
    const optimistic = previous.map((s) => {
      if (s.repo_path !== repoPath) return s;
      const pos = indexOf.get(s.id);
      return pos === undefined ? s : { ...s, position: pos };
    });
    set({ sessions: optimistic });
    try {
      const updated = await api.reorderSessions(repoPath, orderedIds);
      set({ sessions: updated });
    } catch (e) {
      set({ sessions: previous, error: errorMessage(e) });
    }
  },

  requestRemoveProject(repoPath) {
    set({ pendingRemoveProject: repoPath });
  },

  clearPendingRemoveProject() {
    set({ pendingRemoveProject: null });
  },

  setRightTab(tab) {
    set((s) => ({
      rightTab: tab,
      rightTabByGroup: {
        ...s.rightTabByGroup,
        [groupOfTab(tab)]: tab,
      },
    }));
  },

  setRightGroup(group) {
    set((s) => {
      const remembered = s.rightTabByGroup[group] ?? defaultTabForGroup(group);
      if (s.rightTab === remembered) return s;
      return { rightTab: remembered };
    });
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

  setPendingTerminalInput(sessionId, command, options) {
    set((s) => ({
      pendingTerminalInput: {
        ...s.pendingTerminalInput,
        [sessionId]: {
          command,
          adoptWorktreeOnExit:
            options?.adoptWorktreeOnExit ??
            commandRequestsWorktreeAdoption(command),
        },
      },
    }));
  },

  consumePendingTerminalInput(sessionId) {
    // Read and clear inside one `set` so concurrent consumers cannot both
    // observe the same value before either of them clears it. Captures the
    // resolved value via closure rather than as the `set` return so the
    // function can still surface it to its caller.
    let consumed: PendingTerminalInput | null = null;
    set((s) => {
      const queued = s.pendingTerminalInput[sessionId];
      if (!queued) return s;
      consumed = queued;
      const { [sessionId]: _, ...rest } = s.pendingTerminalInput;
      return { pendingTerminalInput: rest };
    });
    return consumed;
  },

  toggleMultiInput() {
    let enabled = false;
    set((s) => {
      enabled = !s.multiInputEnabled;
      return { multiInputEnabled: enabled };
    });
    return enabled;
  },

  openCodeViewerTab(path) {
    set((s) => {
      if (!s.activeProject) return s;
      const ws = s.workspaces[s.activeProject];
      if (!ws) return s;
      // Reuse an existing code tab for the same path if there is one;
      // this avoids piling up identical tabs when the user double-clicks
      // the same file repeatedly. The reuse cycles focus to the tab.
      const existing = Object.values(s.workspaceTabs).find(
        (tab) =>
          tab.kind === "code" &&
          tab.path === path &&
          tab.repoPath === s.activeProject,
      );
      const tab = existing ?? makeCodeWorkspaceTab(path, s.activeProject);
      const focused = ws.focusedPaneId;
      const pane = ws.panes[focused];
      if (!pane) return s;
      const alreadyInPane = pane.tabIds.includes(tab.id);
      const newPane: PaneState = alreadyInPane
        ? { ...pane, activeTabId: tab.id }
        : {
            ...pane,
            tabIds: [...pane.tabIds, tab.id],
            activeTabId: tab.id,
          };
      const newWs: ProjectWorkspace = {
        ...ws,
        panes: { ...ws.panes, [focused]: newPane },
      };
      const newWorkspaces = {
        ...s.workspaces,
        [s.activeProject]: newWs,
      };
      return {
        workspaceTabs: existing
          ? s.workspaceTabs
          : { ...s.workspaceTabs, [tab.id]: tab },
        workspaces: newWorkspaces,
        ...mirrorActive(newWorkspaces, s.activeProject),
      };
    });
  },

  closeWorkspaceTab(id) {
    set((s) => {
      if (!isWorkspaceTabId(id)) return s;
      const { [id]: _, ...rest } = s.workspaceTabs;
      const newWorkspaces: Record<string, ProjectWorkspace> = {};
      for (const [key, ws] of Object.entries(s.workspaces)) {
        const newPanes: Record<PaneId, PaneState> = {};
        for (const [pid, pane] of Object.entries(ws.panes)) {
          const ids = pane.tabIds.filter((sid) => sid !== id);
          const nextActive =
            pane.activeTabId === id
              ? ids[ids.length - 1] ?? null
              : pane.activeTabId;
          newPanes[pid as PaneId] = {
            ...pane,
            tabIds: ids,
            activeTabId: nextActive,
          };
        }
        newWorkspaces[key] = { ...ws, panes: newPanes };
      }
      return {
        workspaceTabs: rest,
        workspaces: newWorkspaces,
        ...mirrorActive(newWorkspaces, s.activeProject),
      };
    });
  },

    }),
    {
      name: "acorn-workspaces",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      partialize: (state) => ({
        workspaces: state.workspaces,
        activeProject: state.activeProject,
        rightTab: state.rightTab,
        rightTabByGroup: state.rightTabByGroup,
        workspaceTabs: Object.fromEntries(
          Object.entries(state.workspaceTabs).filter(([, tab]) =>
            isRestorableWorkspaceTab(tab),
          ),
        ),
      }),
      migrate: (persisted, fromVersion) => {
        // v1 → v2: rightTabByGroup did not exist. Seed it from the persisted
        // rightTab so the group bar opens to whatever the user last looked at.
        // An invalid/unknown persisted rightTab leaves rightTabByGroup at the
        // defaults; the panel-level visibility guard then slides to the
        // nearest valid tab on first render.
        if (
          persisted &&
          typeof persisted === "object" &&
          fromVersion < 2
        ) {
          const p = persisted as { rightTab?: unknown };
          const seeded = defaultTabByGroup();
          if (isRightTab(p.rightTab)) {
            seeded[groupOfTab(p.rightTab)] = p.rightTab;
          }
          return { ...p, rightTabByGroup: seeded } as typeof persisted;
        }
        return persisted as typeof persisted;
      },
      // Recompute the active-workspace mirror after hydration so consumers
      // see the persisted layout immediately, before the first refreshAll.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Only restorable frontend-owned tabs survive rehydrate. Ephemeral
        // tabs, plus stale ids whose descriptors are gone, are stripped
        // before the layout mirror computes.
        const restoredTabs = Object.fromEntries(
          Object.entries(state.workspaceTabs ?? {}).filter(([, tab]) =>
            isRestorableWorkspaceTab(tab),
          ),
        );
        const sanitized: Record<string, ProjectWorkspace> = {};
        for (const [key, ws] of Object.entries(state.workspaces ?? {})) {
          const newPanes: Record<PaneId, PaneState> = {};
          for (const [pid, pane] of Object.entries(ws.panes ?? {})) {
            const normalized = normalizePaneState(
              pane as PersistedPaneState,
              pid as PaneId,
            );
            const ids = normalized.tabIds.filter(
              (id) => !isWorkspaceTabId(id) || restoredTabs[id],
            );
            const active =
              normalized.activeTabId &&
              (!isWorkspaceTabId(normalized.activeTabId) ||
                restoredTabs[normalized.activeTabId])
                ? normalized.activeTabId
                : ids[ids.length - 1] ?? null;
            newPanes[pid as PaneId] = {
              ...normalized,
              tabIds: ids,
              activeTabId: active,
            };
          }
          sanitized[key] = { ...ws, panes: newPanes };
        }
        state.workspaces = sanitized;
        state.workspaceTabs = restoredTabs;
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
