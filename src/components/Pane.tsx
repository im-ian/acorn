import {
  Bot,
  BarChart3,
  Bell,
  BellOff,
  CircleX,
  Columns2,
  Copy,
  File as FileIcon,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MessageSquareText,
  Pencil,
  PencilLine,
  Sparkles,
  SplitSquareHorizontal,
  SplitSquareVertical,
  SquareX,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { selectSessionsById, useAppStore } from "../store";
import { FileViewer } from "./FileViewer";
import { mediaKindFromPath } from "../lib/mediaFiles";
import { writeClipboardText } from "../lib/clipboardText";
import { ChatPane } from "./ChatPane";
import { WorkSummaryView } from "./WorkSummaryView";
import { api } from "../lib/api";
import {
  buildAgentContextMenuItems,
  createEmptySessionAgentDetection,
} from "../lib/agentContextMenu";
import {
  AgentProviderIcon,
  buildAgentForkCommand,
  providerRequiresForkTranscriptPrep,
  resolveSessionAgentProvider,
} from "../lib/agentProvider";
import { requestNewAutonomousGoalSession } from "../lib/autonomousGoal";
import { cn } from "../lib/cn";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  hasConfiguredEditor,
  openInConfiguredEditor,
} from "../lib/editor";
import {
  formatHotkey,
  matchesHotkeyEvent,
  type HotkeyId,
} from "../lib/hotkeys";
import { EQUALIZE_PANES_EVENT } from "../lib/layoutEvents";
import { basename } from "../lib/pathUtils";
import {
  useSettings,
  resolveAiExecutionRequest,
  resolveSessionTitlePrompt,
} from "../lib/settings";
import {
  canRegenerateSessionTitle,
  canRenameSession,
} from "../lib/sessionTitle";
import { hasRecordedWorktree } from "../lib/sessionWorktree";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import {
  defaultProjectFolderId,
  isPathInsideOrEqual,
} from "../lib/projectFolders";
import {
  buildSessionCreateRequestFromScope,
  resolveProjectScopedForRepoPath,
  scopeForSession,
  type SessionCreateScope,
} from "../lib/sessionCreation";
import type { Direction, PaneId } from "../lib/layout";
import {
  registerPaneBodyFileDropTarget,
  registerTabStripFileDropTarget,
} from "../lib/fileDropTargets";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { PaneDropOverlay } from "./PaneDropOverlay";
import { SessionTitleGeneratingIndicator } from "./SessionTitleGeneratingIndicator";
import { Tooltip } from "./Tooltip";
import { StatusDot, type StatusTone } from "./ui";
import type {
  Project,
  Session,
  SessionAgentDetection,
  SessionAgentProvider,
  SessionKind,
  SessionStatus,
} from "../lib/types";
import {
  makeSessionWorkspaceTab,
  type CodeWorkspaceTab,
  type SessionWorkspaceTab,
  type WorkSummaryWorkspaceTab,
} from "../lib/workspaceTabs";
import {
  beginWorkspaceTabDrag,
  cancelWorkspaceTabDrag,
  finishWorkspaceTabDrag,
  registerWorkspaceTabDropTarget,
  updateWorkspaceTabDrag,
  useWorkspaceTabDragSession,
  type WorkspaceTabDragSession,
} from "../lib/workspaceTabDrag";

const SESSION_STATUS_TONE: Record<SessionStatus, StatusTone> = {
  ready: "neutral",
  working: "accent",
  waiting_for_input: "warning",
  errored: "danger",
};

const STATUS_ICON: Record<SessionStatus, string> = {
  ready: "text-fg-muted",
  working: "text-accent animate-pulse",
  waiting_for_input: "text-warning",
  errored: "text-danger",
};

const EMPTY_PANE_DOUBLE_SPACE_MS = 500;
const TAB_DRAG_START_THRESHOLD_PX = 6;

type PaneTranslationKey = Extract<TranslationKey, `pane.${string}`>;

function paneT(t: Translator, key: PaneTranslationKey): string {
  return t(key);
}

type PaneContextMenuGroup =
  | "session"
  | "fork"
  | "layout"
  | "open"
  | "copy"
  | "close";

function paneContextMenuGroupTitle(
  t: Translator,
  group: PaneContextMenuGroup,
): ContextMenuItem {
  return {
    type: "group-title",
    label: paneT(t, `pane.contextMenu.${group}`),
  };
}

function shortcutLabel(
  shortcuts: Record<HotkeyId, string>,
  id: HotkeyId,
): string {
  return formatHotkey(shortcuts[id]);
}

interface PaneProps {
  paneId: PaneId;
}

type PaneTab =
  | (SessionWorkspaceTab & { session: Session })
  | CodeWorkspaceTab
  | WorkSummaryWorkspaceTab;

/**
 * A single workspace pane. Hosts a tab strip and a body with the active
 * session's Terminal mounted. Tabs use pointer-based drag and the body is a
 * drop target for tab drags (via {@link PaneDropOverlay}).
 *
 * State (tab list, active session) lives in the global store keyed by
 * `paneId`. The pane itself only renders.
 */
export function Pane({ paneId }: PaneProps) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const pane = useAppStore((s) => s.panes[paneId]);
  const totalPanes = useAppStore((s) => Object.keys(s.panes).length);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const selectTab = useAppStore((s) => s.selectTab);
  const createSession = useAppStore((s) => s.createSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const closeWorkspaceTab = useAppStore((s) => s.closeWorkspaceTab);
  const openCodeViewerTab = useAppStore((s) => s.openCodeViewerTab);
  const updateCodeViewerTabViewState = useAppStore(
    (s) => s.updateCodeViewerTabViewState,
  );
  const openWorkSummaryTab = useAppStore((s) => s.openWorkSummaryTab);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitFocusedPane = useAppStore((s) => s.splitFocusedPane);
  const closePane = useAppStore((s) => s.closePane);
  const sessionsById = useAppStore(selectSessionsById);
  const workspaceViewMode = useAppStore((s) => s.workspaceViewMode);
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Pane body hosts the active session's Terminal via a portal target
  // `appendChild`-moved in by TerminalHost. The terminal is rendered at App
  // level, so its React fiber tree is a sibling of every pane — React
  // synthetic `onMouseDown` on this pane never fires for clicks inside the
  // terminal. Without this listener, clicking into a terminal leaves
  // `focusedPaneId` pointing at the previously focused pane, and split / tab
  // shortcuts (Cmd+Shift+D, Cmd+W, …) act on the wrong pane.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const handler = () => setFocusedPane(paneId);
    node.addEventListener("mousedown", handler);
    return () => node.removeEventListener("mousedown", handler);
  }, [paneId, setFocusedPane]);

  const workspaceTabs = useAppStore((s) => s.workspaceTabs);
  const tabs = useMemo<PaneTab[]>(() => {
    if (!pane) return [];
    const ordered: PaneTab[] = [];
    for (const id of pane.tabIds) {
      const s = sessionsById.get(id);
      if (s) {
        ordered.push({
          ...makeSessionWorkspaceTab({
            id: s.id,
            title: s.name,
            repoPath: s.repo_path,
          }),
          session: s,
        });
        continue;
      }
      const workspaceTab = workspaceTabs[id];
      if (workspaceTab?.kind === "code") {
        ordered.push({
          kind: "code",
          id: workspaceTab.id,
          title: workspaceTab.title,
          repoPath: workspaceTab.repoPath,
          lifecycle: workspaceTab.lifecycle,
          path: workspaceTab.path,
          target: workspaceTab.target,
          viewState: workspaceTab.viewState,
        });
      } else if (workspaceTab?.kind === "work-summary") {
        ordered.push({
          kind: "work-summary",
          id: workspaceTab.id,
          title: workspaceTab.title,
          repoPath: workspaceTab.repoPath,
          lifecycle: workspaceTab.lifecycle,
          cwdPath: workspaceTab.cwdPath,
          sessionId: workspaceTab.sessionId,
          tokenBaseline: workspaceTab.tokenBaseline,
        });
      }
    }
    return ordered;
  }, [pane, sessionsById, workspaceTabs]);

  const active = useMemo<PaneTab | null>(() => {
    if (!pane?.activeTabId) return null;
    return tabs.find((t) => t.id === pane.activeTabId) ?? null;
  }, [pane, tabs]);

  const isFocused = focusedPaneId === paneId;
  const lastEmptyPaneSpaceKeyDownAtRef = useRef<number | null>(null);
  const activeSession = active?.kind === "session" ? active.session : null;
  const activeSessionSilenced = useAppStore((s) =>
    activeSession ? Boolean(s.silencedSessionIds[activeSession.id]) : false,
  );
  const setSessionSilenced = useAppStore((s) => s.setSessionSilenced);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    return registerPaneBodyFileDropTarget(
      paneId,
      () => bodyRef.current?.getBoundingClientRect() ?? null,
    );
  }, [paneId]);

  function rootScopeForTab(tab: PaneTab): SessionCreateScope {
    if (tab.kind === "session") {
      return projectRootScopeForSession(tab.session, projects);
    }
    if (tab.kind === "work-summary" && tab.sessionId) {
      const session = sessionsById.get(tab.sessionId);
      if (session) return projectRootScopeForSession(session, projects);
    }
    const repoPath =
      tab.kind === "code"
        ? repoPathForCodeTabSession(tab, sessions)
        : tab.repoPath;
    const projectScoped = resolveProjectScopedForRepoPath(
      { sessions, projects },
      repoPath,
    );
    return {
      placement: {
        repoPath,
        projectScoped,
        ...(projectScoped
          ? { projectFolderId: defaultProjectFolderId(repoPath) }
          : {}),
      },
      launch: { kind: "projectRoot" },
    };
  }

  // Spawn a new session in the given project. Triggered by double-clicking
  // the empty pane body or the tab strip. `setFocusedPane` first so
  // `store.createSession` lands the new tab next to *this* pane's active
  // tab, then routes through the store wrapper for consistent placement
  // and selection (browser-style "next to active").
  async function spawnSession(
    repoPath: string,
    kind: SessionKind = "regular",
    scope: SessionCreateScope = {
      placement: {
        repoPath,
        projectScoped: resolveProjectScopedForRepoPath(
          { sessions, projects },
          repoPath,
        ),
      },
      launch: { kind: "projectRoot" },
    },
  ) {
    setFocusedPane(paneId);
    const request = buildSessionCreateRequestFromScope(
      { sessions, projects },
      scope,
      { kind },
    );
    const cwdPath =
      request.cwdPath === request.repoPath ? undefined : request.cwdPath;
    await createSession(
      request.name,
      request.repoPath,
      request.isolated,
      request.kind,
      request.agentProvider,
      request.projectScoped,
      request.mode,
      request.projectFolderId,
      cwdPath,
    );
    const error = useAppStore.getState().consumeError();
    if (error) showToast(`${t("toasts.session.createFailed")} ${error}`);
  }

  // Fork an existing agent conversation into a new Acorn session.
  // Inherits the parent's cwd and queues the explicit fork command into
  // the new shell's stdin so the user does not retype it. We bypass the
  // shim's fork-env branch deliberately — the shim may not even be on
  // PATH in the user's resolved shell (a kaku-style rc that prepends
  // user bin dirs buries it), so relying on a command line that maps to
  // the actual CLI flags works regardless of shim availability. The
  // user's existing `claude` alias (e.g. `--dangerously-skip-permissions`)
  // expands the first token, leaving our `--resume <id> --fork-session`
  // args intact.
  async function forkSession(
    parent: Session,
    kind: SessionAgentProvider,
    parentAgentId: string,
    isolated: boolean,
  ) {
    setFocusedPane(paneId);
    const request = buildSessionCreateRequestFromScope(
      { sessions, projects },
      scopeForSession(parent),
      { isolated, kind: "regular", agentProvider: kind },
    );
    try {
      const cwdPath =
        request.cwdPath === request.repoPath ? undefined : request.cwdPath;
      const created = await useAppStore.getState().createSession(
        request.name,
        request.repoPath,
        request.isolated,
        request.kind,
        request.agentProvider,
        request.projectScoped,
        request.mode,
        request.projectFolderId,
        cwdPath,
      );
      if (!created) return;
      // Claude resolves `--resume <uuid>` by looking under
      // `~/.claude/projects/<slug-of-cwd>/<uuid>.jsonl`.
      //
      // For a same-cwd fork (`isolated: false`) the new Acorn session
      // inherits `parent.repo_path` as its worktree, so the slug is
      // identical to the parent's and `claude --resume` finds the file
      // without any staging. We rely on `api.createSession` honouring
      // `isolated: false` by reusing the parent worktree path verbatim;
      // a future change there would silently break the same-cwd fork.
      //
      // For a new-worktree fork (`isolated: true`) the new worktree
      // lives under `.acorn/worktrees/<name>/` with a different slug,
      // so we stage a copy of the parent transcript into that slug
      // before queuing the resume. Codex stores rollouts cwd-
      // independently under `$CODEX_HOME/sessions/`, so neither branch
      // requires staging for codex.
      if (providerRequiresForkTranscriptPrep(kind) && isolated) {
        try {
          await api.prepareClaudeFork(parentAgentId, created.worktree_path);
        } catch (err) {
          console.error("[Pane] prepare_claude_fork failed", err);
        }
      }
      const command = buildAgentForkCommand(kind, parentAgentId);
      useAppStore.getState().setPendingTerminalInput(created.id, command, {
        agentProvider: kind,
      });
      await useAppStore.getState().refreshAll();
      selectTab(created.id);
    } catch (err) {
      console.error("[Pane] fork session failed", err);
      showToast(`${t("toasts.session.createFailed")} ${String(err)}`);
    }
  }

  async function handleNewTabFromStrip() {
    if (tabs.length === 0) return;
    const anchor = active ?? tabs[0];
    await spawnSession(anchor.repoPath, "regular", rootScopeForTab(anchor));
  }

  function creationScopeForPane(): SessionCreateScope | null {
    // Prefer the pane's project if any tabs exist (shouldn't here), else use
    // the globally active project. With no project at all, do nothing.
    const anchor = active ?? tabs[0] ?? null;
    if (anchor) return rootScopeForTab(anchor);

    const state = useAppStore.getState();
    const repoPath = state.activeProject;
    if (!repoPath) return null;
    const activeFolder = state.activeProjectFolderId
      ? Object.values(state.projectFolders)
          .flat()
          .find((folder) => folder.id === state.activeProjectFolderId)
      : null;
    const projectScoped = resolveProjectScopedForRepoPath(
      { sessions, projects },
      repoPath,
    );
    const activeFolderUsesProjectRoot =
      activeFolder &&
      sameWorkspacePath(activeFolder.cwdPath, activeFolder.repoPath);
    const activeFolderIsProjectWorktree =
      projectScoped &&
      activeFolder &&
      !activeFolderUsesProjectRoot;
    const projectFolderId = activeFolderIsProjectWorktree
      ? defaultProjectFolderId(repoPath)
      : activeFolder?.id;
    return {
      placement: {
        repoPath,
        projectScoped,
        projectFolderId,
      },
      launch:
        activeFolder && !activeFolderIsProjectWorktree
          ? { kind: "workspaceCwd", cwdPath: activeFolder.cwdPath }
          : { kind: "projectRoot" },
    };
  }

  async function handleNewTabFromEmpty() {
    const scope = creationScopeForPane();
    if (!scope) return;
    await spawnSession(
      scope.placement.repoPath,
      "regular",
      scope,
    );
  }

  const hasProjects = projects.length > 0;

  useEffect(() => {
    if (!isFocused || active || !hasProjects) {
      lastEmptyPaneSpaceKeyDownAtRef.current = null;
      return;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isNonTerminalTextEditingTarget(e.target)) return;
      if (!isSpaceKeyEvent(e) || e.repeat) {
        lastEmptyPaneSpaceKeyDownAtRef.current = null;
        return;
      }
      e.preventDefault();
      const now = e.timeStamp;
      const previous = lastEmptyPaneSpaceKeyDownAtRef.current;
      lastEmptyPaneSpaceKeyDownAtRef.current = now;
      if (previous !== null && now - previous <= EMPTY_PANE_DOUBLE_SPACE_MS) {
        lastEmptyPaneSpaceKeyDownAtRef.current = null;
        void handleNewTabFromEmpty();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, handleNewTabFromEmpty, hasProjects, isFocused]);

  const autonomousGoalScope = creationScopeForPane();

  return (
    <div
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-[var(--acorn-pane-radius)] border bg-bg transition-colors",
        isFocused ? "border-accent/60" : "border-border",
      )}
      data-pane-root={paneId}
      data-active-pane-indicator={isFocused ? paneId : undefined}
      onMouseDown={(e) => {
        if (e.button === 0 && isTabStripMouseDownTarget(e.target)) return;
        if (!isFocused) setFocusedPane(paneId);
      }}
    >
      {tabs.length > 0 ? (
        <TabStrip
          paneId={paneId}
          tabs={tabs}
          activeId={active?.id ?? null}
          onSelect={(id) => {
            setFocusedPane(paneId);
            selectTab(id);
          }}
          onClose={(id) => {
            const tab = tabs.find((t) => t.id === id);
            if (tab?.kind === "session") requestRemoveSession(id);
            else closeWorkspaceTab(id);
          }}
          onDropReorder={(payload, toIndex) => {
            moveTab({
              tabId: payload.tabId,
              fromPaneId: payload.fromPaneId,
              toPaneId: paneId,
              toIndex,
            });
          }}
          onNewTab={handleNewTabFromStrip}
          onSplitTab={(tabId, direction) => {
            // Move the tab into a fresh pane created on the right (horizontal)
            // or below (vertical) the current pane. Mirrors VS Code's
            // "Split Right / Split Down" command on a tab.
            moveTab({
              tabId,
              fromPaneId: paneId,
              toPaneId: paneId,
              splitDirection: direction,
              splitSide: "after",
            });
          }}
          onFork={(parent, kind, parentAgentId, isolated) => {
            void forkSession(parent, kind, parentAgentId, isolated);
          }}
        />
      ) : null}
      <div
        ref={bodyRef}
        className="relative min-h-0 flex-1"
        data-pane-body={paneId}
        onContextMenu={(e) => {
          // Only react when the body itself is right-clicked (not the
          // terminal output, which has its own native menu via xterm). The
          // terminal portal target sits inside this div, so we filter on the
          // event target identity.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          e.stopPropagation();
          setFocusedPane(paneId);
          setPaneMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/*
          The actual <Terminal> for the active session lives in <TerminalHost>
          at App level. It is portaled into a per-session target div which
          gets `appendChild`-moved into this pane body when this session is
          active. We render only an EmptyPane fallback here for the
          no-active-session case — or a FileViewer when the active tab is
          a frontend-owned file tab instead of a PTY session.
        */}
        {activeSession?.mode === "chat" ? (
          <ChatPane
            sessionId={activeSession.id}
            isActive={isFocused}
            repoPath={activeSession.worktree_path}
            session={activeSession}
          />
        ) : null}
        {active?.kind === "code" && workspaceViewMode === "panes" ? (
          <FileViewer
            key={active.id}
            path={active.path}
            target={active.target}
            viewState={active.viewState}
            onViewStateChange={(patch) =>
              updateCodeViewerTabViewState(active.id, patch)
            }
            isActive={isFocused}
          />
        ) : null}
        {active?.kind === "work-summary" && workspaceViewMode === "panes" ? (
          <WorkSummaryView
            tab={active}
            session={
              active.sessionId ? sessionsById.get(active.sessionId) ?? null : null
            }
            isActive={isFocused}
            onOpenFile={(path) => openCodeViewerTab(path, active.repoPath)}
          />
        ) : null}
        {active ? null : (
          <EmptyPane
            hasProjects={hasProjects}
            onDoubleClick={
              hasProjects
                ? handleNewTabFromEmpty
                : () =>
                    window.dispatchEvent(new CustomEvent("acorn:new-project"))
            }
            onContextMenu={(x, y) => {
              setFocusedPane(paneId);
              setPaneMenu({ x, y });
            }}
          />
        )}
        <PaneDropOverlay paneId={paneId} />
      </div>
      <ContextMenu
        open={paneMenu !== null}
        x={paneMenu?.x ?? 0}
        y={paneMenu?.y ?? 0}
        onClose={() => setPaneMenu(null)}
        items={buildPaneMenuItems({
          t,
          activeSession,
          totalPanes,
          paneId,
          onNewTab: () => void handleNewTabFromEmpty(),
          onSplit: splitFocusedPane,
          onClose: () => closePane(paneId),
          activeProjectFallback: useAppStore.getState().activeProject,
          onNewGoal:
            autonomousGoalScope?.placement.projectScoped === true
              ? () => requestNewAutonomousGoalSession(autonomousGoalScope)
              : undefined,
          shortcuts,
          activeSessionSilenced,
          setSessionSilenced,
          onOpenWorkSummary: activeSession
            ? () => void openWorkSummaryTab({ sessionId: activeSession.id })
            : undefined,
        })}
      />
    </div>
  );
}

function EmptyPane({
  hasProjects,
  onDoubleClick,
  onContextMenu,
}: {
  hasProjects: boolean;
  onDoubleClick: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const t = useTranslation();

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted hover:text-fg/80 transition cursor-pointer select-none"
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      role="button"
      tabIndex={0}
    >
      {hasProjects ? (
        <>
          <TerminalIcon size={28} className="opacity-40" />
          <p className="text-xs">
            {paneT(t, "pane.empty.dropTabOrDoubleClick")}
          </p>
        </>
      ) : (
        <>
          <FolderPlus size={28} className="opacity-40" />
          <p className="text-xs">
            {paneT(t, "pane.empty.createProject")}
          </p>
        </>
      )}
    </div>
  );
}

function isSpaceKeyEvent(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.key === " " || e.key === "Spacebar";
}

function isNonTerminalTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function sameWorkspacePath(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

function projectRootScopeForSession(
  session: Session,
  projects: readonly Project[],
): SessionCreateScope {
  const projectScoped = session.project_scoped !== false;
  const repoPath = repoPathForSessionRootLaunch(session, projects);
  if (!projectScoped) {
    return {
      placement: {
        repoPath,
        projectScoped: false,
      },
      launch: { kind: "projectRoot" },
    };
  }
  return {
    placement: {
      repoPath,
      projectScoped,
      projectFolderId: defaultProjectFolderId(repoPath),
    },
    launch: { kind: "projectRoot" },
  };
}

function repoPathForSessionRootLaunch(
  session: Session,
  projects: readonly Project[],
): string {
  if (session.project_scoped === false) return session.repo_path;
  const state = useAppStore.getState();
  const workspaceFolder = Object.values(state.projectFolders)
    .flat()
    .find(
      (folder) =>
        !sameWorkspacePath(folder.cwdPath, folder.repoPath) &&
        sameWorkspacePath(folder.cwdPath, session.worktree_path),
    );
  if (workspaceFolder) return workspaceFolder.repoPath;

  const containingProject = [...projects]
    .filter((project) =>
      isPathInsideOrEqual(session.worktree_path, project.repo_path),
    )
    .sort(
      (a, b) =>
        normalizeWorkspacePath(b.repo_path).length -
        normalizeWorkspacePath(a.repo_path).length,
    )[0];
  return containingProject?.repo_path ?? session.repo_path;
}

function repoPathForCodeTabSession(
  tab: CodeWorkspaceTab,
  sessions: readonly Session[],
): string {
  const exactSession = sessions.find((session) =>
    sameWorkspacePath(session.worktree_path, tab.repoPath),
  );
  if (exactSession) return exactSession.repo_path;

  const containingSession = [...sessions]
    .filter((session) => isPathInsideOrEqual(tab.path, session.worktree_path))
    .sort(
      (a, b) =>
        normalizeWorkspacePath(b.worktree_path).length -
        normalizeWorkspacePath(a.worktree_path).length,
    )[0];
  return containingSession?.repo_path ?? tab.repoPath;
}

function isTabStripMouseDownTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? target.closest("[data-pane-tab-strip]") !== null
    : false;
}

function isTabDragSuppressedTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? target.closest("[data-tab-close-button], [data-tab-rename-input]") !== null
    : false;
}

interface PointerPoint {
  x: number;
  y: number;
}

function distanceSquared(a: PointerPoint, b: PointerPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function rectContainsPoint(rect: DOMRect, point: PointerPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

interface TabStripProps {
  paneId: PaneId;
  tabs: PaneTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDropReorder: (
    payload: { tabId: string; fromPaneId: PaneId },
    toIndex: number,
  ) => void;
  onNewTab: () => void;
  onSplitTab: (tabId: string, direction: Direction) => void;
  onFork: (
    parent: Session,
    kind: SessionAgentProvider,
    parentAgentId: string,
    isolated: boolean,
  ) => void;
}

function TabStrip({
  paneId,
  tabs,
  activeId,
  onSelect,
  onClose,
  onDropReorder,
  onNewTab,
  onSplitTab,
  onFork,
}: TabStripProps) {
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabDrag = useWorkspaceTabDragSession();

  const computeInsertIndex = useCallback((clientX: number): number => {
    let idx = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const el = tabRefs.current.get(tabs[i].id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        idx = i;
        break;
      }
    }
    return idx;
  }, [tabs]);

  useEffect(() => {
    return registerTabStripFileDropTarget(
      paneId,
      () => stripRef.current?.getBoundingClientRect() ?? null,
    );
  }, [paneId]);

  useEffect(() => {
    return registerWorkspaceTabDropTarget({
      id: `tab-strip:${paneId}`,
      priority: 20,
      getRect: () => stripRef.current?.getBoundingClientRect() ?? null,
      onDrop: (payload, point) => {
        const idx = computeInsertIndex(point.x);
        if (payload.fromPaneId === paneId) {
          const currentIdx = tabs.findIndex((t) => t.id === payload.tabId);
          if (currentIdx === idx || currentIdx + 1 === idx) return;
        }
        onDropReorder(payload, idx);
      },
    });
  }, [computeInsertIndex, onDropReorder, paneId, tabs]);

  useEffect(() => {
    if (!tabDrag) {
      if (insertIndex !== null) setInsertIndex(null);
      return;
    }
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || !rectContainsPoint(rect, tabDrag.pointer)) {
      if (insertIndex !== null) setInsertIndex(null);
      return;
    }
    const next = computeInsertIndex(tabDrag.pointer.x);
    if (next !== insertIndex) setInsertIndex(next);
  }, [computeInsertIndex, insertIndex, tabDrag]);

  return (
    <div
      ref={stripRef}
      data-pane-tab-strip={paneId}
      className="acorn-no-scrollbar relative flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1 pt-px"
    >
      {tabs.map((tab, i) => (
        <TabItem
          key={tab.id}
          tab={tab}
          paneId={paneId}
          active={tab.id === activeId}
          insertBefore={insertIndex === i}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onCloseOthers={() => {
            for (const t of tabs) {
              if (t.id !== tab.id) onClose(t.id);
            }
          }}
          onCloseAll={() => {
            for (const t of tabs) onClose(t.id);
          }}
          onSplitTab={(direction) => onSplitTab(tab.id, direction)}
          onFork={
            tab.kind === "session"
              ? (kind, parentAgentId, isolated) =>
                  onFork(tab.session, kind, parentAgentId, isolated)
              : undefined
          }
          siblingCount={tabs.length}
          registerRef={(el) => {
            if (el) tabRefs.current.set(tab.id, el);
            else tabRefs.current.delete(tab.id);
          }}
        />
      ))}
      {insertIndex === tabs.length ? (
        <span className="my-1 w-0.5 self-stretch bg-accent" aria-hidden />
      ) : null}
      {/*
        Filler captures the empty stretch after the last tab so a double-click
        anywhere in that area opens a new session in the same project. Min
        width keeps it always present even when tabs fill the visible width
        (the strip scrolls horizontally, so the user can scroll past tabs
        and double-click here too).
      */}
      <div
        data-pane-tab-filler={paneId}
        className="min-w-[2.5rem] flex-1 self-stretch"
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return;
          onNewTab();
        }}
      />
    </div>
  );
}

function fileTabIcon(path: string) {
  switch (mediaKindFromPath(path)) {
    case "image":
      return FileImage;
    case "video":
      return FileVideo;
    case "audio":
      return FileAudio;
    case "pdf":
      return FileText;
    default:
      return FileIcon;
  }
}

interface TabItemProps {
  tab: PaneTab;
  paneId: PaneId;
  active: boolean;
  insertBefore: boolean;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onSplitTab: (direction: Direction) => void;
  onFork?: (
    kind: SessionAgentProvider,
    parentAgentId: string,
    isolated: boolean,
  ) => void;
  siblingCount: number;
  registerRef: (el: HTMLDivElement | null) => void;
}

function TabItem({
  tab,
  paneId,
  active,
  insertBefore,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSplitTab,
  onFork,
  siblingCount,
  registerRef,
}: TabItemProps) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const renameSession = useAppStore((s) => s.renameSession);
  const generateSessionTitle = useAppStore((s) => s.generateSessionTitle);
  const openWorkSummaryTab = useAppStore((s) => s.openWorkSummaryTab);
  const session = tab.kind === "session" ? tab.session : null;
  const sessionSilenced = useAppStore((s) =>
    session ? Boolean(s.silencedSessionIds[session.id]) : false,
  );
  const setSessionSilenced = useAppStore((s) => s.setSessionSilenced);
  const isGeneratingTitle = useAppStore((s) =>
    session ? Boolean(s.generatingSessionTitleIds[session.id]) : false,
  );
  const canRename = session
    ? canRenameSession(session, { isGeneratingTitle })
    : false;
  const canRegenerateTitle =
    session != null &&
    canRegenerateSessionTitle(session) &&
    !isGeneratingTitle;
  const agentProvider = session ? resolveSessionAgentProvider(session) : null;
  const tabPath =
    tab.kind === "session"
      ? tab.session.worktree_path
      : tab.kind === "code"
        ? tab.path
        : tab.cwdPath;
  const liveInWorktree = useAppStore((s) =>
    session ? s.liveInWorktree[session.id] : false,
  );
  const showWorktreeIcon = session
    ? Boolean(liveInWorktree ?? hasRecordedWorktree(session))
    : false;
  // Subscribe to the editor command so the menu's enabled/disabled state
  // updates immediately when the user configures an editor in Settings.
  const editorCommand = useSettings(
    (s) => s.settings.editor.command,
  );
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const editorConfigured = editorCommand.trim().length > 0;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const pendingDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextClickRef = useRef(false);
  const tabDrag = useWorkspaceTabDragSession();
  const isDraggingThisTab = tabDrag?.payload.tabId === tab.id;
  // Per-session agent detection result, refreshed each time the context
  // menu opens. Null while loading; the menu rebuilds when this resolves
  // so the Fork item gets the right label / enabled state.
  const [agent, setAgent] = useState<SessionAgentDetection | null>(null);

  useEffect(() => {
    if (!menu || !session) return;
    setAgent(null);
    let cancelled = false;
    api
      .detectSessionAgent(session.id)
      .then((res) => {
        if (!cancelled) setAgent(res);
      })
      .catch((err) => {
        console.error("[Pane.Fork] detect failed", {
          sessionId: session.id,
          err,
        });
        if (!cancelled) {
          setAgent(createEmptySessionAgentDetection());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [menu, session]);

  useEffect(() => {
    if (isGeneratingTitle && editing) setEditing(false);
  }, [editing, isGeneratingTitle]);

  useEffect(() => {
    return () => {
      pendingDragCleanupRef.current?.();
      pendingDragCleanupRef.current = null;
    };
  }, []);

  async function regenerateTitle() {
    if (!session) return;
    const settings = useSettings.getState().settings;
    const status = await generateSessionTitle(
      session.id,
      resolveAiExecutionRequest(settings),
      resolveSessionTitlePrompt(settings),
      true,
    );
    if (status === "not_ready") {
      showToast(t("toasts.session.titleNotReady"));
    } else if (status !== "generated") {
      showToast(t("toasts.session.titleRegenerateSkipped"));
    }
  }

  function onTabPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (
      e.button !== 0 ||
      isTabDragSuppressedTarget(e.target)
    ) {
      return;
    }

    pendingDragCleanupRef.current?.();
    const source = e.currentTarget;
    const rect = source.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const offset = {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    };
    const pointerId = e.pointerId;
    let dragging = false;

    const cleanup = () => {
      try {
        source.releasePointerCapture?.(pointerId);
      } catch {
        // The pointer may already be released if the tab moved or unmounted.
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", onWindowBlur);
      if (pendingDragCleanupRef.current === cleanup) {
        pendingDragCleanupRef.current = null;
      }
    };

    const clearClickSuppressionSoon = () => {
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    };

    const startDragging = (point: PointerPoint) => {
      dragging = true;
      suppressNextClickRef.current = true;
      if (editing) setEditing(false);
      beginWorkspaceTabDrag({
        payload: { tabId: tab.id, fromPaneId: paneId },
        title: tab.title,
        pointer: point,
        offset,
        sourceRect: { width: rect.width, height: rect.height },
      });
    };

    function onPointerMove(event: PointerEvent): void {
      if (event.pointerId !== pointerId) return;
      const point = { x: event.clientX, y: event.clientY };
      if (!dragging) {
        if (
          distanceSquared(point, start) <
          TAB_DRAG_START_THRESHOLD_PX ** 2
        ) {
          return;
        }
        startDragging(point);
      } else {
        updateWorkspaceTabDrag(point);
      }
      event.preventDefault();
    }

    function onPointerUp(event: PointerEvent): void {
      if (event.pointerId !== pointerId) return;
      cleanup();
      if (dragging) {
        event.preventDefault();
        event.stopPropagation();
        finishWorkspaceTabDrag({ x: event.clientX, y: event.clientY });
        clearClickSuppressionSoon();
      }
    }

    function onPointerCancel(event: PointerEvent): void {
      if (event.pointerId !== pointerId) return;
      cleanup();
      if (dragging) {
        event.preventDefault();
        cancelWorkspaceTabDrag();
        clearClickSuppressionSoon();
      }
    }

    function onWindowBlur(): void {
      cleanup();
      if (dragging) {
        cancelWorkspaceTabDrag();
        clearClickSuppressionSoon();
      }
    }

    pendingDragCleanupRef.current = cleanup;
    try {
      source.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic events and some webviews can reject capture; window
      // listeners still cover normal in-window dragging.
    }
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("blur", onWindowBlur);
  }

  const forkItems: ContextMenuItem[] = (() => {
    if (!agent || !onFork) return [];
    return buildAgentContextMenuItems({
      mode: "fork",
      surface: "pane",
      detection: agent,
      t,
      onFork,
    });
  })();

  const menuItems: ContextMenuItem[] = [
    ...(session
      ? ([
          paneContextMenuGroupTitle(t, "session"),
          {
            label: paneT(t, "pane.menu.rename"),
            icon: <Pencil size={12} />,
            onClick: () => setEditing(true),
            disabled: !canRename,
          },
          {
            label: paneT(t, "pane.menu.regenerateName"),
            icon: <Sparkles size={12} />,
            onClick: () => void regenerateTitle(),
            disabled: !canRegenerateTitle,
          },
          {
            label: paneT(t, "pane.menu.openWorkSummary"),
            icon: <BarChart3 size={12} />,
            onClick: () => void openWorkSummaryTab({ sessionId: session.id }),
          },
          {
            label: paneT(
              t,
              sessionSilenced
                ? "pane.menu.resumeNotifications"
                : "pane.menu.silenceNotifications",
            ),
            icon: sessionSilenced ? <Bell size={12} /> : <BellOff size={12} />,
            onClick: () =>
              setSessionSilenced(session.id, !sessionSilenced),
          },
        ] satisfies ContextMenuItem[])
      : []),
    ...(forkItems.length > 0
      ? [paneContextMenuGroupTitle(t, "fork"), ...forkItems]
      : []),
    paneContextMenuGroupTitle(t, "layout"),
    {
      label: paneT(t, "pane.menu.splitRight"),
      icon: <SplitSquareHorizontal size={12} />,
      shortcut: shortcutLabel(shortcuts, "splitVertical"),
      onClick: () => onSplitTab("horizontal"),
      disabled: siblingCount <= 1,
    },
    {
      label: paneT(t, "pane.menu.splitDown"),
      icon: <SplitSquareVertical size={12} />,
      shortcut: shortcutLabel(shortcuts, "splitHorizontal"),
      onClick: () => onSplitTab("vertical"),
      disabled: siblingCount <= 1,
    },
    {
      label: paneT(t, "pane.menu.equalizePaneSizes"),
      icon: <Columns2 size={12} />,
      shortcut: shortcutLabel(shortcuts, "equalizePanes"),
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
    },
    paneContextMenuGroupTitle(t, "open"),
    {
      label: session
        ? paneT(t, "pane.menu.openWorktreeInEditor")
        : tab.kind === "code"
          ? paneT(t, "pane.menu.openFileInEditor")
          : paneT(t, "pane.menu.openWorktreeInEditor"),
      icon: <PencilLine size={12} />,
      disabled: !editorConfigured,
      onClick: () => {
        void openInConfiguredEditor(tabPath).catch(
          (err: unknown) => {
            console.error("[Pane] open in editor failed", err);
          },
        );
      },
    },
    {
      label: paneT(t, "pane.menu.revealInFinder"),
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void api.fsReveal(tabPath).catch((err: unknown) => {
          console.error("[Pane] reveal in finder failed", err);
        });
      },
    },
    paneContextMenuGroupTitle(t, "copy"),
    {
      type: "submenu",
      label: paneT(t, "pane.menu.copy"),
      icon: <Copy size={12} />,
      children: [
        {
          label: session
            ? paneT(t, "pane.menu.worktreePath")
            : tab.kind === "code"
              ? paneT(t, "pane.menu.filePath")
              : paneT(t, "pane.menu.worktreePath"),
          icon: <Copy size={12} />,
          onClick: () => {
            void copyToClipboard(tabPath);
          },
        },
        {
          label: session
            ? paneT(t, "pane.menu.worktreeName")
            : tab.kind === "code"
              ? paneT(t, "pane.menu.fileName")
              : paneT(t, "pane.menu.worktreeName"),
          icon: <Copy size={12} />,
          onClick: () => {
            void copyToClipboard(basename(tabPath));
          },
        },
        ...(session
          ? [
              {
                label: paneT(t, "pane.menu.branchName"),
                icon: <Copy size={12} />,
                onClick: () => {
                  void copyToClipboard(session.branch);
                },
                disabled: !session.branch,
              },
              {
                label: paneT(t, "pane.menu.sessionId"),
                icon: <Copy size={12} />,
                onClick: () => {
                  void copyToClipboard(session.id);
                },
              },
            ]
          : []),
      ],
    },
    paneContextMenuGroupTitle(t, "close"),
    {
      label: paneT(t, "pane.menu.close"),
      icon: <X size={12} />,
      shortcut: shortcutLabel(shortcuts, "closeTab"),
      onClick: onClose,
    },
    ...(siblingCount > 1
      ? [
          {
            label: paneT(t, "pane.menu.closeOthers"),
            icon: <CircleX size={12} />,
            onClick: onCloseOthers,
          },
          {
            label: paneT(t, "pane.menu.closeAll"),
            icon: <SquareX size={12} />,
            onClick: onCloseAll,
          },
        ]
      : []),
  ];

  return (
    <>
      {insertBefore ? (
        <span className="my-1 w-0.5 self-stretch bg-accent" aria-hidden />
      ) : null}
      <div
        ref={registerRef}
        role="button"
        tabIndex={0}
        onPointerDown={onTabPointerDown}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClickCapture={(e) => {
          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onClick={editing ? undefined : onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (canRename) setEditing(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Activate the tab on right-click so the visible context matches the
          // menu target — mirrors VS Code / browser tab behavior.
          if (!active) onSelect();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (editing) return;
          if (matchesHotkeyEvent(shortcuts.renameItem, e)) {
            e.preventDefault();
            if (canRename) setEditing(true);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group relative flex h-7 min-w-[96px] shrink-0 cursor-pointer select-none items-center rounded-md pr-0.5 text-[13px] leading-5 transition",
          isDraggingThisTab && "opacity-40",
          active
            ? "acorn-tab-active-bg text-fg"
            : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
        )}
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2"
          data-tab-drag-handle={tab.id}
        >
          {isGeneratingTitle ? (
            <SessionTitleGeneratingIndicator
              label={paneT(t, "pane.aria.generatingSessionTitle")}
            />
          ) : tab.kind === "work-summary" ? (
            <Tooltip label={paneT(t, "pane.aria.workSummary")} side="bottom">
              <BarChart3
                size={12}
                className="pointer-events-none shrink-0 text-accent"
              />
            </Tooltip>
          ) : session?.goal ? (
            <Tooltip label={paneT(t, "pane.aria.goalSession")} side="bottom">
              <Sparkles
                size={12}
                className={cn(
                  "pointer-events-none shrink-0",
                  session && STATUS_ICON[session.status],
                )}
              />
            </Tooltip>
          ) : session?.mode === "chat" ? (
            <Tooltip label={paneT(t, "pane.aria.chatSession")} side="bottom">
              <MessageSquareText
                size={12}
                className={cn(
                  "pointer-events-none shrink-0",
                  session && STATUS_ICON[session.status],
                )}
              />
            </Tooltip>
          ) : agentProvider ? (
            <Tooltip label={agentProvider} side="bottom">
              <AgentProviderIcon
                provider={agentProvider}
                className={cn(
                  "pointer-events-none size-2.5",
                  session && STATUS_ICON[session.status],
                )}
              />
            </Tooltip>
          ) : tab.kind === "code" ? (
            <Tooltip label={tabPath} side="bottom">
              {(() => {
                const TabFileIcon = fileTabIcon(tab.path);
                return (
                  <TabFileIcon
                    size={12}
                    className="pointer-events-none shrink-0 text-fg-muted"
                  />
                );
              })()}
            </Tooltip>
          ) : (
            <StatusDot
              tone={session ? SESSION_STATUS_TONE[session.status] : "neutral"}
              size="sm"
              pulse={session?.status === "working"}
              className={cn(
                "pointer-events-none",
                !session && "opacity-70",
              )}
            />
          )}
          {editing ? (
            <TabRenameInput
              initial={tab.title}
              onSubmit={async (next) => {
                setEditing(false);
                if (session && canRename && next && next !== session.name) {
                  await renameSession(session.id, next);
                  const error = useAppStore.getState().consumeError();
                  if (error) {
                    showToast(`${t("toasts.session.renameFailed")} ${error}`);
                  }
                }
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span
              className="pointer-events-none max-w-[12rem] truncate leading-5"
            >
              {tab.title}
            </span>
          )}
          {showWorktreeIcon ? (
            <GitBranch
              size={10}
              className="pointer-events-none shrink-0 text-fg-muted"
              aria-label={paneT(t, "pane.aria.worktree")}
            />
          ) : null}
          {session?.kind === "control" ? (
            <Bot
              size={10}
              className="pointer-events-none shrink-0 text-accent"
              aria-label={paneT(t, "pane.aria.controlSession")}
            />
          ) : null}
          {sessionSilenced ? (
            <span
              className="pointer-events-none inline-flex shrink-0 text-fg-muted"
              aria-label={paneT(t, "pane.aria.notificationsSilenced")}
              title={paneT(t, "pane.aria.notificationsSilenced")}
            >
              <BellOff size={10} aria-hidden />
            </span>
          ) : null}
        </div>
        <Tooltip
          label={
            session
              ? paneT(t, "pane.aria.closeSession")
              : paneT(t, "pane.aria.closeTab")
          }
          shortcut={shortcutLabel(shortcuts, "closeTab")}
          side="bottom"
        >
          <button
            type="button"
            aria-label={
              session
                ? paneT(t, "pane.aria.closeSession")
                : paneT(t, "pane.aria.closeTab")
            }
            data-tab-close-button={tab.id}
            draggable={false}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              "ml-0.5 flex size-6 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-bg-sidebar hover:text-fg",
              active
                ? "opacity-70 hover:opacity-100"
                : "opacity-0 group-hover:opacity-70 hover:opacity-100",
            )}
          >
            <X size={11} />
          </button>
        </Tooltip>
        {isDraggingThisTab ? (
          <WorkspaceTabDragGhost
            drag={tabDrag}
            tab={tab}
            session={session}
            agentProvider={agentProvider}
            isGeneratingTitle={isGeneratingTitle}
            generatingLabel={paneT(t, "pane.aria.generatingSessionTitle")}
            showWorktreeIcon={showWorktreeIcon}
          />
        ) : null}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={menuItems}
      />
    </>
  );
}

function WorkspaceTabDragGhost({
  drag,
  tab,
  session,
  agentProvider,
  isGeneratingTitle,
  generatingLabel,
  showWorktreeIcon,
}: {
  drag: WorkspaceTabDragSession;
  tab: PaneTab;
  session: Session | null;
  agentProvider: SessionAgentProvider | null;
  isGeneratingTitle: boolean;
  generatingLabel: string;
  showWorktreeIcon: boolean;
}) {
  return createPortal(
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed z-[9999] flex items-center gap-1.5 border px-3 text-[13px] leading-5 text-fg opacity-95 shadow-2xl",
        "border-border bg-bg-elevated",
      )}
      style={{
        left: drag.pointer.x - drag.offset.x,
        top: drag.pointer.y - drag.offset.y,
        width: drag.sourceRect.width,
        height: drag.sourceRect.height,
      }}
    >
      {isGeneratingTitle ? (
        <SessionTitleGeneratingIndicator label={generatingLabel} />
      ) : session?.mode === "chat" ? (
        <MessageSquareText
          size={12}
          className={cn(
            "pointer-events-none shrink-0",
            session && STATUS_ICON[session.status],
          )}
        />
      ) : agentProvider ? (
        <AgentProviderIcon
          provider={agentProvider}
          className={cn(
            "pointer-events-none size-2.5",
            session && STATUS_ICON[session.status],
          )}
        />
      ) : tab.kind === "code" ? (
        (() => {
          const TabFileIcon = fileTabIcon(tab.path);
          return (
            <TabFileIcon
              size={11}
              className="pointer-events-none shrink-0 text-fg-muted"
            />
          );
        })()
      ) : (
        <StatusDot
          tone={session ? SESSION_STATUS_TONE[session.status] : "neutral"}
          size="sm"
          pulse={session?.status === "working"}
          className={cn(
            "pointer-events-none",
            !session && "opacity-70",
          )}
        />
      )}
      <span className="min-w-0 truncate">{drag.title}</span>
      {showWorktreeIcon ? (
        <GitBranch
          size={10}
          className="pointer-events-none shrink-0 text-fg-muted"
        />
      ) : null}
      {session?.kind === "control" ? (
        <Bot
          size={10}
          className="pointer-events-none shrink-0 text-accent"
        />
      ) : null}
    </div>,
    document.body,
  );
}

interface TabRenameInputProps {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function TabRenameInput({ initial, onSubmit, onCancel }: TabRenameInputProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      data-tab-rename-input
      autoFocus
      value={value}
      draggable={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onSubmit(value.trim())}
      className="w-32 min-w-0 rounded border border-accent bg-input px-1 text-xs text-fg outline-none"
    />
  );
}

function buildPaneMenuItems({
  t,
  activeSession,
  totalPanes,
  paneId: _paneId,
  onNewTab,
  onSplit,
  onClose,
  activeProjectFallback,
  onNewGoal,
  shortcuts,
  activeSessionSilenced,
  setSessionSilenced,
  onOpenWorkSummary,
}: {
  t: Translator;
  activeSession: Session | null;
  totalPanes: number;
  paneId: PaneId;
  onNewTab: () => void;
  onSplit: (direction: Direction) => void;
  onClose: () => void;
  activeProjectFallback: string | null;
  onNewGoal?: () => void;
  shortcuts: Record<HotkeyId, string>;
  activeSessionSilenced: boolean;
  setSessionSilenced: (sessionId: string, silenced: boolean) => void;
  onOpenWorkSummary?: () => void;
}): ContextMenuItem[] {
  const editorReady = hasConfiguredEditor();
  const worktreeItems: ContextMenuItem[] = activeSession
    ? [
        { type: "separator" },
        ...(onOpenWorkSummary
          ? [
              {
                label: paneT(t, "pane.menu.openWorkSummary"),
                icon: <BarChart3 size={12} />,
                onClick: onOpenWorkSummary,
              },
            ]
          : []),
        {
          label: paneT(
            t,
            activeSessionSilenced
              ? "pane.menu.resumeNotifications"
              : "pane.menu.silenceNotifications",
          ),
          icon: activeSessionSilenced ? (
            <Bell size={12} />
          ) : (
            <BellOff size={12} />
          ),
          onClick: () =>
            setSessionSilenced(activeSession.id, !activeSessionSilenced),
        },
        {
          label: paneT(t, "pane.menu.openWorktreeInEditor"),
          icon: <PencilLine size={12} />,
          disabled: !editorReady,
          onClick: () => {
            void openInConfiguredEditor(activeSession.worktree_path).catch(
              (err: unknown) => {
                console.error("[Pane] open in editor failed", err);
              },
            );
          },
        },
        {
          label: paneT(t, "pane.menu.revealInFinder"),
          icon: <FolderOpen size={12} />,
          onClick: () => {
            void api.fsReveal(activeSession.worktree_path).catch(
              (err: unknown) => {
                console.error("[Pane] reveal failed", err);
              },
            );
          },
        },
        { type: "separator" },
        {
          label: paneT(t, "pane.menu.copyWorktreePath"),
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(activeSession.worktree_path),
        },
        {
          label: paneT(t, "pane.menu.copyWorktreeName"),
          icon: <Copy size={12} />,
          onClick: () =>
            void copyToClipboard(basename(activeSession.worktree_path)),
        },
      ]
    : [];

  return [
    {
      label: paneT(t, "pane.menu.newSessionInThisPane"),
      icon: <TerminalIcon size={12} />,
      shortcut: shortcutLabel(shortcuts, "newSession"),
      onClick: onNewTab,
      disabled: !activeSession && activeProjectFallback === null,
    },
    ...(onNewGoal
      ? [
          {
            label: paneT(t, "pane.menu.newGoalSessionInThisPane"),
            icon: <Sparkles size={12} />,
            onClick: onNewGoal,
          },
        ]
      : []),
    { type: "separator" },
    {
      label: paneT(t, "pane.menu.splitRight"),
      icon: <SplitSquareHorizontal size={12} />,
      shortcut: shortcutLabel(shortcuts, "splitVertical"),
      onClick: () => onSplit("horizontal"),
    },
    {
      label: paneT(t, "pane.menu.splitDown"),
      icon: <SplitSquareVertical size={12} />,
      shortcut: shortcutLabel(shortcuts, "splitHorizontal"),
      onClick: () => onSplit("vertical"),
    },
    {
      label: paneT(t, "pane.menu.equalizePaneSizes"),
      icon: <Columns2 size={12} />,
      shortcut: shortcutLabel(shortcuts, "equalizePanes"),
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
      disabled: totalPanes <= 1,
    },
    ...worktreeItems,
    { type: "separator" },
    {
      label: paneT(t, "pane.menu.closePane"),
      icon: <X size={12} />,
      shortcut: shortcutLabel(shortcuts, "closeEmptyPane"),
      onClick: onClose,
      disabled: totalPanes <= 1,
    },
  ];
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch (err) {
    console.warn("[Pane] clipboard write failed", err);
  }
}
