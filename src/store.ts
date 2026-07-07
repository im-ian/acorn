import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { api, type AiExecutionRequest, type WorktreeRemoval } from "./lib/api";
import type {
  Project,
  Session,
  SessionAgentProvider,
  SessionKind,
  SessionMode,
  SessionTitleGenerationStatus,
  SessionNotification,
  SessionProcessSummary,
} from "./lib/types";
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
  updateSplitSizesInLayout,
} from "./lib/layout";
import {
  activeSessionIdFromTabId,
  codeWorkspaceTabViewStateEqual,
  isRestorableWorkspaceTab,
  isWorkspaceTabId,
  makeCodeWorkspaceTab,
  makeCodeWorkspaceTabTarget,
  makeWorkSummaryWorkspaceTab,
  mergeCodeWorkspaceTabViewState,
  type FrontendWorkspaceTab,
  type CodeWorkspaceTabViewState,
} from "./lib/workspaceTabs";
import {
  defaultTabByGroup,
  defaultTabForGroup,
  groupOfTab,
  isRightTab,
  type RightGroup,
  type RightTab,
} from "./lib/rightPanelGroups";
import { useSettings } from "./lib/settings";
import {
  applySessionCreateRequest,
  buildSessionCreateRequest,
} from "./lib/sessionCreation";
import {
  otherSessionsUsingWorktreePath,
  sessionRemovalCascadeIds,
  sessionsUsingProjectWorktree,
  sessionsUsingWorktreePath,
} from "./lib/sessionWorktree";
import {
  DEFAULT_PROJECT_FOLDER_NAME,
  basenamePath,
  defaultProjectFolderId,
  ensureProjectFolders,
  isDefaultProjectFolder,
  isPathInsideOrEqual,
  makeProjectFolderId,
  pruneSessionFolderAssignments,
  resolveProjectFolderIdForSession,
  sortProjectFolders,
  type ProjectFolder,
  type ProjectFoldersByRepo,
  type SessionFolderAssignments,
} from "./lib/projectFolders";
import { canRegenerateSessionTitle } from "./lib/sessionTitle";
import { canConfigureSessionAutoClose } from "./lib/sessionAgentState";
import {
  summarizeTokenUsage,
  type WorkSummaryTokenBaseline,
} from "./lib/workSummary";

export type { RightGroup, RightTab };

const ROOT_PANE_ID: PaneId = "root";
const SESSION_TITLE_GENERATING_MIN_MS = 900;
const WORKTREE_IN_USE_BY_OTHER_SESSIONS =
  "Close other sessions using this worktree before removing it.";

let statusPollRunning = false;
let statusPollChain: Promise<void> | null = null;
let pendingStatusPollAll = false;
let pendingStatusPollIds = new Set<string>();
let activeStatusPollAll = false;
let activeStatusPollIds = new Set<string>();
let refreshSessionsSeq = 0;
let sessionPlacementSeq = 0;

function sessionProcessSummariesEqual(
  a: readonly SessionProcessSummary[],
  b: readonly SessionProcessSummary[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (process, index) =>
      process.pid === b[index]?.pid &&
      process.name === b[index]?.name &&
      process.depth === b[index]?.depth,
  );
}

interface SessionPlacementIntent {
  projectFolderId: string;
  paneId: PaneId;
  anchorTabId: string | null;
  sequence: number;
}

const sessionPlacementById = new Map<string, SessionPlacementIntent>();
const activeSessionPlacementIntents = new Set<SessionPlacementIntent>();

function coalescedSessionNotificationKey(
  notification: SessionNotification,
): string | null {
  if (notification.kind !== "waiting_for_input") return null;
  return `${notification.sessionId}:${notification.kind}`;
}

function normalizeSessionNotifications(
  notifications: SessionNotification[],
  maxHistory: number,
): SessionNotification[] {
  const seen = new Set<string>();
  const next: SessionNotification[] = [];
  for (const notification of notifications) {
    const key = coalescedSessionNotificationKey(notification);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    next.push(notification);
    if (next.length >= maxHistory) break;
  }
  return next;
}

async function loadWorkSummaryTokenBaseline(
  session: Session | null | undefined,
): Promise<WorkSummaryTokenBaseline | undefined> {
  if (!session) return undefined;
  try {
    if (session.mode === "chat") {
      const chatState = await api.loadChatSessionState(session.id);
      return {
        ...summarizeTokenUsage(chatState),
        capturedAt: new Date().toISOString(),
      };
    }
    if (!session.agent_transcript_id) return undefined;
    const transcript = await api.agentTranscriptSummary(
      session.repo_path,
      session.agent_transcript_id,
    );
    if (!transcript) return undefined;
    return {
      inputTokens: transcript.token_usage.input_tokens,
      outputTokens: transcript.token_usage.output_tokens,
      cacheReadTokens: transcript.token_usage.cache_read_tokens,
      cacheCreationTokens: transcript.token_usage.cache_creation_tokens,
      reasoningTokens: transcript.token_usage.reasoning_tokens,
      totalTokens: transcript.token_usage.total_tokens,
      messagesWithUsage: transcript.token_usage.messages_with_usage,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export interface PaneState {
  id: PaneId;
  tabIds: string[];
  activeTabId: string | null;
  /** Oldest -> newest activation order for tabs still known to this pane. */
  activationHistory?: string[];
}

export interface ProjectWorkspace {
  layout: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focusedPaneId: PaneId;
  viewMode?: WorkspaceViewMode;
  localViewMode?: WorkspaceViewMode;
  rightTab?: RightTab;
  rightTabByGroup?: Record<RightGroup, RightTab>;
}

export type WorkspaceViewMode = "panes" | "kanban";
type WorkspaceViewScope = "project" | "local";

export interface MoveTabArgs {
  tabId: string;
  fromPaneId: PaneId;
  toPaneId: PaneId;
  toIndex?: number;
  splitDirection?: Direction;
  splitSide?: SplitSide;
}

export interface WorkSummaryTabScope {
  sessionId?: string;
  repoPath?: string;
  cwdPath?: string;
  title?: string;
}

interface AppStateModel {
  sessions: Session[];
  projects: Project[];

  // Per-project workspace state. Internally, named workspaces still use
  // project-folder ids; the default workspace id is the repo path.
  workspaces: Record<string, ProjectWorkspace>;
  projectFolders: ProjectFoldersByRepo;
  sessionFolderIds: SessionFolderAssignments;
  activeProject: string | null;
  activeProjectFolderId: string | null;

  // Mirrors of the active project workspace for consumers.
  layout: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focusedPaneId: PaneId;
  activeTabId: string | null;
  activeSessionId: string | null;
  workspaceViewMode: WorkspaceViewMode;
  terminalPopupSessionId: string | null;
  consumeError: () => string | null;

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
  sessionNotifications: SessionNotification[];
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
  /** Session ids whose tab should be removed once the active agent finishes a turn. */
  autoCloseSessionIds: Record<string, true>;
  /** Session ids currently waiting for an AI-generated tab title. Ephemeral. */
  generatingSessionTitleIds: Record<string, true>;
  loadInitialStatus: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** Re-probe every session's live cwd in one batched backend call. */
  refreshLiveInWorktree: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshAll: () => Promise<void>;
  /** Probe session liveness via JSONL transcripts; updates session statuses
   *  in place without touching `updated_at`. When `ids` is provided, only
   *  the requested subset is sent to the backend. */
  pollSessionStatuses: (ids?: string[]) => Promise<void>;
  selectTab: (id: string | null) => void;
  selectSession: (id: string | null) => void;
  focusLocalSessions: () => void;
  setActiveProject: (repoPath: string) => void;
  setActiveProjectFolder: (folderId: string) => void;
  createProjectFolder: (
    repoPath: string,
    name?: string,
    cwdPath?: string,
  ) => ProjectFolder | null;
  renameProjectFolder: (folderId: string, name: string) => void;
  removeProjectFolder: (folderId: string) => void;
  moveSessionToProjectFolder: (
    sessionId: string,
    folderId: string | null,
  ) => void;
  setFocusedPane: (paneId: PaneId) => void;
  setWorkspaceViewMode: (mode: WorkspaceViewMode) => void;
  openTerminalPopup: (sessionId: string) => void;
  closeTerminalPopup: () => void;
  focusAdjacentPane: (direction: PaneFocusDirection) => void;
  setPaneSplitSizes: (splitId: string, sizes: readonly number[]) => void;
  splitFocusedPane: (direction: Direction) => void;
  closeFocusedTab: () => void;
  closePane: (paneId: PaneId) => void;
  moveTab: (args: MoveTabArgs) => void;
  createSession: (
    name: string,
    repoPath: string,
    isolated?: boolean,
    kind?: SessionKind,
    agentProvider?: SessionAgentProvider | null,
    projectScoped?: boolean,
    mode?: SessionMode,
    projectFolderId?: string,
    cwdPath?: string,
  ) => Promise<Session | null>;
  placeSessionInWorkspace: (
    sessionId: string,
    workspace: { workspaceId?: string | null; workspacePath?: string | null },
  ) => void;
  removeSession: (
    id: string,
    removeWorktree?: boolean,
  ) => Promise<WorktreeRemoval | null>;
  renameSession: (id: string, name: string) => Promise<void>;
  generateSessionTitle: (
    id: string,
    ai: AiExecutionRequest,
    prompt: string,
    force?: boolean,
  ) => Promise<SessionTitleGenerationStatus>;
  adoptSessionWorktree: (id: string, worktreePath: string) => Promise<void>;
  toggleSessionAutoClose: (id: string) => void;
  requestRemoveSession: (id: string) => void;
  clearPendingRemove: () => void;
  cycleTab: (direction: 1 | -1) => void;
  selectLatestNeedsInputSession: () => boolean;
  cycleProject: (direction: 1 | -1) => void;
  addProject: (title?: string) => Promise<void>;
  createNewProject: (
    parentPath: string,
    name: string,
    ignoreSafeName?: boolean,
  ) => Promise<Project>;
  removeProject: (
    repoPath: string,
    removeWorktrees?: boolean,
    removeSettings?: boolean,
  ) => Promise<WorktreeRemoval[]>;
  removeProjectWorktree: (
    repoPath: string,
    worktreePath: string,
    removeSessions?: boolean,
  ) => Promise<WorktreeRemoval | null>;
  reorderProjects: (orderedRepoPaths: string[]) => Promise<void>;
  reorderProjectFolders: (
    repoPath: string,
    orderedFolderIds: string[],
  ) => void;
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
  addSessionNotification: (notification: SessionNotification) => void;
  markSessionNotificationRead: (id: string) => void;
  markSessionNotificationsReadForSession: (sessionId: string) => void;
  markAllSessionNotificationsRead: () => void;
  dismissSessionNotification: (id: string) => void;
  clearReadSessionNotifications: () => void;
  toggleMultiInput: () => boolean;
  /** Open a readonly code viewer tab for `path` in the focused pane. */
  openCodeViewerTab: (
    path: string,
    repoPath?: string,
    target?: { line?: number; column?: number },
  ) => void;
  /** Persist transient scroll/zoom state for an open code/media viewer tab. */
  updateCodeViewerTabViewState: (
    id: string,
    patch: CodeWorkspaceTabViewState,
  ) => void;
  /** Open a work summary tab for the current session or a provided worktree. */
  openWorkSummaryTab: (scope?: WorkSummaryTabScope) => Promise<void>;
  /** Close any frontend-owned tab and remove it from panes. */
  closeWorkspaceTab: (id: string) => void;
}

export interface PendingTerminalInput {
  command: string;
  adoptWorktreeOnExit: boolean;
  agentProvider?: SessionAgentProvider;
}

export interface PendingTerminalInputOptions {
  adoptWorktreeOnExit?: boolean;
  agentProvider?: SessionAgentProvider;
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
  return { id, tabIds: [], activeTabId: null, activationHistory: [] };
}

type PersistedPaneState = Partial<PaneState> & {
  sessionIds?: string[];
  activeSessionId?: string | null;
  lastActiveSessionTabId?: string | null;
};

function pushActivation(
  history: readonly string[] | undefined,
  tabId: string | null,
): string[] {
  const existing = Array.isArray(history) ? history : [];
  if (!tabId) return [...existing];
  return [...existing.filter((id) => id !== tabId), tabId];
}

function activationHistoryFor(
  pane: PersistedPaneState | undefined,
  tabIds: readonly string[],
  activeTabId: string | null,
): string[] {
  const allowed = new Set(tabIds);
  const candidates = [
    ...(Array.isArray(pane?.activationHistory) ? pane.activationHistory : []),
    ...(typeof pane?.lastActiveSessionTabId === "string"
      ? [pane.lastActiveSessionTabId]
      : []),
    ...(activeTabId ? [activeTabId] : []),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function preferredTabId(
  pane: Pick<PaneState, "activationHistory">,
  ids: readonly string[],
): string | null {
  const allowed = new Set(ids);
  const history = pane.activationHistory ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const id = history[i];
    if (allowed.has(id)) return id;
  }
  return ids[ids.length - 1] ?? null;
}

function activatePaneTab(pane: PaneState, tabId: string | null): PaneState {
  return {
    ...pane,
    activeTabId: tabId,
    activationHistory: pushActivation(pane.activationHistory, tabId),
  };
}

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
  const safeActiveTabId =
    activeTabId && tabIds.includes(activeTabId) ? activeTabId : null;
  return {
    id,
    tabIds,
    activeTabId: safeActiveTabId,
    activationHistory: activationHistoryFor(pane, tabIds, safeActiveTabId),
  };
}

function emptyWorkspace(
  viewMode: WorkspaceViewMode = defaultWorkspaceViewMode(),
): ProjectWorkspace {
  return {
    layout: makePaneNode(ROOT_PANE_ID),
    panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) },
    focusedPaneId: ROOT_PANE_ID,
    viewMode,
    rightTab: "commits",
    rightTabByGroup: defaultTabByGroup(),
  };
}

type PersistedWorkspaceState = Partial<ProjectWorkspace> & {
  localViewMode?: unknown;
  rightTab?: unknown;
  rightTabByGroup?: Partial<Record<RightGroup, unknown>>;
};

function normalizeRightPanelState(
  rightTab: unknown,
  rightTabByGroup: Partial<Record<RightGroup, unknown>> | undefined,
): Pick<ProjectWorkspace, "rightTab" | "rightTabByGroup"> {
  const byGroup = defaultTabByGroup();
  for (const group of Object.keys(byGroup) as RightGroup[]) {
    const remembered = rightTabByGroup?.[group];
    if (isRightTab(remembered) && groupOfTab(remembered) === group) {
      byGroup[group] = remembered;
    }
  }
  const active = isRightTab(rightTab) ? rightTab : "commits";
  return {
    rightTab: active,
    rightTabByGroup: byGroup,
  };
}

function defaultWorkspaceViewMode(): WorkspaceViewMode {
  return useSettings.getState().settings.interface.defaultWorkspaceViewMode;
}

function readWorkspaceViewMode(value: unknown): WorkspaceViewMode | null {
  return value === "kanban" || value === "panes" ? value : null;
}

function normalizeWorkspaceViewMode(
  value: unknown,
  fallback: WorkspaceViewMode = defaultWorkspaceViewMode(),
): WorkspaceViewMode {
  return readWorkspaceViewMode(value) ?? fallback;
}

function scopedWorkspaceViewMode(
  ws: ProjectWorkspace,
  scope: WorkspaceViewScope,
): WorkspaceViewMode {
  const projectMode = normalizeWorkspaceViewMode(ws.viewMode);
  if (scope === "local") {
    return readWorkspaceViewMode(ws.localViewMode) ?? projectMode;
  }
  return projectMode;
}

let indexedSessions: Session[] | null = null;
let indexedSessionsById: ReadonlyMap<string, Session> = new Map();

export function selectSessionsById(state: {
  sessions: Session[];
}): ReadonlyMap<string, Session> {
  if (state.sessions !== indexedSessions) {
    indexedSessions = state.sessions;
    indexedSessionsById = new Map(
      state.sessions.map((session) => [session.id, session]),
    );
  }
  return indexedSessionsById;
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
    workspaceViewMode: defaultWorkspaceViewMode(),
  };
}

type WorkspaceViewContext = Pick<
  AppStateModel,
  "sessions" | "projects" | "projectFolders" | "activeProject"
>;

function workspaceViewScopeForActiveWorkspace(
  workspaces: Record<string, ProjectWorkspace>,
  activeWorkspaceId: string | null,
  context?: WorkspaceViewContext,
): WorkspaceViewScope {
  if (!context) return "project";
  const ws = activeWorkspaceId ? workspaces[activeWorkspaceId] : null;
  const activeTabId = ws?.panes[ws.focusedPaneId]?.activeTabId ?? null;
  const activeSessionId = activeSessionIdFromTabId(activeTabId);
  const activeSession = activeSessionId
    ? context.sessions.find((session) => session.id === activeSessionId)
    : null;
  if (activeSession?.project_scoped === false) return "local";

  const repoPath = activeWorkspaceId
    ? (repoPathForProjectFolderId(context, activeWorkspaceId) ??
      context.activeProject)
    : context.activeProject;
  if (!repoPath) return "project";

  const hasProjectIdentity =
    context.projects.some((project) => project.repo_path === repoPath) ||
    context.sessions.some(
      (session) =>
        session.repo_path === repoPath && session.project_scoped !== false,
    );
  return hasProjectIdentity ? "project" : "local";
}

function mirrorActive(
  workspaces: Record<string, ProjectWorkspace>,
  activeWorkspaceId: string | null,
  context?: WorkspaceViewContext,
) {
  if (!activeWorkspaceId) return fallbackEmptyMirror();
  const ws = workspaces[activeWorkspaceId];
  if (!ws) return fallbackEmptyMirror();
  const activeTabId = ws.panes[ws.focusedPaneId]?.activeTabId ?? null;
  const rightPanel = normalizeRightPanelState(ws.rightTab, ws.rightTabByGroup);
  const viewScope = workspaceViewScopeForActiveWorkspace(
    workspaces,
    activeWorkspaceId,
    context,
  );
  return {
    layout: ws.layout,
    panes: ws.panes,
    focusedPaneId: ws.focusedPaneId,
    activeTabId,
    activeSessionId: activeSessionIdFromTabId(activeTabId),
    workspaceViewMode: scopedWorkspaceViewMode(ws, viewScope),
    ...rightPanel,
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
        : preferredTabId(existing, filtered);
    newPanes[pid] = {
      id: pid,
      tabIds: filtered,
      activeTabId: active,
      activationHistory: activationHistoryFor(existing, filtered, active),
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
        activationHistory:
          pane.activeTabId === null
            ? pushActivation(pane.activationHistory, s.id)
            : activationHistoryFor(
                pane,
                [...pane.tabIds, s.id],
                pane.activeTabId,
              ),
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
    ...ws,
    layout: newLayout,
    panes: newPanes,
    focusedPaneId: newFocused,
  };
}

function reconcileWorkspaces(
  sessions: Session[],
  projects: Project[],
  projectFolders: ProjectFoldersByRepo,
  sessionFolderIds: SessionFolderAssignments,
  workspaces: Record<string, ProjectWorkspace>,
  activeProject: string | null,
  activeProjectFolderId: string | null,
  allowEmptyWipe = true,
): {
  workspaces: Record<string, ProjectWorkspace>;
  projectFolders: ProjectFoldersByRepo;
  sessionFolderIds: SessionFolderAssignments;
  activeProject: string | null;
  activeProjectFolderId: string | null;
} {
  const nextProjectFolders = ensureProjectFolders(
    projects,
    sessions,
    projectFolders,
  );
  const nextSessionFolderIds = pruneSessionFolderAssignments(
    sessionFolderIds,
    sessions,
    nextProjectFolders,
  );
  const byFolder: Record<string, Session[]> = {};
  const folderById = new Map<string, ProjectFolder>();
  for (const folders of Object.values(nextProjectFolders)) {
    for (const folder of folders) {
      folderById.set(folder.id, folder);
      byFolder[folder.id] = [];
    }
  }
  for (const session of sessions) {
    if (session.project_scoped === false) {
      const folders = nextProjectFolders[session.repo_path] ?? [];
      const folderId =
        folders.length > 0
          ? resolveProjectFolderIdForSession(
              folders,
              session,
              nextSessionFolderIds,
            )
          : session.repo_path;
      if (!byFolder[folderId]) byFolder[folderId] = [];
      byFolder[folderId].push(session);
      continue;
    }
    const folders = nextProjectFolders[session.repo_path] ?? [];
    if (folders.length === 0) continue;
    const folderId = resolveProjectFolderIdForSession(
      folders,
      session,
      nextSessionFolderIds,
    );
    if (!byFolder[folderId]) byFolder[folderId] = [];
    byFolder[folderId].push(session);
  }

  const newWorkspaces: Record<string, ProjectWorkspace> = {};
  for (const [folderId, folderSessions] of Object.entries(byFolder)) {
    const existing = workspaces[folderId] ?? emptyWorkspace();
    newWorkspaces[folderId] = reconcileWorkspace(
      existing,
      folderSessions,
      allowEmptyWipe,
    );
  }

  let newActive = activeProject;
  const knownRepos = new Set(Object.keys(nextProjectFolders));
  for (const session of sessions) {
    if (session.project_scoped === false) knownRepos.add(session.repo_path);
  }
  if (newActive && !knownRepos.has(newActive)) newActive = null;
  if (!newActive) {
    const projectSessions = sessions.filter(
      (session) => session.project_scoped !== false,
    );
    const localSessions = sessions.filter(
      (session) => session.project_scoped === false,
    );
    const withSession = projects.find((p) =>
      projectSessions.some((session) => session.repo_path === p.repo_path),
    );
    newActive =
      withSession?.repo_path ??
      projects[0]?.repo_path ??
      projectSessions[0]?.repo_path ??
      localSessions[0]?.repo_path ??
      null;
  }

  let newActiveFolderId = activeProjectFolderId;
  const activeFolder = newActiveFolderId
    ? folderById.get(newActiveFolderId)
    : undefined;
  if (!newActive || !activeFolder || activeFolder.repoPath !== newActive) {
    newActiveFolderId = newActive ? defaultProjectFolderId(newActive) : null;
  }
  if (newActiveFolderId && !newWorkspaces[newActiveFolderId]) {
    newActiveFolderId = newActive ? defaultProjectFolderId(newActive) : null;
  }
  const syncedWorkspaces = syncProjectWorkspaceViewModes(
    newWorkspaces,
    nextProjectFolders,
    newActive,
    newActiveFolderId,
  );

  return {
    workspaces: syncedWorkspaces,
    projectFolders: nextProjectFolders,
    sessionFolderIds: nextSessionFolderIds,
    activeProject: newActive,
    activeProjectFolderId: newActiveFolderId,
  };
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

function findTabOwner(
  state: AppStateModel,
  id: string,
): { projectFolderId: string; repoPath: string | null; paneId: PaneId } | null {
  for (const [projectFolderId, ws] of Object.entries(state.workspaces)) {
    const paneId = findPaneContainingTab(ws.panes, id);
    if (paneId) {
      return {
        projectFolderId,
        repoPath: repoPathForProjectFolderId(state, projectFolderId),
        paneId,
      };
    }
  }
  return null;
}

function activeWorkspaceId(
  s: Pick<AppStateModel, "activeProject" | "activeProjectFolderId">,
): string | null {
  return s.activeProjectFolderId ?? s.activeProject;
}

function projectWorkspaceIds(
  projectFolders: ProjectFoldersByRepo,
  repoPath: string,
): string[] {
  const ids = new Set<string>([defaultProjectFolderId(repoPath)]);
  for (const folder of projectFolders[repoPath] ?? []) {
    ids.add(folder.id);
  }
  return [...ids];
}

function workspaceViewModeForProject(
  workspaces: Record<string, ProjectWorkspace>,
  projectFolders: ProjectFoldersByRepo,
  repoPath: string,
  preferredWorkspaceId: string | null = null,
): WorkspaceViewMode {
  const ids = projectWorkspaceIds(projectFolders, repoPath);
  const candidates = [
    preferredWorkspaceId && ids.includes(preferredWorkspaceId)
      ? preferredWorkspaceId
      : null,
    defaultProjectFolderId(repoPath),
    ...ids,
  ];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ws = workspaces[id];
    const mode = readWorkspaceViewMode(ws?.viewMode);
    if (mode) return mode;
  }
  return defaultWorkspaceViewMode();
}

function syncProjectWorkspaceViewModes(
  workspaces: Record<string, ProjectWorkspace>,
  projectFolders: ProjectFoldersByRepo,
  preferredRepoPath: string | null = null,
  preferredWorkspaceId: string | null = null,
): Record<string, ProjectWorkspace> {
  let next = workspaces;
  for (const repoPath of Object.keys(projectFolders)) {
    const mode = workspaceViewModeForProject(
      workspaces,
      projectFolders,
      repoPath,
      preferredRepoPath === repoPath ? preferredWorkspaceId : null,
    );
    for (const workspaceId of projectWorkspaceIds(projectFolders, repoPath)) {
      const ws = next[workspaceId];
      if (!ws || readWorkspaceViewMode(ws.viewMode) === mode) continue;
      if (next === workspaces) next = { ...workspaces };
      next[workspaceId] = { ...ws, viewMode: mode };
    }
  }
  return next;
}

function setProjectWorkspaceViewMode(
  workspaces: Record<string, ProjectWorkspace>,
  projectFolders: ProjectFoldersByRepo,
  repoPath: string,
  mode: WorkspaceViewMode,
): Record<string, ProjectWorkspace> {
  let next = workspaces;
  for (const workspaceId of projectWorkspaceIds(projectFolders, repoPath)) {
    const ws = next[workspaceId];
    if (!ws || readWorkspaceViewMode(ws.viewMode) === mode) continue;
    if (next === workspaces) next = { ...workspaces };
    next[workspaceId] = { ...ws, viewMode: mode };
  }
  return next;
}

function setLocalWorkspaceViewMode(
  workspaces: Record<string, ProjectWorkspace>,
  projectFolders: ProjectFoldersByRepo,
  repoPath: string,
  mode: WorkspaceViewMode,
): Record<string, ProjectWorkspace> {
  let next = workspaces;
  for (const workspaceId of projectWorkspaceIds(projectFolders, repoPath)) {
    const ws = next[workspaceId];
    if (!ws || readWorkspaceViewMode(ws.localViewMode) === mode) continue;
    if (next === workspaces) next = { ...workspaces };
    next[workspaceId] = { ...ws, localViewMode: mode };
  }
  return next;
}

function repoPathForProjectFolderId(
  state: Pick<AppStateModel, "projectFolders">,
  folderId: string,
): string | null {
  for (const folders of Object.values(state.projectFolders ?? {})) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (folder) return folder.repoPath;
  }
  return folderId.startsWith("project-folder:") ? null : folderId;
}

function findProjectFolder(
  state: Pick<AppStateModel, "projectFolders">,
  folderId: string,
): ProjectFolder | null {
  for (const folders of Object.values(state.projectFolders ?? {})) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (folder) return folder;
  }
  return null;
}

function latestNeedsInputSessionId(
  state: Pick<AppStateModel, "sessions" | "sessionNotifications">,
): string | null {
  const sessionsById = new Map(
    state.sessions.map((session) => [session.id, session]),
  );
  for (const notification of state.sessionNotifications) {
    if (notification.kind !== "waiting_for_input") continue;
    const session = sessionsById.get(notification.sessionId);
    if (session?.status === "waiting_for_input") return session.id;
  }
  for (let index = state.sessions.length - 1; index >= 0; index -= 1) {
    const session = state.sessions[index];
    if (session.status === "waiting_for_input") return session.id;
  }
  return null;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function sameWorkspacePath(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

function isWorktreeProjectFolder(folder: ProjectFolder): boolean {
  return !sameWorkspacePath(folder.cwdPath, folder.repoPath);
}

function sessionMatchesProjectFolderCwd(
  session: Session,
  folder: ProjectFolder,
): boolean {
  return sameWorkspacePath(session.worktree_path, folder.cwdPath);
}

function keepTrueRecordIds(
  record: Record<string, true>,
  ids: ReadonlySet<string>,
): Record<string, true> {
  return Object.fromEntries(
    Object.entries(record).filter(([id]) => ids.has(id)),
  ) as Record<string, true>;
}

function canAssignSessionToProjectFolder(
  state: Pick<AppStateModel, "projectFolders" | "sessionFolderIds">,
  session: Session,
  folderId: string | null,
): boolean {
  const folders = state.projectFolders[session.repo_path] ?? [];
  const targetFolderId = folderId ?? defaultProjectFolderId(session.repo_path);
  const currentFolderId = resolveProjectFolderIdForSession(
    folders,
    session,
    state.sessionFolderIds,
  );
  const currentFolder = folders.find(
    (folder) => folder.id === currentFolderId,
  );
  const targetFolder = folders.find((folder) => folder.id === targetFolderId);
  if (!targetFolder) return false;
  if (
    currentFolder &&
    isWorktreeProjectFolder(currentFolder) &&
    currentFolder.id !== targetFolder.id
  ) {
    return false;
  }
  if (
    isWorktreeProjectFolder(targetFolder) &&
    !sessionMatchesProjectFolderCwd(session, targetFolder)
  ) {
    return false;
  }
  return true;
}

function resolvePlacementProjectFolderId(
  state: AppStateModel,
  selectedPath: string,
  requestedFolderId?: string,
): string | null {
  if (requestedFolderId && findProjectFolder(state, requestedFolderId)) {
    return requestedFolderId;
  }
  const activeId = activeWorkspaceId(state);
  const activeFolder = activeId ? findProjectFolder(state, activeId) : null;
  if (activeFolder && isPathInsideOrEqual(selectedPath, activeFolder.repoPath)) {
    return activeFolder.id;
  }
  if (state.workspaces[selectedPath]) return selectedPath;
  const defaultId = defaultProjectFolderId(selectedPath);
  return state.workspaces[defaultId] ? defaultId : null;
}

function resolveWorkspaceFolderForHint(
  state: AppStateModel,
  session: Session,
  workspace: { workspaceId?: string | null; workspacePath?: string | null },
): ProjectFolder | null {
  const workspaceId = workspace.workspaceId?.trim();
  if (workspaceId) {
    const folder = findProjectFolder(state, workspaceId);
    if (folder?.repoPath === session.repo_path) return folder;
  }

  const workspacePath = workspace.workspacePath?.trim();
  if (!workspacePath) return null;
  const folders = state.projectFolders[session.repo_path] ?? [];
  const matches = folders.filter((folder) =>
    sameWorkspacePath(folder.cwdPath, workspacePath),
  );
  if (matches.length === 0) return null;
  const defaultFolder = matches.find(isDefaultProjectFolder);
  if (sameWorkspacePath(workspacePath, session.repo_path)) {
    return defaultFolder ?? matches[0] ?? null;
  }
  return matches.find((folder) => !isDefaultProjectFolder(folder)) ?? matches[0] ?? null;
}

function applySessionWorkspaceHint(
  state: AppStateModel,
  sessionId: string,
  workspace: { workspaceId?: string | null; workspacePath?: string | null },
): AppStateModel | Partial<AppStateModel> {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return state;
  const folder = resolveWorkspaceFolderForHint(state, session, workspace);
  if (!folder) return state;
  const targetFolderId =
    folder.id === defaultProjectFolderId(session.repo_path) ? null : folder.id;
  if (!canAssignSessionToProjectFolder(state, session, targetFolderId)) {
    return state;
  }
  const sessionFolderIds = { ...state.sessionFolderIds };
  if (targetFolderId === null) {
    delete sessionFolderIds[session.id];
  } else {
    sessionFolderIds[session.id] = targetFolderId;
  }
  if (
    (state.sessionFolderIds[session.id] ?? null) ===
    (sessionFolderIds[session.id] ?? null)
  ) {
    return state;
  }
  const reconciled = reconcileWorkspaces(
    state.sessions,
    state.projects,
    state.projectFolders,
    sessionFolderIds,
    state.workspaces,
    state.activeProject,
    state.activeProjectFolderId,
    true,
  );
  return {
    projectFolders: reconciled.projectFolders,
    workspaces: reconciled.workspaces,
    sessionFolderIds: reconciled.sessionFolderIds,
    activeProject: reconciled.activeProject,
    activeProjectFolderId: reconciled.activeProjectFolderId,
    ...mirrorActive(reconciled.workspaces, reconciled.activeProjectFolderId, {
      sessions: state.sessions,
      projects: state.projects,
      projectFolders: reconciled.projectFolders,
      activeProject: reconciled.activeProject,
    }),
  };
}

function updateActiveWorkspace(
  s: AppStateModel,
  updater: (ws: ProjectWorkspace) => ProjectWorkspace,
): Partial<AppStateModel> | null {
  const workspaceId = activeWorkspaceId(s);
  if (!workspaceId) return null;
  const ws = s.workspaces[workspaceId];
  if (!ws) return null;
  const next = updater(ws);
  if (next === ws) return null;
  const workspaces = { ...s.workspaces, [workspaceId]: next };
  return {
    workspaces,
    ...mirrorActive(workspaces, workspaceId, s),
  };
}

function captureSessionPlacementIntent(
  s: AppStateModel,
  projectFolderId: string | null,
): SessionPlacementIntent | null {
  if (!projectFolderId) return null;
  const ws = s.workspaces[projectFolderId];
  if (!ws) return null;
  const pane = ws.panes[ws.focusedPaneId];
  if (!pane) return null;
  return {
    projectFolderId,
    paneId: ws.focusedPaneId,
    anchorTabId: pane.activeTabId,
    sequence: ++sessionPlacementSeq,
  };
}

function samePlacementGroup(
  a: SessionPlacementIntent,
  b: SessionPlacementIntent,
): boolean {
  return (
    a.projectFolderId === b.projectFolderId &&
    a.paneId === b.paneId &&
    a.anchorTabId === b.anchorTabId
  );
}

function pruneSessionPlacementGroup(
  placement: SessionPlacementIntent,
  sessions: Session[],
): void {
  for (const active of activeSessionPlacementIntents) {
    if (samePlacementGroup(active, placement)) return;
  }
  const visibleSessionIds = new Set(sessions.map((session) => session.id));
  // Keep sibling placement records until every created tab in the group has
  // appeared in a session refresh; later siblings need earlier sequences.
  for (const [sessionId, existing] of sessionPlacementById) {
    if (
      samePlacementGroup(existing, placement) &&
      !visibleSessionIds.has(sessionId)
    ) {
      return;
    }
  }
  for (const [sessionId, existing] of sessionPlacementById) {
    if (samePlacementGroup(existing, placement)) {
      sessionPlacementById.delete(sessionId);
    }
  }
}

function insertionIndexForPlacement(
  tabIds: string[],
  placement: SessionPlacementIntent,
): number {
  if (!placement.anchorTabId) {
    const firstLaterSibling = tabIds.findIndex((id) => {
      const other = sessionPlacementById.get(id);
      return (
        other !== undefined &&
        samePlacementGroup(other, placement) &&
        other.sequence > placement.sequence
      );
    });
    return firstLaterSibling >= 0 ? firstLaterSibling : tabIds.length;
  }

  const anchorIndex = tabIds.indexOf(placement.anchorTabId);
  if (anchorIndex < 0) return tabIds.length;

  let index = anchorIndex + 1;
  while (index < tabIds.length) {
    const other = sessionPlacementById.get(tabIds[index]);
    if (
      !other ||
      !samePlacementGroup(other, placement) ||
      other.sequence > placement.sequence
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

function applySessionPlacementIntent(
  s: AppStateModel,
  sessionId: string,
  placement: SessionPlacementIntent | null,
): AppStateModel | Partial<AppStateModel> {
  if (!placement) return s;
  const session = s.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return s;
  const targetFolderId =
    placement.projectFolderId === defaultProjectFolderId(session.repo_path)
      ? null
      : placement.projectFolderId;
  if (
    repoPathForProjectFolderId(s, placement.projectFolderId) !==
      session.repo_path ||
    !canAssignSessionToProjectFolder(s, session, targetFolderId)
  ) {
    return s;
  }

  const ws = s.workspaces[placement.projectFolderId];
  const targetPane = ws?.panes[placement.paneId];
  if (!ws || !targetPane) return s;

  let changed = false;
  const newPanes: Record<PaneId, PaneState> = {};
  for (const [pid, pane] of Object.entries(ws.panes)) {
    if (!pane.tabIds.includes(sessionId)) {
      newPanes[pid as PaneId] = pane;
      continue;
    }
    changed = true;
    const tabIds = pane.tabIds.filter((id) => id !== sessionId);
    newPanes[pid as PaneId] = {
      ...pane,
      tabIds,
      activeTabId:
        pane.activeTabId === sessionId
          ? tabIds[tabIds.length - 1] ?? null
          : pane.activeTabId,
    };
  }

  const targetAfterRemoval = newPanes[placement.paneId] ?? targetPane;
  const targetIds = [...targetAfterRemoval.tabIds];
  const insertAt = insertionIndexForPlacement(targetIds, placement);
  targetIds.splice(insertAt, 0, sessionId);
  changed =
    changed ||
    targetAfterRemoval.tabIds.length !== targetIds.length ||
    targetAfterRemoval.tabIds.some((id, index) => id !== targetIds[index]);

  if (!changed) return s;

  const newWs: ProjectWorkspace = {
    ...ws,
    panes: {
      ...newPanes,
      [placement.paneId]: {
        ...targetAfterRemoval,
        tabIds: targetIds,
      },
    },
  };
  const workspaces = { ...s.workspaces, [placement.projectFolderId]: newWs };
  return {
    workspaces,
    ...(activeWorkspaceId(s) === placement.projectFolderId
      ? mirrorActive(workspaces, placement.projectFolderId, s)
      : {}),
  };
}

function applyKnownSessionPlacementIntents(s: AppStateModel): AppStateModel {
  let next = s;
  const pruneAfterApply: SessionPlacementIntent[] = [];
  for (const [sessionId, placement] of Array.from(sessionPlacementById)) {
    const patch = applySessionPlacementIntent(next, sessionId, placement);
    if (patch !== next) {
      next = { ...next, ...patch };
    }
    if (next.sessions.some((session) => session.id === sessionId)) {
      pruneAfterApply.push(placement);
    }
  }
  for (const placement of pruneAfterApply) {
    pruneSessionPlacementGroup(placement, next.sessions);
  }
  return next;
}

// When a project is first registered it starts with no terminal sessions, so
// the workspace opens on the empty-state prompt. Spawn one regular session so a
// freshly added project is immediately usable. Guarded on the project still
// having zero sessions so re-adding a known repo never piles on duplicates.
async function createInitialProjectSession(
  get: () => AppStateModel,
  repoPath: string,
): Promise<void> {
  const { sessions, projects } = get();
  const alreadyHasSession = sessions.some(
    (session) => session.repo_path === repoPath,
  );
  if (alreadyHasSession) return;
  const request = buildSessionCreateRequest(
    { sessions, projects },
    { repoPath },
  );
  await applySessionCreateRequest(get().createSession, request);
}

export const useAppStore = create<AppStateModel>()(
  persist(
    (set, get) => ({
  sessions: [],
  projects: [],

  workspaces: {},
  projectFolders: {},
  sessionFolderIds: {},
  activeProject: null,
  activeProjectFolderId: null,

  layout: makePaneNode(ROOT_PANE_ID),
  panes: { [ROOT_PANE_ID]: emptyPane(ROOT_PANE_ID) },
  focusedPaneId: ROOT_PANE_ID,
  activeTabId: null,
  activeSessionId: null,
  workspaceViewMode: defaultWorkspaceViewMode(),
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
  consumeError() {
    const error = get().error;
    if (error) set({ error: null });
    return error;
  },
  pendingRemoveId: null,
  pendingRemoveProject: null,
  sessionsLoadedCleanly: true,
  liveInWorktree: {},
  autoCloseSessionIds: {},
  generatingSessionTitleIds: {},

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
    const seq = ++refreshSessionsSeq;
    set({ loading: true, error: null });
    try {
      const sessions = await api.listSessions();
      if (seq !== refreshSessionsSeq) return;
      set((s) => {
        const allowEmptyWipe = s.sessionsLoadedCleanly;
        const reconciled = reconcileWorkspaces(
          sessions,
          s.projects,
          s.projectFolders,
          s.sessionFolderIds,
          s.workspaces,
          s.activeProject,
          s.activeProjectFolderId,
          allowEmptyWipe,
        );
        // Once the backend returns any sessions we trust subsequent empty
        // results to be intentional (user removed them all). Drop the guard.
        const nextSessionsLoadedCleanly =
          s.sessionsLoadedCleanly || sessions.length > 0;
        const sessionIds = new Set(sessions.map((session) => session.id));
        const shouldPruneActivity =
          s.sessionsLoadedCleanly || sessions.length > 0;
        const nextState: AppStateModel = {
          ...s,
          sessions,
          loading: false,
          error: null,
          sessionsLoadedCleanly: nextSessionsLoadedCleanly,
          sessionNotifications: shouldPruneActivity
            ? s.sessionNotifications.filter((notification) =>
                sessionIds.has(notification.sessionId),
              )
            : s.sessionNotifications,
          autoCloseSessionIds: shouldPruneActivity
            ? keepTrueRecordIds(s.autoCloseSessionIds, sessionIds)
            : s.autoCloseSessionIds,
          workspaces: reconciled.workspaces,
          projectFolders: reconciled.projectFolders,
          sessionFolderIds: reconciled.sessionFolderIds,
          activeProject: reconciled.activeProject,
          activeProjectFolderId: reconciled.activeProjectFolderId,
          ...mirrorActive(
            reconciled.workspaces,
            reconciled.activeProjectFolderId,
            {
              sessions,
              projects: s.projects,
              projectFolders: reconciled.projectFolders,
              activeProject: reconciled.activeProject,
            },
          ),
        };
        return applyKnownSessionPlacementIntents(nextState);
      });
      void get().refreshLiveInWorktree();
    } catch (e) {
      if (seq !== refreshSessionsSeq) return;
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
          s.projectFolders,
          s.sessionFolderIds,
          s.workspaces,
          s.activeProject,
          s.activeProjectFolderId,
          allowEmptyWipe,
        );
        return {
          projects,
          workspaces: reconciled.workspaces,
          projectFolders: reconciled.projectFolders,
          sessionFolderIds: reconciled.sessionFolderIds,
          activeProject: reconciled.activeProject,
          activeProjectFolderId: reconciled.activeProjectFolderId,
          ...mirrorActive(
            reconciled.workspaces,
            reconciled.activeProjectFolderId,
            {
              sessions: s.sessions,
              projects,
              projectFolders: reconciled.projectFolders,
              activeProject: reconciled.activeProject,
            },
          ),
        };
      });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async refreshAll() {
    const seq = ++refreshSessionsSeq;
    set({ loading: true, error: null });
    const [sessionsResult, projectsResult] = await Promise.allSettled([
      api.listSessions(),
      api.listProjects(),
    ]);
    if (seq !== refreshSessionsSeq) return;
    if (
      sessionsResult.status === "rejected" &&
      projectsResult.status === "rejected"
    ) {
      set({
        loading: false,
        error: errorMessage(sessionsResult.reason),
      });
      return;
    }
    set((s) => {
      const receivedSessions = sessionsResult.status === "fulfilled";
      const refreshError =
        sessionsResult.status === "rejected"
          ? errorMessage(sessionsResult.reason)
          : projectsResult.status === "rejected"
            ? errorMessage(projectsResult.reason)
            : null;
      const sessions =
        receivedSessions ? sessionsResult.value : s.sessions;
      const projects =
        projectsResult.status === "fulfilled"
          ? projectsResult.value
          : s.projects;
      const allowEmptyWipe =
        receivedSessions ? s.sessionsLoadedCleanly : false;
      const reconciled = reconcileWorkspaces(
        sessions,
        projects,
        s.projectFolders,
        s.sessionFolderIds,
        s.workspaces,
        s.activeProject,
        s.activeProjectFolderId,
        allowEmptyWipe,
      );
      const nextSessionsLoadedCleanly = receivedSessions
        ? s.sessionsLoadedCleanly || sessions.length > 0
        : s.sessionsLoadedCleanly;
      const sessionIds = new Set(sessions.map((session) => session.id));
      const shouldPruneActivity =
        receivedSessions && (s.sessionsLoadedCleanly || sessions.length > 0);
      const nextState: AppStateModel = {
        ...s,
        sessions,
        projects,
        loading: false,
        error: refreshError,
        sessionsLoadedCleanly: nextSessionsLoadedCleanly,
        sessionNotifications: shouldPruneActivity
          ? s.sessionNotifications.filter((notification) =>
              sessionIds.has(notification.sessionId),
            )
          : s.sessionNotifications,
        autoCloseSessionIds: shouldPruneActivity
          ? keepTrueRecordIds(s.autoCloseSessionIds, sessionIds)
          : s.autoCloseSessionIds,
        workspaces: reconciled.workspaces,
        projectFolders: reconciled.projectFolders,
        sessionFolderIds: reconciled.sessionFolderIds,
        activeProject: reconciled.activeProject,
        activeProjectFolderId: reconciled.activeProjectFolderId,
        ...mirrorActive(
          reconciled.workspaces,
          reconciled.activeProjectFolderId,
          {
            sessions,
            projects,
            projectFolders: reconciled.projectFolders,
            activeProject: reconciled.activeProject,
          },
        ),
      };
      return applyKnownSessionPlacementIntents(nextState);
    });
    if (sessionsResult.status === "fulfilled") {
      void get().refreshLiveInWorktree();
    }
  },

  async pollSessionStatuses(ids) {
    const requestedIds =
      ids === undefined
        ? undefined
        : Array.from(new Set(ids)).filter((id) =>
            get().sessions.some((session) => session.id === id),
          );
    if (requestedIds !== undefined && requestedIds.length === 0) return;

    if (requestedIds === undefined) {
      const currentIds = get().sessions.map((session) => session.id);
      const activePollCoversAll =
        activeStatusPollAll &&
        currentIds.every((id) => activeStatusPollIds.has(id));
      if (!activePollCoversAll && !pendingStatusPollAll) {
        pendingStatusPollAll = true;
        pendingStatusPollIds.clear();
      }
    } else if (!pendingStatusPollAll) {
      for (const id of requestedIds) {
        if (!activeStatusPollIds.has(id)) pendingStatusPollIds.add(id);
      }
    }

    if (!statusPollRunning) {
      statusPollRunning = true;
      statusPollChain = (async () => {
        while (pendingStatusPollAll || pendingStatusPollIds.size > 0) {
          const pollAll = pendingStatusPollAll;
          const queuedIds = pollAll
            ? undefined
            : Array.from(pendingStatusPollIds);
          pendingStatusPollAll = false;
          pendingStatusPollIds.clear();

          const sessionIds = new Set(get().sessions.map((s) => s.id));
          const idsToPoll = Array.from(
            new Set(queuedIds ?? get().sessions.map((s) => s.id)),
          ).filter((id) => sessionIds.has(id));
          if (idsToPoll.length === 0) continue;

          activeStatusPollAll = pollAll;
          activeStatusPollIds = new Set(idsToPoll);
          try {
            const updates = await api.detectSessionStatuses(idsToPoll);
            const map = new Map(updates.map((u) => [u.id, u]));
            set((s) => {
              let changed = false;
              const nextSessions = s.sessions.map((sess) => {
                const update = map.get(sess.id);
                if (!update) return sess;
                const nextStatus = update.status;
                const nextStatusReason = Object.prototype.hasOwnProperty.call(
                  update,
                  "status_reason",
                )
                  ? (update.status_reason ?? null)
                  : (sess.status_reason ?? null);
                const nextBranch = update.branch ?? sess.branch;
                const nextLastMessage = Object.prototype.hasOwnProperty.call(
                  update,
                  "last_message",
                )
                  ? (update.last_message ?? null)
                  : sess.last_message;
                const nextLastUserMessage = Object.prototype.hasOwnProperty.call(
                  update,
                  "last_user_message",
                )
                  ? (update.last_user_message ?? null)
                  : (sess.last_user_message ?? null);
                const nextLastAgentMessage = Object.prototype.hasOwnProperty.call(
                  update,
                  "last_agent_message",
                )
                  ? (update.last_agent_message ?? null)
                  : (sess.last_agent_message ?? null);
                const nextAgentProvider =
                  Object.prototype.hasOwnProperty.call(update, "agent_provider")
                    ? (update.agent_provider ?? null)
                    : (sess.agent_provider ?? null);
                const nextAgentTranscriptId = Object.prototype.hasOwnProperty.call(
                  update,
                  "agent_transcript_id",
                )
                  ? (update.agent_transcript_id ?? null)
                  : (sess.agent_transcript_id ?? null);
                const currentActiveProcesses = sess.active_processes ?? [];
                const nextActiveProcesses = Object.prototype.hasOwnProperty.call(
                  update,
                  "active_processes",
                )
                  ? (update.active_processes ?? [])
                  : currentActiveProcesses;
                const nextGitContextPath = Object.prototype.hasOwnProperty.call(
                  update,
                  "git_context_path",
                )
                  ? (update.git_context_path ?? null)
                  : (sess.git_context_path ?? null);
                // Carries the backend's auto-title promotion (terminal
                // session that started an agent) so the title planner sees
                // eligibility on the next poll instead of waiting for a
                // full session refresh.
                const nextAutoTitleEnabled =
                  update.auto_title_enabled ?? sess.auto_title_enabled ?? null;
                if (
                  nextStatus !== sess.status ||
                  nextStatusReason !== (sess.status_reason ?? null) ||
                  nextBranch !== sess.branch ||
                  nextLastMessage !== sess.last_message ||
                  nextLastUserMessage !== (sess.last_user_message ?? null) ||
                  nextLastAgentMessage !== (sess.last_agent_message ?? null) ||
                  nextAgentProvider !== (sess.agent_provider ?? null) ||
                  nextAgentTranscriptId !== (sess.agent_transcript_id ?? null) ||
                  !sessionProcessSummariesEqual(
                    nextActiveProcesses,
                    currentActiveProcesses,
                  ) ||
                  nextGitContextPath !== (sess.git_context_path ?? null) ||
                  nextAutoTitleEnabled !== (sess.auto_title_enabled ?? null)
                ) {
                  changed = true;
                  return {
                    ...sess,
                    status: nextStatus,
                    status_reason: nextStatusReason,
                    branch: nextBranch,
                    last_message: nextLastMessage,
                    last_user_message: nextLastUserMessage,
                    last_agent_message: nextLastAgentMessage,
                    agent_provider: nextAgentProvider,
                    agent_transcript_id: nextAgentTranscriptId,
                    active_processes: nextActiveProcesses,
                    git_context_path: nextGitContextPath,
                    auto_title_enabled: nextAutoTitleEnabled,
                  };
                }
                return sess;
              });
              return changed ? { sessions: nextSessions } : s;
            });
          } catch (e) {
            // Polling errors are non-fatal: log and move on.
            console.warn("[acorn] pollSessionStatuses failed", e);
          } finally {
            activeStatusPollAll = false;
            activeStatusPollIds.clear();
          }
        }
      })().finally(() => {
        statusPollRunning = false;
        statusPollChain = null;
        activeStatusPollAll = false;
        activeStatusPollIds.clear();
      });
    }

    await statusPollChain;
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
              [ws.focusedPaneId]: activatePaneTab(pane, null),
            },
          };
        });
        return patch ?? s;
      }

      if (isWorkspaceTabId(id)) {
        const tab = s.workspaceTabs[id];
        const owner = findTabOwner(s, id);
        if (!tab || !owner) return s;
        const ws = s.workspaces[owner.projectFolderId];
        if (!ws) return s;
        const pane = ws.panes[owner.paneId];
        if (!pane) return s;
        const nextWs: ProjectWorkspace = {
          ...ws,
          panes: {
            ...ws.panes,
            [owner.paneId]: activatePaneTab(pane, id),
          },
          focusedPaneId: owner.paneId,
        };
        const workspaces = { ...s.workspaces, [owner.projectFolderId]: nextWs };
        const activeProject = owner.repoPath ?? s.activeProject;
        return {
          workspaces,
          activeProject,
          activeProjectFolderId: owner.projectFolderId,
          ...mirrorActive(workspaces, owner.projectFolderId, {
            ...s,
            activeProject,
          }),
        };
      }

      // Find session, switch active project to its repo, set active in pane.
      const session = s.sessions.find((x) => x.id === id);
      if (!session) return s;

      const folders = s.projectFolders[session.repo_path] ?? [];
      const targetProjectFolderId = resolveProjectFolderIdForSession(
        folders,
        session,
        s.sessionFolderIds,
      );
      const ws =
        s.workspaces[targetProjectFolderId] ??
        s.workspaces[defaultProjectFolderId(session.repo_path)];
      if (!ws) return s;
      const workspaceId = s.workspaces[targetProjectFolderId]
        ? targetProjectFolderId
        : defaultProjectFolderId(session.repo_path);

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
            ...activatePaneTab(pane, id),
            tabIds,
          },
        },
        focusedPaneId: targetPaneId,
      };
      const workspaces = { ...s.workspaces, [workspaceId]: newWs };
      return {
        workspaces,
        activeProject: session.repo_path,
        activeProjectFolderId: workspaceId,
        ...mirrorActive(workspaces, workspaceId, {
          ...s,
          activeProject: session.repo_path,
        }),
      };
    });
  },

  selectSession(id) {
    get().selectTab(id);
  },

  focusLocalSessions() {
    const state = get();
    const currentLocal = state.activeSessionId
      ? state.sessions.find(
          (session) =>
            session.id === state.activeSessionId &&
            session.project_scoped === false,
        )
      : null;
    const local =
      currentLocal ??
      state.sessions.find((session) => session.project_scoped === false);
    if (local) {
      get().selectSession(local.id);
      return;
    }
    set((s) => {
      if (s.activeProject === null && s.activeTabId === null) return s;
      return {
        activeProject: null,
        activeProjectFolderId: null,
        ...fallbackEmptyMirror(),
      };
    });
  },

  setActiveProject(repoPath) {
    set((s) => {
      const folderId = defaultProjectFolderId(repoPath);
      const hasWorkspace = s.workspaces[folderId] !== undefined;
      const knownRepo =
        hasWorkspace ||
        s.projects.some((project) => project.repo_path === repoPath) ||
        s.sessions.some((session) => session.repo_path === repoPath);
      if (!knownRepo) return s;
      if (
        s.activeProject === repoPath &&
        s.activeProjectFolderId === folderId &&
        hasWorkspace
      ) {
        return s;
      }
      const existingFolders = s.projectFolders[repoPath] ?? [];
      const projectFolders = existingFolders.some((folder) => folder.id === folderId)
        ? s.projectFolders
        : {
            ...s.projectFolders,
            [repoPath]: sortProjectFolders([
              ...existingFolders,
              {
                id: folderId,
                repoPath,
                name: DEFAULT_PROJECT_FOLDER_NAME,
                cwdPath: repoPath,
                position: 0,
              },
            ]),
          };
      const workspaces = hasWorkspace
        ? s.workspaces
        : {
            ...s.workspaces,
            [folderId]: emptyWorkspace(
              workspaceViewModeForProject(
                s.workspaces,
                projectFolders,
                repoPath,
              ),
            ),
          };
      return {
        workspaces,
        projectFolders,
        activeProject: repoPath,
        activeProjectFolderId: folderId,
        ...mirrorActive(workspaces, folderId, {
          ...s,
          projectFolders,
          activeProject: repoPath,
        }),
      };
    });
  },

  setActiveProjectFolder(folderId) {
    set((s) => {
      const folder = findProjectFolder(s, folderId);
      if (!folder) return s;
      const workspaces = s.workspaces[folder.id]
        ? s.workspaces
        : {
            ...s.workspaces,
            [folder.id]: emptyWorkspace(
              workspaceViewModeForProject(
                s.workspaces,
                s.projectFolders,
                folder.repoPath,
                s.activeProject === folder.repoPath
                  ? activeWorkspaceId(s)
                  : null,
              ),
            ),
          };
      return {
        workspaces,
        activeProject: folder.repoPath,
        activeProjectFolderId: folder.id,
        ...mirrorActive(workspaces, folder.id, {
          ...s,
          activeProject: folder.repoPath,
        }),
      };
    });
  },

  createProjectFolder(repoPath, name, cwdPath) {
    let created: ProjectFolder | null = null;
    set((s) => {
      const current = s.projectFolders[repoPath] ?? [
        {
          id: defaultProjectFolderId(repoPath),
          repoPath,
          name: DEFAULT_PROJECT_FOLDER_NAME,
          cwdPath: repoPath,
          position: 0,
        },
      ];
      const folderCwdPath = cwdPath?.trim() || repoPath;
      const baseName =
        (name ??
          (folderCwdPath === repoPath
            ? "New workspace"
            : basenamePath(folderCwdPath))
        ).trim() || "New workspace";
      const taken = new Set(current.map((folder) => folder.name));
      let nextName = baseName;
      let suffix = 2;
      while (taken.has(nextName)) {
        nextName = `${baseName} ${suffix}`;
        suffix += 1;
      }
      created = {
        id: makeProjectFolderId(repoPath),
        repoPath,
        name: nextName,
        cwdPath: folderCwdPath,
        position:
          Math.max(0, ...current.map((folder) => folder.position ?? 0)) + 1,
      };
      const projectFolders = {
        ...s.projectFolders,
        [repoPath]: sortProjectFolders([...current, created]),
      };
      const workspaces = {
        ...s.workspaces,
        [created.id]: emptyWorkspace(
          workspaceViewModeForProject(
            s.workspaces,
            projectFolders,
            repoPath,
            s.activeProject === repoPath ? activeWorkspaceId(s) : null,
          ),
        ),
      };
      const reconciled = reconcileWorkspaces(
        s.sessions,
        s.projects,
        projectFolders,
        s.sessionFolderIds,
        workspaces,
        repoPath,
        created.id,
        true,
      );
      return {
        projectFolders: reconciled.projectFolders,
        sessionFolderIds: reconciled.sessionFolderIds,
        workspaces: reconciled.workspaces,
        activeProject: reconciled.activeProject,
        activeProjectFolderId: reconciled.activeProjectFolderId,
        ...mirrorActive(
          reconciled.workspaces,
          reconciled.activeProjectFolderId,
          {
            sessions: s.sessions,
            projects: s.projects,
            projectFolders: reconciled.projectFolders,
            activeProject: reconciled.activeProject,
          },
        ),
      };
    });
    return created;
  },

  renameProjectFolder(folderId, name) {
    const nextName = name.trim();
    if (!nextName) return;
    set((s) => {
      const folder = findProjectFolder(s, folderId);
      if (!folder || folder.name === nextName) return s;
      const folders = s.projectFolders[folder.repoPath] ?? [];
      return {
        projectFolders: {
          ...s.projectFolders,
          [folder.repoPath]: sortProjectFolders(
            folders.map((candidate) =>
              candidate.id === folderId
                ? { ...candidate, name: nextName }
                : candidate,
            ),
          ),
        },
      };
    });
  },

  removeProjectFolder(folderId) {
    set((s) => {
      const folder = findProjectFolder(s, folderId);
      if (!folder || isDefaultProjectFolder(folder)) return s;
      const folders = (s.projectFolders[folder.repoPath] ?? []).filter(
        (candidate) => candidate.id !== folderId,
      );
      const { [folderId]: _, ...workspaces } = s.workspaces;
      const sessionFolderIds = Object.fromEntries(
        Object.entries(s.sessionFolderIds).filter(
          ([, assignedFolderId]) => assignedFolderId !== folderId,
        ),
      );
      const activeProjectFolderId =
        s.activeProjectFolderId === folderId
          ? defaultProjectFolderId(folder.repoPath)
          : s.activeProjectFolderId;
      const projectFolders = {
        ...s.projectFolders,
        [folder.repoPath]: sortProjectFolders(folders),
      };
      const reconciled = reconcileWorkspaces(
        s.sessions,
        s.projects,
        projectFolders,
        sessionFolderIds,
        workspaces,
        folder.repoPath,
        activeProjectFolderId,
        true,
      );
      return {
        projectFolders: reconciled.projectFolders,
        workspaces: reconciled.workspaces,
        sessionFolderIds: reconciled.sessionFolderIds,
        activeProject: reconciled.activeProject,
        activeProjectFolderId: reconciled.activeProjectFolderId,
        ...mirrorActive(
          reconciled.workspaces,
          reconciled.activeProjectFolderId,
          {
            sessions: s.sessions,
            projects: s.projects,
            projectFolders: reconciled.projectFolders,
            activeProject: reconciled.activeProject,
          },
        ),
      };
    });
  },

  moveSessionToProjectFolder(sessionId, folderId) {
    set((s) => {
      const session = s.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return s;
      if (!canAssignSessionToProjectFolder(s, session, folderId)) return s;
      const nextSessionFolderIds = { ...s.sessionFolderIds };
      if (
        folderId === null ||
        folderId === defaultProjectFolderId(session.repo_path)
      ) {
        delete nextSessionFolderIds[sessionId];
      } else {
        const folder = findProjectFolder(s, folderId);
        if (!folder || folder.repoPath !== session.repo_path) return s;
        nextSessionFolderIds[sessionId] = folder.id;
      }
      const reconciled = reconcileWorkspaces(
        s.sessions,
        s.projects,
        s.projectFolders,
        nextSessionFolderIds,
        s.workspaces,
        s.activeProject,
        s.activeProjectFolderId,
        true,
      );
      return {
        projectFolders: reconciled.projectFolders,
        workspaces: reconciled.workspaces,
        sessionFolderIds: reconciled.sessionFolderIds,
        activeProject: reconciled.activeProject,
        activeProjectFolderId: reconciled.activeProjectFolderId,
        ...mirrorActive(
          reconciled.workspaces,
          reconciled.activeProjectFolderId,
          {
            sessions: s.sessions,
            projects: s.projects,
            projectFolders: reconciled.projectFolders,
            activeProject: reconciled.activeProject,
          },
        ),
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

  setWorkspaceViewMode(mode) {
    set((s) => {
      const workspaceId = activeWorkspaceId(s);
      if (!s.activeProject || !workspaceId) return s;
      const viewScope = workspaceViewScopeForActiveWorkspace(
        s.workspaces,
        workspaceId,
        s,
      );
      const workspaces =
        viewScope === "local"
          ? setLocalWorkspaceViewMode(
              s.workspaces,
              s.projectFolders,
              s.activeProject,
              mode,
            )
          : setProjectWorkspaceViewMode(
              s.workspaces,
              s.projectFolders,
              s.activeProject,
              mode,
            );
      if (workspaces === s.workspaces) return s;
      return {
        workspaces,
        ...mirrorActive(workspaces, workspaceId, s),
      };
    });
  },

  openTerminalPopup(sessionId) {
    set({ terminalPopupSessionId: sessionId });
  },

  closeTerminalPopup() {
    set({ terminalPopupSessionId: null });
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

  setPaneSplitSizes(splitId, sizes) {
    set((s) => {
      const patch = updateActiveWorkspace(s, (ws) => {
        const layout = updateSplitSizesInLayout(ws.layout, splitId, sizes);
        if (layout === ws.layout) return ws;
        return { ...ws, layout };
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
          ...ws,
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
            [ws.focusedPaneId]: activatePaneTab(pane, nextId),
          },
        };
      });
      return patch ?? s;
    });
  },

  selectLatestNeedsInputSession() {
    const sessionId = latestNeedsInputSessionId(get());
    if (!sessionId) return false;
    get().selectSession(sessionId);
    get().setWorkspaceViewMode("panes");
    return get().activeSessionId === sessionId;
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
          const mergedTabIds = [...target.tabIds, ...pane.tabIds];
          const mergedActive = target.activeTabId ?? pane.activeTabId;
          newPanes[fallback] = {
            ...target,
            tabIds: mergedTabIds,
            activeTabId: mergedActive,
            activationHistory: activationHistoryFor(
              {
                activationHistory: [
                  ...(pane.activationHistory ?? []),
                  ...(target.activationHistory ?? []),
                ],
              },
              mergedTabIds,
              mergedActive,
            ),
          };
        }
        return {
          ...ws,
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
        const srcActivationHistory =
          fromPane.activationHistory?.filter((id) => id !== args.tabId) ?? [];
        const srcActive =
          fromPane.activeTabId === args.tabId
            ? preferredTabId(
                { activationHistory: srcActivationHistory },
                srcTabIds,
              )
            : fromPane.activeTabId;
        let newPanes: Record<PaneId, PaneState> = {
          ...ws.panes,
          [args.fromPaneId]: {
            ...fromPane,
            tabIds: srcTabIds,
            activeTabId: srcActive,
            activationHistory: activationHistoryFor(
              { ...fromPane, activationHistory: srcActivationHistory },
              srcTabIds,
              srcActive,
            ),
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
          ...activatePaneTab(toPane, args.tabId),
          tabIds: targetIds,
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
          ...ws,
          layout: newLayout,
          panes: newPanes,
          focusedPaneId: toPaneId,
        };
      });
      return patch ?? s;
    });
  },

  async createSession(
    name,
    selectedPath,
    isolated = false,
    kind = "regular",
    agentProvider = null,
    projectScoped = true,
    mode = "terminal",
    projectFolderId,
    cwdPath,
  ) {
    set({ loading: true, error: null });
    // Capture the user's intended insertion point before the backend call.
    // Multiple creates can be in flight at once, so the intent records the
    // anchor tab id plus a client-side sequence instead of a numeric index
    // that may be stale by the time the session is returned.
    const placement = captureSessionPlacementIntent(
      get(),
      resolvePlacementProjectFolderId(get(), selectedPath, projectFolderId),
    );
    if (placement) activeSessionPlacementIntents.add(placement);
    let createdId: string | null = null;
    try {
      let created: Session;
      if (projectScoped === false) {
        created =
          mode === "terminal" && !cwdPath
            ? await api.createSession(
                name,
                selectedPath,
                isolated,
                kind,
                agentProvider,
                false,
              )
            : await api.createSession(
                name,
                selectedPath,
                isolated,
                kind,
                agentProvider,
                false,
                mode,
                cwdPath,
              );
      } else {
        created =
          mode === "terminal" && !cwdPath
            ? await api.createSession(
                name,
                selectedPath,
                isolated,
                kind,
                agentProvider,
              )
            : await api.createSession(
                name,
                selectedPath,
                isolated,
                kind,
                agentProvider,
                projectScoped,
                mode,
                cwdPath,
              );
      }
      createdId = created.id;
      const assignedFolderId = placement?.projectFolderId;
      const assignCreatedToFolder = (reconcile: boolean) => {
        if (!assignedFolderId) return;
        set((s) => {
          const existingSession = s.sessions.find(
            (candidate) => candidate.id === created.id,
          );
          const session = existingSession ?? created;
          if (
            repoPathForProjectFolderId(s, assignedFolderId) !==
            session.repo_path
          ) {
            return s;
          }
          const targetFolderId =
            assignedFolderId === defaultProjectFolderId(session.repo_path)
              ? null
              : assignedFolderId;
          if (!canAssignSessionToProjectFolder(s, session, targetFolderId)) {
            return s;
          }
          const sessionFolderIds = { ...s.sessionFolderIds };
          if (targetFolderId === null) {
            delete sessionFolderIds[created.id];
          } else {
            sessionFolderIds[created.id] = targetFolderId;
          }
          if (
            (s.sessionFolderIds[created.id] ?? null) ===
            (sessionFolderIds[created.id] ?? null)
          ) {
            return s;
          }
          if (!reconcile || !existingSession) return { sessionFolderIds };
          const reconciled = reconcileWorkspaces(
            s.sessions,
            s.projects,
            s.projectFolders,
            sessionFolderIds,
            s.workspaces,
            s.activeProject,
            s.activeProjectFolderId,
            true,
          );
          return {
            projectFolders: reconciled.projectFolders,
            workspaces: reconciled.workspaces,
            sessionFolderIds: reconciled.sessionFolderIds,
            activeProject: reconciled.activeProject,
            activeProjectFolderId: reconciled.activeProjectFolderId,
            ...mirrorActive(
              reconciled.workspaces,
              reconciled.activeProjectFolderId,
              {
                sessions: s.sessions,
                projects: s.projects,
                projectFolders: reconciled.projectFolders,
                activeProject: reconciled.activeProject,
              },
            ),
          };
        });
      };
      assignCreatedToFolder(false);
      await get().refreshAll();
      assignCreatedToFolder(true);

      if (placement) {
        sessionPlacementById.set(created.id, placement);
        set((s) => applySessionPlacementIntent(s, created.id, placement));
      }

      // Focus the new session so Cmd+T (and any other entry point that goes
      // through the store) immediately surfaces it in its pane instead of
      // silently appending behind the existing active tab.
      get().selectSession(created.id);
      if (
        mode === "terminal" &&
        get().workspaceViewMode === "kanban" &&
        useSettings.getState().settings.interface
          .openKanbanTerminalOnSessionCreate
      ) {
        get().openTerminalPopup(created.id);
      }
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
    } finally {
      if (placement) {
        activeSessionPlacementIntents.delete(placement);
        if (
          createdId === null ||
          get().sessions.some((session) => session.id === createdId)
        ) {
          pruneSessionPlacementGroup(placement, get().sessions);
        }
      }
    }
  },

  placeSessionInWorkspace(sessionId, workspace) {
    set((s) => applySessionWorkspaceHint(s, sessionId, workspace));
  },

  async removeSession(id, removeWorktree = false) {
    const target = get().sessions.find((session) => session.id === id);
    const removalIds = target
      ? sessionRemovalCascadeIds(get().sessions, target)
      : new Set<string>([id]);
    if (removeWorktree) {
      const state = get();
      if (target) {
        const otherSessions = otherSessionsUsingWorktreePath(
          state.sessions,
          target.worktree_path,
          target.id,
        ).filter((session) => !removalIds.has(session.id));
        if (otherSessions.length > 0) {
          set({ error: WORKTREE_IN_USE_BY_OTHER_SESSIONS });
          return null;
        }
      }
    }
    const owning = findTabOwner(get(), id);
    for (const removalId of removalIds) {
      sessionPlacementById.delete(removalId);
    }
    set((s) => {
      if (!s.sessions.some((session) => removalIds.has(session.id))) return s;

      const sessions = s.sessions.filter(
        (session) => !removalIds.has(session.id),
      );
      const reconciled = reconcileWorkspaces(
        sessions,
        s.projects,
        s.projectFolders,
        s.sessionFolderIds,
        s.workspaces,
        s.activeProject,
        s.activeProjectFolderId,
        true,
      );
      const liveInWorktree = { ...s.liveInWorktree };
      for (const removalId of removalIds) {
        delete liveInWorktree[removalId];
      }
      const pendingTerminalInput = { ...s.pendingTerminalInput };
      for (const removalId of removalIds) {
        delete pendingTerminalInput[removalId];
      }
      const autoCloseSessionIds = { ...s.autoCloseSessionIds };
      for (const removalId of removalIds) {
        delete autoCloseSessionIds[removalId];
      }
      const terminalPopupSessionId =
        s.terminalPopupSessionId && removalIds.has(s.terminalPopupSessionId)
          ? null
          : s.terminalPopupSessionId;

      return {
        sessions,
        sessionsLoadedCleanly: true,
        error: null,
        liveInWorktree,
        pendingTerminalInput,
        autoCloseSessionIds,
        terminalPopupSessionId,
        sessionNotifications: s.sessionNotifications.filter(
          (notification) => !removalIds.has(notification.sessionId),
        ),
        workspaces: reconciled.workspaces,
        projectFolders: reconciled.projectFolders,
        sessionFolderIds: reconciled.sessionFolderIds,
        activeProject: reconciled.activeProject,
        activeProjectFolderId: reconciled.activeProjectFolderId,
        ...mirrorActive(
          reconciled.workspaces,
          reconciled.activeProjectFolderId,
          {
            sessions,
            projects: s.projects,
            projectFolders: reconciled.projectFolders,
            activeProject: reconciled.activeProject,
          },
        ),
      };
    });

    if (owning) {
      const after = get();
      const ws = after.workspaces[owning.projectFolderId];
      const pane = ws?.panes[owning.paneId];
      if (
        ws &&
        pane &&
        pane.tabIds.length === 0 &&
        Object.keys(ws.panes).length > 1 &&
        activeWorkspaceId(after) === owning.projectFolderId
      ) {
        get().closePane(owning.paneId);
      }
    }

    try {
      const removedWorktree = await api.removeSession(id, removeWorktree);
      await get().refreshAll();
      set({ error: null });
      return removedWorktree ?? null;
    } catch (e) {
      const message = errorMessage(e);
      await get().refreshAll();
      set({ error: message });
      return null;
    }
  },

  async renameSession(id, name) {
    if (get().generatingSessionTitleIds[id]) return;

    try {
      await api.renameSession(id, name);
      await get().refreshSessions();
      set({ error: null });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  async generateSessionTitle(id, ai, prompt, force = false) {
    if (force) {
      const session = get().sessions.find((candidate) => candidate.id === id);
      if (!session || !canRegenerateSessionTitle(session)) return "skipped";
    } else if (get().autoCloseSessionIds[id]) {
      return "skipped";
    }

    const startedAt = Date.now();
    let resultStatus: SessionTitleGenerationStatus = "skipped";
    set((s) => ({
      generatingSessionTitleIds: {
        ...s.generatingSessionTitleIds,
        [id]: true,
      },
    }));
    try {
      const result = await api.generateSessionTitle(id, ai, prompt, force);
      resultStatus = result.status;
      const updated = result.session;
      if (result.status === "generated" && updated?.id) {
        let applied = false;
        set((s) => {
          if (!force && s.autoCloseSessionIds[updated.id]) return s;
          applied = true;
          return {
            sessions: s.sessions.map((session) =>
              session.id === updated.id ? updated : session,
            ),
          };
        });
        if (!applied) resultStatus = "skipped";
      }
    } catch (e) {
      console.warn("[acorn] generateSessionTitle failed", e);
    } finally {
      const remainingMs =
        resultStatus === "generated"
          ? SESSION_TITLE_GENERATING_MIN_MS - (Date.now() - startedAt)
          : 0;
      if (remainingMs > 0) {
        await delay(remainingMs);
      }
      set((s) => {
        if (!s.generatingSessionTitleIds[id]) return s;
        const { [id]: _, ...rest } = s.generatingSessionTitleIds;
        return { generatingSessionTitleIds: rest };
      });
    }
    return resultStatus;
  },

  async adoptSessionWorktree(id, worktreePath) {
    try {
      await api.updateSessionWorktree(id, worktreePath);
      await get().refreshSessions();
      set({ error: null });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  toggleSessionAutoClose(id) {
    set((s) => {
      const session = s.sessions.find((candidate) => candidate.id === id);
      if (!session || session.kind !== "regular") return s;
      const autoCloseSessionIds = { ...s.autoCloseSessionIds };
      if (autoCloseSessionIds[id]) {
        delete autoCloseSessionIds[id];
      } else {
        if (!canConfigureSessionAutoClose(session)) return s;
        autoCloseSessionIds[id] = true;
      }
      return { autoCloseSessionIds };
    });
  },

  requestRemoveSession(id) {
    set({ pendingRemoveId: id });
  },

  clearPendingRemove() {
    set({ pendingRemoveId: null });
  },

  async addProject(title) {
    try {
      const project = await api.addProject(title);
      await get().refreshProjects();
      if (project) {
        get().setActiveProject(project.repo_path);
        await createInitialProjectSession(get, project.repo_path);
      }
      set({ error: null });
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
      await createInitialProjectSession(get, project.repo_path);
      set({ error: null });
      return project;
    } catch (e) {
      set({ error: errorMessage(e) });
      throw e;
    }
  },

  async removeProject(repoPath, removeWorktrees = false, removeSettings = false) {
    try {
      const removedWorktrees = await api.removeProject(
        repoPath,
        true,
        removeWorktrees,
        removeSettings,
      );
      // Drop the project's workspace from local state explicitly — refreshAll
      // also reconciles, but pre-clearing avoids a flash of stale state.
      set((s) => {
        const folders = s.projectFolders[repoPath] ?? [
        {
          id: defaultProjectFolderId(repoPath),
          repoPath,
          name: DEFAULT_PROJECT_FOLDER_NAME,
          cwdPath: repoPath,
          position: 0,
        },
      ];
        const folderIds = new Set(folders.map((folder) => folder.id));
        const rest = Object.fromEntries(
          Object.entries(s.workspaces).filter(
            ([workspaceId]) => !folderIds.has(workspaceId),
          ),
        );
        const { [repoPath]: _folders, ...projectFolders } = s.projectFolders;
        const sessionFolderIds = Object.fromEntries(
          Object.entries(s.sessionFolderIds).filter(
            ([, folderId]) => !folderIds.has(folderId),
          ),
        );
        const nextActive =
          s.activeProject === repoPath ? null : s.activeProject;
        const nextActiveFolderId = folderIds.has(s.activeProjectFolderId ?? "")
          ? null
          : s.activeProjectFolderId;
        return {
          workspaces: rest,
          projectFolders,
          sessionFolderIds,
          activeProject: nextActive,
          activeProjectFolderId: nextActiveFolderId,
          ...mirrorActive(rest, nextActiveFolderId, {
            sessions: s.sessions,
            projects: s.projects.filter(
              (project) => project.repo_path !== repoPath,
            ),
            projectFolders,
            activeProject: nextActive,
          }),
        };
      });
      await get().refreshAll();
      set({ error: null });
      return removedWorktrees ?? [];
    } catch (e) {
      set({ error: errorMessage(e) });
      return [];
    }
  },

  async removeProjectWorktree(repoPath, worktreePath, removeSessions = false) {
    try {
      const state = get();
      const targetSessions = sessionsUsingProjectWorktree(
        state.sessions,
        repoPath,
        worktreePath,
      );
      const targetSessionIds = new Set(
        targetSessions.map((session) => session.id),
      );
      const sessionsOutsideProject = sessionsUsingWorktreePath(
        state.sessions,
        worktreePath,
      ).filter((session) => !targetSessionIds.has(session.id));
      const canRemoveSessions =
        targetSessions.length === 0 ||
        (targetSessions.length === 1 &&
          targetSessions[0]?.id === state.activeSessionId);
      const removingRequiredSessions =
        targetSessions.length === 0 || removeSessions;
      if (
        sessionsOutsideProject.length > 0 ||
        !canRemoveSessions ||
        !removingRequiredSessions
      ) {
        set({ error: WORKTREE_IN_USE_BY_OTHER_SESSIONS });
        throw new Error(WORKTREE_IN_USE_BY_OTHER_SESSIONS);
      }
      const removedWorktree = await api.removeWorktree(
        repoPath,
        worktreePath,
        removeSessions,
      );
      set((s) => {
        const removedSessionIds = new Set<string>();
        const sessions = removeSessions
          ? s.sessions.filter((session) => {
              const shouldRemove =
                sameWorkspacePath(session.repo_path, repoPath) &&
                sameWorkspacePath(session.worktree_path, worktreePath);
              if (shouldRemove) removedSessionIds.add(session.id);
              return !shouldRemove;
            })
          : s.sessions;
        const currentFolders = s.projectFolders[repoPath] ?? [];
        const removedFolderIds = new Set(
          currentFolders
            .filter(
              (folder) =>
                !isDefaultProjectFolder(folder) &&
                sameWorkspacePath(folder.cwdPath, worktreePath),
            )
            .map((folder) => folder.id),
        );
        const projectFolders = {
          ...s.projectFolders,
          [repoPath]: currentFolders.filter(
            (folder) => !removedFolderIds.has(folder.id),
          ),
        };
        const workspaces = Object.fromEntries(
          Object.entries(s.workspaces).filter(
            ([workspaceId]) => !removedFolderIds.has(workspaceId),
          ),
        );
        const sessionFolderIds = Object.fromEntries(
          Object.entries(s.sessionFolderIds).filter(
            ([sessionId, folderId]) =>
              !removedSessionIds.has(sessionId) &&
              !removedFolderIds.has(folderId),
          ),
        );
        const liveInWorktree = { ...s.liveInWorktree };
        const pendingTerminalInput = { ...s.pendingTerminalInput };
        for (const sessionId of removedSessionIds) {
          delete liveInWorktree[sessionId];
          delete pendingTerminalInput[sessionId];
        }
        const activeProjectFolderId = removedFolderIds.has(
          s.activeProjectFolderId ?? "",
        )
          ? defaultProjectFolderId(repoPath)
          : s.activeProjectFolderId;
        const reconciled = reconcileWorkspaces(
          sessions,
          s.projects,
          projectFolders,
          sessionFolderIds,
          workspaces,
          s.activeProject,
          activeProjectFolderId,
          true,
        );
        return {
          sessions,
          error: null,
          liveInWorktree,
          pendingTerminalInput,
          sessionNotifications: s.sessionNotifications.filter(
            (notification) => !removedSessionIds.has(notification.sessionId),
          ),
          workspaces: reconciled.workspaces,
          projectFolders: reconciled.projectFolders,
          sessionFolderIds: reconciled.sessionFolderIds,
          activeProject: reconciled.activeProject,
          activeProjectFolderId: reconciled.activeProjectFolderId,
          ...mirrorActive(
            reconciled.workspaces,
            reconciled.activeProjectFolderId,
            {
              sessions,
              projects: s.projects,
              projectFolders: reconciled.projectFolders,
              activeProject: reconciled.activeProject,
            },
          ),
        };
      });
      await get().refreshAll();
      set({ error: null });
      return removedWorktree ?? null;
    } catch (e) {
      set({ error: errorMessage(e) });
      throw e;
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

  reorderProjectFolders(repoPath, orderedFolderIds) {
    set((s) => {
      const folders = s.projectFolders[repoPath] ?? [];
      const defaultFolders = folders.filter(isDefaultProjectFolder);
      const namedFolders = folders.filter(
        (folder) => !isDefaultProjectFolder(folder),
      );
      if (namedFolders.length === 0) return s;

      const remaining = new Map(
        namedFolders.map((folder) => [folder.id, folder]),
      );
      const ordered: ProjectFolder[] = [];
      for (const folderId of orderedFolderIds) {
        const folder = remaining.get(folderId);
        if (!folder) continue;
        ordered.push(folder);
        remaining.delete(folderId);
      }
      const nextNamed = [
        ...ordered,
        ...sortProjectFolders(Array.from(remaining.values())),
      ].map((folder, index) => ({
        ...folder,
        position: index + 1,
      }));
      const nextFolders = sortProjectFolders([
        ...defaultFolders.map((folder) => ({ ...folder, position: 0 })),
        ...nextNamed,
      ]);
      if (
        folders.map((folder) => folder.id).join("\0") ===
        nextFolders.map((folder) => folder.id).join("\0")
      ) {
        return s;
      }
      return {
        projectFolders: {
          ...s.projectFolders,
          [repoPath]: nextFolders,
        },
      };
    });
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
    const hasSessions = get().sessions.some((s) => s.repo_path === repoPath);
    if (!hasSessions) {
      void get().removeProject(repoPath, false);
      return;
    }
    set({ pendingRemoveProject: repoPath });
  },

  clearPendingRemoveProject() {
    set({ pendingRemoveProject: null });
  },

  setRightTab(tab) {
    set((s) => {
      const rightTabByGroup = {
        ...s.rightTabByGroup,
        [groupOfTab(tab)]: tab,
      };
      const workspaceId = activeWorkspaceId(s);
      if (!workspaceId || !s.workspaces[workspaceId]) {
        return { rightTab: tab, rightTabByGroup };
      }
      const ws = s.workspaces[workspaceId];
      return {
        rightTab: tab,
        rightTabByGroup,
        workspaces: {
          ...s.workspaces,
          [workspaceId]: {
            ...ws,
            rightTab: tab,
            rightTabByGroup,
          },
        },
      };
    });
  },

  setRightGroup(group) {
    set((s) => {
      const remembered = s.rightTabByGroup[group] ?? defaultTabForGroup(group);
      if (s.rightTab === remembered) return s;
      const workspaceId = activeWorkspaceId(s);
      if (!workspaceId || !s.workspaces[workspaceId]) {
        return { rightTab: remembered };
      }
      const ws = s.workspaces[workspaceId];
      return {
        rightTab: remembered,
        workspaces: {
          ...s.workspaces,
          [workspaceId]: {
            ...ws,
            rightTab: remembered,
          },
        },
      };
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
          ...(options?.agentProvider
            ? { agentProvider: options.agentProvider }
            : {}),
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

  addSessionNotification(notification) {
    const maxHistory = useSettings.getState().settings.notifications.maxHistory;
    set((s) => {
      const existing = s.sessionNotifications.filter(
        (n) => n.id !== notification.id,
      );
      return {
        sessionNotifications: normalizeSessionNotifications(
          [notification, ...existing],
          maxHistory,
        ),
      };
    });
  },

  markSessionNotificationRead(id) {
    set((s) => {
      const autoDeleteRead =
        useSettings.getState().settings.notifications.autoDeleteRead;
      if (autoDeleteRead) {
        const sessionNotifications = s.sessionNotifications.filter(
          (notification) => notification.id !== id,
        );
        if (sessionNotifications.length === s.sessionNotifications.length) {
          return s;
        }
        return {
          sessionNotifications,
        };
      }
      const now = new Date().toISOString();
      let changed = false;
      const sessionNotifications = s.sessionNotifications.map((notification) => {
        if (notification.id !== id || notification.readAt) return notification;
        changed = true;
        return { ...notification, readAt: now };
      });
      return changed ? { sessionNotifications } : s;
    });
  },

  markSessionNotificationsReadForSession(sessionId) {
    set((s) => {
      const autoDeleteRead =
        useSettings.getState().settings.notifications.autoDeleteRead;
      if (autoDeleteRead) {
        const sessionNotifications = s.sessionNotifications.filter(
          (notification) => notification.sessionId !== sessionId,
        );
        if (sessionNotifications.length === s.sessionNotifications.length) {
          return s;
        }
        return {
          sessionNotifications,
        };
      }
      const now = new Date().toISOString();
      let changed = false;
      const sessionNotifications = s.sessionNotifications.map((notification) => {
        if (notification.sessionId !== sessionId || notification.readAt) {
          return notification;
        }
        changed = true;
        return { ...notification, readAt: now };
      });
      return changed ? { sessionNotifications } : s;
    });
  },

  markAllSessionNotificationsRead() {
    set((s) => {
      const autoDeleteRead =
        useSettings.getState().settings.notifications.autoDeleteRead;
      if (autoDeleteRead) {
        if (s.sessionNotifications.length === 0) return s;
        return { sessionNotifications: [] };
      }
      if (s.sessionNotifications.every((notification) => notification.readAt)) {
        return s;
      }
      const now = new Date().toISOString();
      return {
        sessionNotifications: s.sessionNotifications.map((notification) =>
          notification.readAt ? notification : { ...notification, readAt: now },
        ),
      };
    });
  },

  dismissSessionNotification(id) {
    set((s) => ({
      sessionNotifications: s.sessionNotifications.filter(
        (notification) => notification.id !== id,
      ),
    }));
  },

  clearReadSessionNotifications() {
    set((s) => ({
      sessionNotifications: s.sessionNotifications.filter(
        (notification) => !notification.readAt,
      ),
    }));
  },

  toggleMultiInput() {
    let enabled = false;
    set((s) => {
      enabled = !s.multiInputEnabled;
      return { multiInputEnabled: enabled };
    });
    return enabled;
  },

  openCodeViewerTab(path, repoPath, target) {
    set((s) => {
      const workspaceId = activeWorkspaceId(s);
      if (!workspaceId || !s.activeProject) return s;
      const ws = s.workspaces[workspaceId];
      if (!ws) return s;
      const focused = ws.focusedPaneId;
      const pane = ws.panes[focused];
      if (!pane) return s;
      const activeWorkspaceTab = pane.activeTabId
        ? s.workspaceTabs[pane.activeTabId]
        : undefined;
      const targetRepoPath = repoPath ?? activeWorkspaceTab?.repoPath ?? s.activeProject;
      // Reuse an existing code tab for the same path if there is one;
      // this avoids piling up identical tabs when the user double-clicks
      // the same file repeatedly. The reuse cycles focus to the tab.
      const existing = Object.values(s.workspaceTabs).find(
        (tab) =>
          tab.kind === "code" &&
          tab.path === path &&
          tab.repoPath === targetRepoPath,
      );
      const normalizedTarget =
        target?.line && Number.isSafeInteger(target.line) && target.line > 0
          ? {
              line: target.line,
              ...(target.column &&
              Number.isSafeInteger(target.column) &&
              target.column > 0
                ? { column: target.column }
                : {}),
            }
          : undefined;
      const tab = existing
        ? {
            ...existing,
            target: normalizedTarget
              ? makeCodeWorkspaceTabTarget(normalizedTarget)
              : undefined,
          }
        : makeCodeWorkspaceTab(
            path,
            targetRepoPath,
            "ephemeral",
            normalizedTarget,
          );
      const alreadyInPane = pane.tabIds.includes(tab.id);
      const newPane: PaneState = alreadyInPane
        ? activatePaneTab(pane, tab.id)
        : {
            ...activatePaneTab(pane, tab.id),
            tabIds: [...pane.tabIds, tab.id],
          };
      const newWs: ProjectWorkspace = {
        ...ws,
        panes: { ...ws.panes, [focused]: newPane },
      };
      const newWorkspaces = {
        ...s.workspaces,
        [workspaceId]: newWs,
      };
      return {
        workspaceTabs: existing
          ? { ...s.workspaceTabs, [existing.id]: tab }
          : { ...s.workspaceTabs, [tab.id]: tab },
        workspaces: newWorkspaces,
        ...mirrorActive(newWorkspaces, workspaceId, s),
      };
    });
  },

  updateCodeViewerTabViewState(id, patch) {
    set((s) => {
      const tab = s.workspaceTabs[id];
      if (!tab || tab.kind !== "code") return s;
      const viewState = mergeCodeWorkspaceTabViewState(tab.viewState, patch);
      if (codeWorkspaceTabViewStateEqual(tab.viewState, viewState)) return s;
      return {
        workspaceTabs: {
          ...s.workspaceTabs,
          [id]: {
            ...tab,
            viewState,
          },
        },
      };
    });
  },

  async openWorkSummaryTab(scope = {}) {
    let baselineTabId: string | null = null;
    let baselineSession: Session | null = null;
    let shouldLoadBaseline = false;

    set((s) => {
      const workspaceId = activeWorkspaceId(s);
      if (!workspaceId || !s.activeProject) return s;
      const ws = s.workspaces[workspaceId];
      if (!ws) return s;
      const focused = ws.focusedPaneId;
      const pane = ws.panes[focused];
      if (!pane) return s;

      const activeSession = scope.sessionId
        ? s.sessions.find((session) => session.id === scope.sessionId) ?? null
        : s.activeSessionId
          ? s.sessions.find((session) => session.id === s.activeSessionId) ?? null
          : null;
      const activeWorkspaceTab = pane.activeTabId
        ? s.workspaceTabs[pane.activeTabId]
        : undefined;
      const repoPath =
        scope.repoPath ??
        activeSession?.repo_path ??
        activeWorkspaceTab?.repoPath ??
        s.activeProject;
      const cwdPath =
        scope.cwdPath ??
        activeSession?.worktree_path ??
        (activeWorkspaceTab?.kind === "work-summary"
          ? activeWorkspaceTab.cwdPath
          : activeWorkspaceTab?.repoPath) ??
        repoPath;
      const sessionId = scope.sessionId ?? activeSession?.id;
      const title =
        scope.title ??
        (activeSession ? `${activeSession.name} Summary` : "Work Summary");

      const existing = Object.values(s.workspaceTabs).find(
        (tab) =>
          tab.kind === "work-summary" &&
          tab.repoPath === repoPath &&
          tab.cwdPath === cwdPath &&
          (tab.sessionId ?? null) === (sessionId ?? null),
      );
      const tab =
        existing ??
        makeWorkSummaryWorkspaceTab({
          repoPath,
          cwdPath,
          ...(sessionId ? { sessionId } : {}),
          title,
        });
      baselineTabId = tab.id;
      baselineSession = activeSession;
      shouldLoadBaseline = Boolean(
        activeSession && tab.kind === "work-summary" && !tab.tokenBaseline,
      );
      const alreadyInPane = pane.tabIds.includes(tab.id);
      const newPane: PaneState = alreadyInPane
        ? activatePaneTab(pane, tab.id)
        : {
            ...activatePaneTab(pane, tab.id),
            tabIds: [...pane.tabIds, tab.id],
          };
      const newWs: ProjectWorkspace = {
        ...ws,
        panes: { ...ws.panes, [focused]: newPane },
      };
      const newWorkspaces = {
        ...s.workspaces,
        [workspaceId]: newWs,
      };
      return {
        workspaceTabs: existing
          ? s.workspaceTabs
          : { ...s.workspaceTabs, [tab.id]: tab },
        workspaces: newWorkspaces,
        ...mirrorActive(newWorkspaces, workspaceId, s),
      };
    });

    if (shouldLoadBaseline && baselineTabId && baselineSession) {
      const tabId = baselineTabId;
      void loadWorkSummaryTokenBaseline(baselineSession).then((tokenBaseline) => {
        if (!tokenBaseline) return;
        set((s) => {
          const tab = s.workspaceTabs[tabId];
          if (!tab || tab.kind !== "work-summary" || tab.tokenBaseline) {
            return s;
          }
          return {
            workspaceTabs: {
              ...s.workspaceTabs,
              [tabId]: {
                ...tab,
                tokenBaseline,
              },
            },
          };
        });
      });
    }
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
          const activationHistory =
            pane.activationHistory?.filter((sid) => sid !== id) ?? [];
          const nextActive =
            pane.activeTabId === id
              ? preferredTabId({ activationHistory }, ids)
              : pane.activeTabId;
          newPanes[pid as PaneId] = {
            ...pane,
            tabIds: ids,
            activeTabId: nextActive,
            activationHistory: activationHistoryFor(
              { ...pane, activationHistory },
              ids,
              nextActive,
            ),
          };
        }
        newWorkspaces[key] = { ...ws, panes: newPanes };
      }
      return {
        workspaceTabs: rest,
        workspaces: newWorkspaces,
        ...mirrorActive(newWorkspaces, activeWorkspaceId(s), s),
      };
    });
  },

    }),
    {
      name: "acorn-workspaces",
      storage: createJSONStorage(() => localStorage),
      version: 4,
      partialize: (state) => ({
        workspaces: state.workspaces,
        projectFolders: state.projectFolders,
        sessionFolderIds: state.sessionFolderIds,
        activeProject: state.activeProject,
        activeProjectFolderId: state.activeProjectFolderId,
        rightTab: state.rightTab,
        rightTabByGroup: state.rightTabByGroup,
        sessionNotifications: state.sessionNotifications,
        autoCloseSessionIds: state.autoCloseSessionIds,
        workspaceTabs: Object.fromEntries(
          Object.entries(state.workspaceTabs).filter(([, tab]) =>
            isRestorableWorkspaceTab(tab),
          ),
        ),
      }),
      migrate: (persisted, fromVersion) => {
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
          persisted = { ...p, rightTabByGroup: seeded };
        }
        if (
          persisted &&
          typeof persisted === "object" &&
          fromVersion < 3
        ) {
          const p = persisted as {
            rightTab?: unknown;
            rightTabByGroup?: Partial<Record<RightGroup, unknown>>;
            workspaces?: Record<string, PersistedWorkspaceState>;
          };
          const rightPanel = normalizeRightPanelState(
            p.rightTab,
            p.rightTabByGroup,
          );
          const workspaces = Object.fromEntries(
            Object.entries(p.workspaces ?? {}).map(([repoPath, ws]) => [
              repoPath,
              {
                ...ws,
                ...normalizeRightPanelState(
                  ws.rightTab ?? rightPanel.rightTab,
                  ws.rightTabByGroup ?? rightPanel.rightTabByGroup,
                ),
              },
            ]),
          );
          return { ...p, workspaces } as typeof persisted;
        }
        if (
          persisted &&
          typeof persisted === "object" &&
          fromVersion < 4
        ) {
          const p = persisted as {
            workspaces?: Record<string, PersistedWorkspaceState>;
            activeProject?: unknown;
            activeProjectFolderId?: unknown;
            projectFolders?: unknown;
            sessionFolderIds?: unknown;
          };
          const projectFolders = normalizePersistedProjectFolders(
            p.projectFolders,
            p.workspaces ?? {},
          );
          const activeProject =
            typeof p.activeProject === "string" ? p.activeProject : null;
          const activeProjectFolderId =
            typeof p.activeProjectFolderId === "string"
              ? p.activeProjectFolderId
              : activeProject
                ? defaultProjectFolderId(activeProject)
                : null;
          return {
            ...p,
            projectFolders,
            activeProjectFolderId,
            sessionFolderIds: normalizeStringRecord(p.sessionFolderIds),
          } as typeof persisted;
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
          const explicitViewMode = readWorkspaceViewMode(
            (ws as PersistedWorkspaceState).viewMode,
          );
          const explicitLocalViewMode = readWorkspaceViewMode(
            (ws as PersistedWorkspaceState).localViewMode,
          );
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
              activationHistory: activationHistoryFor(normalized, ids, active),
            };
          }
          const normalizedWorkspace: ProjectWorkspace = {
            ...ws,
            panes: newPanes,
            ...normalizeRightPanelState(
              (ws as PersistedWorkspaceState).rightTab ?? state.rightTab,
              (ws as PersistedWorkspaceState).rightTabByGroup ??
                state.rightTabByGroup,
            ),
          };
          if (explicitViewMode) {
            normalizedWorkspace.viewMode = explicitViewMode;
          } else {
            delete normalizedWorkspace.viewMode;
          }
          if (explicitLocalViewMode) {
            normalizedWorkspace.localViewMode = explicitLocalViewMode;
          } else {
            delete normalizedWorkspace.localViewMode;
          }
          sanitized[key] = normalizedWorkspace;
        }
        const projectFolders = normalizePersistedProjectFolders(
          state.projectFolders,
          sanitized,
        );
        state.projectFolders = projectFolders;
        state.workspaces = syncProjectWorkspaceViewModes(
          sanitized,
          projectFolders,
          state.activeProject,
          state.activeProjectFolderId,
        );
        state.sessionFolderIds = normalizeStringRecord(state.sessionFolderIds);
        state.autoCloseSessionIds = normalizeTrueRecord(
          state.autoCloseSessionIds,
        );
        state.sessionNotifications = normalizeSessionNotifications(
          state.sessionNotifications ?? [],
          useSettings.getState().settings.notifications.maxHistory,
        );
        state.activeProjectFolderId =
          state.activeProjectFolderId ??
          (state.activeProject
            ? defaultProjectFolderId(state.activeProject)
            : null);
        state.workspaceTabs = restoredTabs;
        Object.assign(
          state,
          mirrorActive(state.workspaces, activeWorkspaceId(state), state),
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

function normalizePersistedProjectFolders(
  value: unknown,
  workspaces: Record<string, unknown>,
): ProjectFoldersByRepo {
  const next: ProjectFoldersByRepo = {};
  if (value && typeof value === "object") {
    for (const [repoPath, rawFolders] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (!Array.isArray(rawFolders)) continue;
      const folders = rawFolders
        .map((raw) => normalizePersistedProjectFolder(raw, repoPath))
        .filter((folder): folder is ProjectFolder => folder !== null);
      if (folders.length > 0) next[repoPath] = sortProjectFolders(folders);
    }
  }
  for (const workspaceId of Object.keys(workspaces)) {
    if (workspaceId.startsWith("project-folder:")) continue;
    const repoPath = workspaceId;
    const folders = next[repoPath] ?? [];
    if (!folders.some((folder) => folder.id === defaultProjectFolderId(repoPath))) {
      next[repoPath] = sortProjectFolders([
        ...folders,
        {
          id: defaultProjectFolderId(repoPath),
          repoPath,
          name: DEFAULT_PROJECT_FOLDER_NAME,
          cwdPath: repoPath,
          position: 0,
        },
      ]);
    }
  }
  return next;
}

function normalizePersistedProjectFolder(
  raw: unknown,
  repoPath: string,
): ProjectFolder | null {
  if (!raw || typeof raw !== "object") return null;
  const folder = raw as Partial<ProjectFolder>;
  if (typeof folder.id !== "string" || folder.id.trim().length === 0) {
    return null;
  }
  const cwdPath =
    typeof folder.cwdPath === "string" && folder.cwdPath.trim().length > 0
      ? folder.cwdPath
      : repoPath;
  return {
    id: folder.id,
    repoPath,
    name:
      typeof folder.name === "string" && folder.name.trim().length > 0
        ? folder.name.trim()
        : basenamePath(cwdPath),
    cwdPath,
    position:
      typeof folder.position === "number" && Number.isFinite(folder.position)
        ? folder.position
        : folder.id === defaultProjectFolderId(repoPath)
          ? 0
          : Number.MAX_SAFE_INTEGER,
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function normalizeTrueRecord(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, true] => entry[1] === true,
    ),
  );
}
