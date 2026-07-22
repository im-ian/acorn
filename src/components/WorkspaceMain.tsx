import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  BarChart3,
  Bell,
  BellOff,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock,
  Columns3,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  LocateFixed,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Pencil,
  PencilLine,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  Terminal as TerminalIcon,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { api } from "../lib/api";
import { writeClipboardText } from "../lib/clipboardText";
import { requestNewAutonomousGoalSession } from "../lib/autonomousGoal";
import { cn } from "../lib/cn";
import { openInConfiguredEditor } from "../lib/editor";
import { isInAcornFloatingLayer } from "../lib/floatingLayer";
import { formatHotkey, matchesHotkeyEvent } from "../lib/hotkeys";
import type { LayoutNode } from "../lib/layout";
import { basename } from "../lib/pathUtils";
import { pullRequestNumberClassName } from "../lib/pullRequestPresentation";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  PROJECT_SESSION_CREATE_MENU,
  type DirectProjectSessionCreateAction,
  type ProjectSessionCreateAction,
} from "../lib/projectSessionCreateActions";
import {
  canRegenerateSessionTitle,
  canRenameSession,
} from "../lib/sessionTitle";
import type {
  PullRequestInfo,
  Session,
  SessionPullRequestSummary,
  SessionStatus,
  SessionStatusReason,
} from "../lib/types";
import {
  summarizeAllSessionProcesses,
  summarizeSessionProcesses,
} from "../lib/sessionContext";
import { useCurrentPullRequest } from "../lib/useCurrentPullRequest";
import {
  AgentProviderIcon,
  resolveSessionAgentProvider,
} from "../lib/agentProvider";
import {
  resolveAiExecutionRequest,
  resolveSessionTitlePrompt,
  useSettings,
} from "../lib/settings";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { isWorkspaceTabId } from "../lib/workspaceTabs";
import {
  KANBAN_COLUMN_DEFAULT_WIDTH,
  clampKanbanColumnWidth,
  defaultKanbanColumnWidths,
  equalizeKanbanColumnWidths,
  readKanbanBoardPrefs,
  sessionMatchesKanbanFilter,
  sortKanbanSessions,
  toKanbanSortMode,
  writeKanbanBoardPrefs,
  type KanbanBoardPrefs,
  type KanbanSortMode,
} from "../lib/kanbanBoard";
import {
  EMPTY_KANBAN_STAGE_CONTEXT,
  KANBAN_LIFECYCLE_STAGES,
  deriveKanbanStage,
  formatKanbanDwell,
  isKanbanSessionStalled,
  updateKanbanStageDwell,
  type KanbanLifecycleStage,
  type KanbanStageContext,
  type KanbanStageDwell,
} from "../lib/kanbanLifecycle";
import {
  useKanbanBoardData,
  type KanbanSessionBoardData,
} from "../lib/useKanbanBoardData";
import {
  selectSessionsById,
  useAppStore,
  type WorkspaceViewMode,
} from "../store";
import { IconButton, StatusDot, type StatusTone } from "./ui";
import { ChatPane } from "./ChatPane";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FileViewer } from "./FileViewer";
import { LayoutRenderer } from "./LayoutRenderer";
import { PullRequestDetailModal } from "./PullRequestDetailModal";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";
import { WorkspaceCanvas } from "./WorkspaceCanvas";
import { WorkSummaryView } from "./WorkSummaryView";

const STATUS_TONE: Record<SessionStatus, StatusTone> = {
  ready: "neutral",
  working: "accent",
  waiting_for_input: "warning",
  errored: "danger",
};

const KANBAN_STAGE_TONE: Record<KanbanLifecycleStage, StatusTone> = {
  idle: "neutral",
  working: "accent",
  waiting: "warning",
  review: "success",
  done: "neutral",
};

// Pair each lifecycle stage (ordered by `kanbanLifecycle.ts`, the single
// source of truth for column order) with its UI tone.
const KANBAN_COLUMNS: ReadonlyArray<{
  stage: KanbanLifecycleStage;
  tone: StatusTone;
}> = KANBAN_LIFECYCLE_STAGES.map((stage) => ({
  stage,
  tone: KANBAN_STAGE_TONE[stage],
}));

/** Re-render cadence for dwell labels and stall detection. */
const KANBAN_CLOCK_TICK_MS = 30_000;

interface KanbanConversationPreview {
  userMessage?: string;
  agentMessage?: string;
  fallbackMessage?: string;
}

function trimPreviewMessage(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function kanbanConversationPreview(session: Session): KanbanConversationPreview {
  return {
    userMessage: trimPreviewMessage(session.last_user_message),
    agentMessage: trimPreviewMessage(session.last_agent_message),
    fallbackMessage: trimPreviewMessage(session.last_message),
  };
}

const STATUS_ICON_CLASS: Record<SessionStatus, string> = {
  ready: "text-fg-muted",
  working: "text-accent",
  waiting_for_input: "text-warning",
  errored: "text-danger",
};

type SidebarTranslationKey = Extract<TranslationKey, `sidebar.${string}`>;
type WorkspaceKanbanContextGroup = "session" | "open" | "copy" | "danger";

const KANBAN_COLUMN_GAP_PX = 6;
const KANBAN_PREFS_WRITE_DEBOUNCE_MS = 200;
const KANBAN_BOARD_PADDING_X_PX = 16;
const KANBAN_TERMINAL_POPOVER_DEFAULT_WIDTH_PX = 560;
const KANBAN_TERMINAL_POPOVER_DEFAULT_HEIGHT_PX = 420;
const KANBAN_TERMINAL_POPOVER_MIN_WIDTH_PX = 360;
const KANBAN_TERMINAL_POPOVER_MIN_HEIGHT_PX = 260;
const KANBAN_TERMINAL_POPOVER_SIZE_STORAGE_KEY =
  "acorn:kanban-terminal-popover-size";
const KANBAN_TERMINAL_POPOVER_GAP_PX = 8;
const KANBAN_TERMINAL_POPOVER_MARGIN_PX = 8;

interface KanbanTerminalPopoverSize {
  width: number;
  height: number;
}

interface KanbanTerminalPopoverPosition {
  left: number;
  top: number;
}

interface WorkspaceMainProps {
  layout: LayoutNode;
  viewMode: WorkspaceViewMode;
}

export function WorkspaceMain({ layout, viewMode }: WorkspaceMainProps) {
  const isKanban = viewMode === "kanban";
  const isCanvas = viewMode === "canvas";
  const panes = useAppStore((s) => s.panes);
  const sessionsById = useAppStore(selectSessionsById);
  const workspaceId = useAppStore(
    (s) => s.activeProjectFolderId ?? s.activeProject,
  );
  const closeTerminalPopup = useAppStore((s) => s.closeTerminalPopup);
  const workspaceSessionIds = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const pane of Object.values(panes)) {
      for (const id of pane.tabIds) {
        if (seen.has(id) || isWorkspaceTabId(id)) continue;
        seen.add(id);
        ordered.push(id);
      }
    }
    return ordered;
  }, [panes]);
  const sessions = useMemo(() => {
    const ordered: Session[] = [];
    for (const id of workspaceSessionIds) {
      const session = sessionsById.get(id);
      if (session) ordered.push(session);
    }
    return ordered;
  }, [sessionsById, workspaceSessionIds]);
  const [prRefreshKey, setPrRefreshKey] = useState(0);
  const boardData = useKanbanBoardData(sessions, prRefreshKey, {
    pollDiffs: isKanban,
  });

  useEffect(() => {
    if (!isKanban && !isCanvas) closeTerminalPopup();
  }, [closeTerminalPopup, isCanvas, isKanban]);

  return (
    <div className="h-full min-w-0 overflow-hidden" data-workspace-main>
      {isKanban ? (
        <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1">
            <WorkspaceKanbanBoard
              sessions={sessions}
              boardData={boardData}
              onPullRequestsMutated={() =>
                setPrRefreshKey((key) => key + 1)
              }
            />
          </div>
          <WorkspaceTabPreviewOverlay />
        </div>
      ) : null}
      {isCanvas ? (
        <div className="relative h-full min-w-0 overflow-hidden">
          <WorkspaceCanvas
            key={workspaceId ?? "__local__"}
            workspaceId={workspaceId}
            workspaceSessionIds={workspaceSessionIds}
            sessions={sessions}
          />
          <CanvasTerminalPopoverOverlay sessions={sessions} />
          <WorkspaceTabPreviewOverlay />
        </div>
      ) : null}
      {/*
        Keep the pane layout mounted (hidden) in alternate views instead of
        unmounting it. TerminalHost appendChild's each live terminal's target
        div into a pane body; unmounting the layout orphans those divs, so
        returning to panes shows blank terminals until an unrelated reattach.
        Hiding preserves the pane-body DOM identity so the terminals stay put.
      */}
      <div
        className={cn("h-full min-w-0", viewMode !== "panes" && "hidden")}
      >
        <LayoutRenderer node={layout} />
      </div>
    </div>
  );
}

function CanvasTerminalPopoverOverlay({
  sessions,
}: {
  sessions: readonly Session[];
}) {
  const terminalPopupSessionId = useAppStore((s) => s.terminalPopupSessionId);
  const closeTerminalPopup = useAppStore((s) => s.closeTerminalPopup);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const session = terminalPopupSessionId
    ? sessions.find((candidate) => candidate.id === terminalPopupSessionId) ??
      null
    : null;

  useLayoutEffect(() => {
    if (!terminalPopupSessionId) {
      setAnchor((current) => (current ? null : current));
      return;
    }
    if (!session) {
      closeTerminalPopup();
      return;
    }
    const nextAnchor = document.querySelector<HTMLElement>(
      `[data-canvas-session-id="${cssAttributeEscape(terminalPopupSessionId)}"]`,
    );
    if (!nextAnchor) {
      closeTerminalPopup();
      return;
    }
    setAnchor((current) => (current === nextAnchor ? current : nextAnchor));
  }, [closeTerminalPopup, session, terminalPopupSessionId]);

  const close = useCallback(() => {
    const returnFocus = anchor?.querySelector<HTMLElement>(
      '[data-testid="workspace-canvas-node-expand"]',
    );
    closeTerminalPopup();
    setAnchor(null);
    if (returnFocus) requestAnimationFrame(() => returnFocus.focus());
  }, [anchor, closeTerminalPopup]);

  return session && anchor ? (
    <KanbanTerminalPopover
      session={session}
      anchor={anchor}
      onClose={close}
    />
  ) : null;
}

function WorkspaceTabPreviewOverlay() {
  const t = useTranslation();
  const closeShortcut = useSettings((s) =>
    formatHotkey(s.settings.shortcuts.closeTab),
  );
  const activeTabId = useAppStore((s) => s.activeTabId);
  const workspaceTabs = useAppStore((s) => s.workspaceTabs);
  const sessionsById = useAppStore(selectSessionsById);
  const closeWorkspaceTab = useAppStore((s) => s.closeWorkspaceTab);
  const closeTerminalPopup = useAppStore((s) => s.closeTerminalPopup);
  const openCodeViewerTab = useAppStore((s) => s.openCodeViewerTab);
  const updateCodeViewerTabViewState = useAppStore(
    (s) => s.updateCodeViewerTabViewState,
  );
  const tab = activeTabId ? workspaceTabs[activeTabId] : undefined;

  useEffect(() => {
    if (tab) closeTerminalPopup();
  }, [closeTerminalPopup, tab?.id, tab?.kind]);

  if (!tab) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-bg/45 p-4 backdrop-blur-[1px]"
      data-testid={
        tab.kind === "code"
          ? "kanban-file-preview-overlay"
          : "workspace-work-summary-overlay"
      }
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeWorkspaceTab(tab.id);
      }}
    >
      <section
        role="dialog"
        aria-label={tab.title}
        className="flex h-[min(760px,calc(100%-2rem))] w-[min(980px,calc(100%-2rem))] min-w-0 flex-col overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-sidebar/70 px-3">
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
            {tab.title}
          </div>
          <Tooltip
            label={t("dialogs.common.close")}
            shortcut={closeShortcut}
            side="bottom"
          >
            <IconButton
              aria-label={t("dialogs.common.close")}
              onClick={() => closeWorkspaceTab(tab.id)}
            >
              <X size={13} />
            </IconButton>
          </Tooltip>
        </header>
        <div className="min-h-0 flex-1">
          {tab.kind === "code" ? (
            <FileViewer
              key={tab.id}
              path={tab.path}
              target={tab.target}
              viewState={tab.viewState}
              onViewStateChange={(patch) =>
                updateCodeViewerTabViewState(tab.id, patch)
              }
              isActive
            />
          ) : (
            <WorkSummaryView
              key={tab.id}
              tab={tab}
              session={
                tab.sessionId ? sessionsById.get(tab.sessionId) ?? null : null
              }
              isActive
              onOpenFile={(path) => openCodeViewerTab(path, tab.repoPath)}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function WorkspaceKanbanBoard({
  sessions,
  boardData,
  onPullRequestsMutated,
}: {
  sessions: readonly Session[];
  boardData: ReadonlyMap<string, KanbanSessionBoardData>;
  onPullRequestsMutated: () => void;
}) {
  // Remount per project so each board hydrates its own persisted prefs through
  // the useState initializer rather than racing an effect to swap them in.
  const projectId = useAppStore((s) => s.activeProject);
  return (
    <KanbanBoard
      key={projectId ?? "__no-project__"}
      projectId={projectId}
      sessions={sessions}
      boardData={boardData}
      onPullRequestsMutated={onPullRequestsMutated}
    />
  );
}

function KanbanBoard({
  projectId,
  sessions,
  boardData,
  onPullRequestsMutated,
}: {
  projectId: string | null;
  sessions: readonly Session[];
  boardData: ReadonlyMap<string, KanbanSessionBoardData>;
  onPullRequestsMutated: () => void;
}) {
  const t = useTranslation();
  const sessionsById = useAppStore(selectSessionsById);
  const selectSession = useAppStore((s) => s.selectSession);
  const openTerminalPopup = useAppStore((s) => s.openTerminalPopup);
  const closeTerminalPopup = useAppStore((s) => s.closeTerminalPopup);
  const terminalPopupSessionId = useAppStore((s) => s.terminalPopupSessionId);
  const [prefs, setPrefs] = useState<KanbanBoardPrefs>(() =>
    readKanbanBoardPrefs(projectId),
  );
  const [terminalPopover, setTerminalPopover] = useState<{
    sessionId: string;
    anchor: HTMLElement;
  } | null>(null);
  const { filterQuery, sortMode, columnWidths } = prefs;
  const [resizingColumnIndex, setResizingColumnIndex] = useState<number | null>(
    null,
  );
  const columnResizeCleanupRef = useRef<(() => void) | null>(null);

  const visibleSessions = useMemo(
    () =>
      sortKanbanSessions(
        sessions.filter((session) =>
          sessionMatchesKanbanFilter(session, filterQuery),
        ),
        sortMode,
      ),
    [filterQuery, sessions, sortMode],
  );

  // Clock for dwell labels and stall badges. Coarse on purpose — nothing on
  // the board needs sub-30s freshness.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(
      () => setNow(Date.now()),
      KANBAN_CLOCK_TICK_MS,
    );
    return () => window.clearInterval(handle);
  }, []);

  const [prDetail, setPrDetail] = useState<{
    repoPath: string;
    number: number;
  } | null>(null);

  const openPullRequestDetail = useCallback(
    (repoPath: string, number: number) => {
      setPrDetail({ repoPath, number });
    },
    [],
  );

  const manualDoneSessionIds = prefs.manualDoneSessionIds;
  const manualDoneSet = useMemo(
    () => new Set(manualDoneSessionIds),
    [manualDoneSessionIds],
  );
  const toggleManualDone = useCallback((sessionId: string) => {
    setPrefs((current) => {
      const ids = new Set(current.manualDoneSessionIds);
      if (ids.has(sessionId)) ids.delete(sessionId);
      else ids.add(sessionId);
      return { ...current, manualDoneSessionIds: [...ids] };
    });
  }, []);

  const stageContextBySession = useMemo(() => {
    const contexts = new Map<string, KanbanStageContext>();
    for (const session of sessions) {
      const data = boardData.get(session.id);
      contexts.set(session.id, {
        pr: data?.pr ?? null,
        manualDone: manualDoneSet.has(session.id),
      });
    }
    return contexts;
  }, [boardData, manualDoneSet, sessions]);

  // Stages derive from every session (not just visible ones) so filtering the
  // board never resets a session's dwell clock.
  const stageBySession = useMemo(() => {
    const stages = new Map<string, KanbanLifecycleStage>();
    for (const session of sessions) {
      stages.set(
        session.id,
        deriveKanbanStage(
          session,
          stageContextBySession.get(session.id) ?? EMPTY_KANBAN_STAGE_CONTEXT,
        ),
      );
    }
    return stages;
  }, [sessions, stageContextBySession]);

  const dwellRef = useRef<Map<string, KanbanStageDwell>>(new Map());
  const dwellBySession = useMemo(() => {
    const next = updateKanbanStageDwell(
      dwellRef.current,
      stageBySession,
      Date.now(),
    );
    dwellRef.current = next;
    return next;
  }, [stageBySession]);

  const sessionsByStage = useMemo(() => {
    const grouped = new Map<KanbanLifecycleStage, Session[]>();
    for (const { stage } of KANBAN_COLUMNS) grouped.set(stage, []);
    for (const session of visibleSessions) {
      const stage = stageBySession.get(session.id);
      if (stage) grouped.get(stage)?.push(session);
    }
    return grouped;
  }, [stageBySession, visibleSessions]);

  const boardWidth = useMemo(
    () =>
      columnWidths.reduce((total, width) => total + width, 0) +
      KANBAN_COLUMN_GAP_PX * (KANBAN_COLUMNS.length - 1) +
      KANBAN_BOARD_PADDING_X_PX,
    [columnWidths],
  );
  const terminalPopoverSession = terminalPopover
    ? sessionsById.get(terminalPopover.sessionId) ?? null
    : null;

  // Persist board prefs per project. projectId is fixed for this instance (the
  // wrapper remounts via key on project switch), so a board can never write one
  // project's prefs into another project's bucket. The write is debounced —
  // a column-resize drag updates prefs on every pointermove tick, and each
  // write re-serializes the whole per-project prefs map — with a flush on
  // unmount so the final value always lands.
  const pendingPrefsWriteRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const write = () => {
      pendingPrefsWriteRef.current = null;
      writeKanbanBoardPrefs(projectId, prefs);
    };
    pendingPrefsWriteRef.current = write;
    const handle = window.setTimeout(write, KANBAN_PREFS_WRITE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [projectId, prefs]);
  useEffect(() => {
    return () => {
      pendingPrefsWriteRef.current?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (!terminalPopupSessionId) {
      setTerminalPopover((current) => (current ? null : current));
      return;
    }
    if (
      !visibleSessions.some(
        (session) => session.id === terminalPopupSessionId,
      )
    ) {
      closeTerminalPopup();
      return;
    }
    const anchor = document.querySelector<HTMLElement>(
      `[data-kanban-session-id="${cssAttributeEscape(terminalPopupSessionId)}"]`,
    );
    if (!anchor) return;
    anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
    setTerminalPopover((current) =>
      current?.sessionId === terminalPopupSessionId &&
      current.anchor === anchor
        ? current
        : { sessionId: terminalPopupSessionId, anchor },
    );
  }, [closeTerminalPopup, terminalPopupSessionId, visibleSessions]);

  useEffect(() => {
    if (!terminalPopover) return;
    if (sessionsById.has(terminalPopover.sessionId)) return;
    closeTerminalPopover();
  }, [terminalPopover, sessionsById]);

  // Release a column drag that is still active when the board unmounts
  // (view-mode flip or project switch mid-drag) so the body cursor and text
  // selection are restored and no orphaned listeners keep firing.
  useEffect(() => {
    return () => {
      columnResizeCleanupRef.current?.();
      columnResizeCleanupRef.current = null;
    };
  }, []);

  function setFilterQuery(filterQuery: string) {
    setPrefs((current) => ({ ...current, filterQuery }));
  }

  function setSortMode(sortMode: KanbanSortMode) {
    setPrefs((current) => ({ ...current, sortMode }));
  }

  function updateColumnWidths(
    next: number[] | ((current: number[]) => number[]),
  ) {
    setPrefs((current) => ({
      ...current,
      columnWidths:
        typeof next === "function" ? next(current.columnWidths) : next,
    }));
  }

  const openSessionTerminal = useCallback(
    (id: string, anchor: HTMLElement) => {
      selectSession(id);
      openTerminalPopup(id);
      setTerminalPopover({ sessionId: id, anchor });
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent("acorn:focus-session", {
              detail: { sessionId: id },
            }),
          );
        });
      }
    },
    [selectSession, openTerminalPopup],
  );

  const focusKanbanSessionCard = useCallback(
    (sessionId: string) => {
      const card = document.querySelector<HTMLElement>(
        `[data-kanban-session-id="${cssAttributeEscape(sessionId)}"]`,
      );
      card?.focus();
      card?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [],
  );

  const focusAdjacentSessionCard = useCallback(
    (sessionId: string, direction: KanbanCardFocusDirection) => {
      const nextSessionId = nextKanbanSessionId(
        sessionsByStage,
        sessionId,
        direction,
      );
      if (nextSessionId) focusKanbanSessionCard(nextSessionId);
    },
    [focusKanbanSessionCard, sessionsByStage],
  );

  function closeTerminalPopover() {
    const anchor = terminalPopover?.anchor;
    closeTerminalPopup();
    setTerminalPopover(null);
    if (anchor) requestAnimationFrame(() => anchor.focus());
  }

  function resizeColumn(index: number, nextWidth: number) {
    const clampedWidth = clampKanbanColumnWidth(nextWidth);
    updateColumnWidths((current) =>
      current.map((width, widthIndex) =>
        widthIndex === index ? clampedWidth : width,
      ),
    );
  }

  function resetColumn(index: number) {
    resizeColumn(index, KANBAN_COLUMN_DEFAULT_WIDTH);
  }

  function resetColumnWidths() {
    updateColumnWidths(defaultKanbanColumnWidths());
  }

  function equalizeColumnWidths() {
    updateColumnWidths((current) => equalizeKanbanColumnWidths(current));
  }

  function startColumnResize(
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();

    // End any drag that is somehow still tracked before starting a new one.
    columnResizeCleanupRef.current?.();

    const source = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = columnWidths[index] ?? KANBAN_COLUMN_DEFAULT_WIDTH;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingColumnIndex(index);

    const cleanup = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizingColumnIndex(null);
      try {
        source.releasePointerCapture?.(pointerId);
      } catch {
        // The pointer may already be released if the handle unmounted.
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      source.removeEventListener("lostpointercapture", onPointerEnd);
      if (columnResizeCleanupRef.current === cleanup) {
        columnResizeCleanupRef.current = null;
      }
    };

    function onPointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      resizeColumn(index, startWidth + moveEvent.clientX - startX);
    }

    function onPointerEnd(endEvent: PointerEvent) {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    }

    columnResizeCleanupRef.current = cleanup;
    try {
      source.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic events and some webviews can reject capture; window
      // listeners still cover normal in-window dragging.
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    source.addEventListener("lostpointercapture", onPointerEnd);
  }

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden"
      role="region"
      aria-label={t("workspace.kanban.title")}
      data-testid="workspace-kanban"
    >
      <KanbanToolbar
        t={t}
        filterQuery={filterQuery}
        onFilterQueryChange={setFilterQuery}
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        onResetColumnWidths={resetColumnWidths}
        onEqualizeColumnWidths={equalizeColumnWidths}
      />
      <div
        className="min-h-0 flex-1 overflow-x-auto"
        data-testid="workspace-kanban-scroll"
      >
        <div
          className="flex h-full items-stretch p-2"
          data-kanban-column-widths={columnWidths.join(",")}
          style={{
            width: `${boardWidth}px`,
            minWidth: "100%",
          }}
        >
          {KANBAN_COLUMNS.map((column, columnIndex) => {
            const columnSessions = sessionsByStage.get(column.stage) ?? [];
            const label = stageLabel(t, column.stage);
            const needsAttention =
              column.stage === "waiting" && columnSessions.length > 0;
            return (
              <Fragment key={column.stage}>
                <div
                  className="h-full min-w-0 grow shrink-0"
                  style={{
                    flexBasis: `${
                      columnWidths[columnIndex] ?? KANBAN_COLUMN_DEFAULT_WIDTH
                    }px`,
                  }}
                >
                  <section
                    className={cn(
                      "flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--acorn-pane-radius)] border bg-bg",
                      needsAttention ? "border-warning/50" : "border-border",
                    )}
                    aria-label={label}
                    data-kanban-column-stage={column.stage}
                  >
                    <header
                      className={cn(
                        "flex h-9 shrink-0 items-center gap-2 border-b px-2.5",
                        needsAttention
                          ? "border-warning/40 bg-warning/10"
                          : "border-border",
                      )}
                    >
                      <StatusDot
                        tone={column.tone}
                        pulse={column.stage === "working"}
                      />
                      <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
                        {label}
                      </h2>
                      <span
                        className={cn(
                          "rounded px-1.5 py-px text-[10px] tabular-nums",
                          needsAttention
                            ? "bg-warning/20 font-semibold text-warning"
                            : "bg-fg-muted/10 text-fg-muted",
                        )}
                        data-testid={`workspace-kanban-count-${column.stage}`}
                      >
                        {columnSessions.length}
                      </span>
                    </header>
                    <div className="acorn-no-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                      {columnSessions.length > 0 ? (
                        columnSessions.map((session) => (
                          <KanbanSessionCard
                            key={session.id}
                            session={session}
                            stage={column.stage}
                            dwell={dwellBySession.get(session.id) ?? null}
                            data={boardData.get(session.id) ?? null}
                            now={now}
                            manualDone={manualDoneSet.has(session.id)}
                            onOpen={openSessionTerminal}
                            onOpenPullRequest={openPullRequestDetail}
                            onToggleManualDone={toggleManualDone}
                            onFocusAdjacent={focusAdjacentSessionCard}
                          />
                        ))
                      ) : (
                        <p className="px-1 py-3 text-center text-[11px] text-fg-muted">
                          {t("workspace.kanban.emptyColumn")}
                        </p>
                      )}
                    </div>
                  </section>
                </div>
                {columnIndex < KANBAN_COLUMNS.length - 1 ? (
                  <ResizeHandle
                    mode="manual"
                    direction="horizontal"
                    gap
                    manualDragging={resizingColumnIndex === columnIndex}
                    aria-label={t("workspace.kanban.resizeColumn").replace(
                      "{name}",
                      label,
                    )}
                    data-testid="workspace-kanban-column-resize-handle"
                    data-kanban-resize-stage={column.stage}
                    onPointerDown={(event) =>
                      startColumnResize(columnIndex, event)
                    }
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      resetColumn(columnIndex);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ArrowLeft" &&
                        event.key !== "ArrowRight"
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const delta = event.shiftKey ? 24 : 8;
                      const currentWidth =
                        columnWidths[columnIndex] ??
                        KANBAN_COLUMN_DEFAULT_WIDTH;
                      resizeColumn(
                        columnIndex,
                        currentWidth +
                          (event.key === "ArrowRight" ? delta : -delta),
                      );
                    }}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>
      {terminalPopoverSession && terminalPopover ? (
        <KanbanTerminalPopover
          session={terminalPopoverSession}
          anchor={terminalPopover.anchor}
          onClose={closeTerminalPopover}
        />
      ) : null}
      <PullRequestDetailModal
        open={prDetail}
        cwd={prDetail?.repoPath}
        onClose={() => setPrDetail(null)}
        onMutated={onPullRequestsMutated}
      />
    </div>
  );
}

type KanbanActionEvent =
  | "acorn:new-session"
  | "acorn:new-isolated-session"
  | "acorn:new-chat-session"
  | "acorn:new-control-session";

const KANBAN_CREATE_ACTION_EVENTS: Record<
  DirectProjectSessionCreateAction["id"],
  KanbanActionEvent
> = {
  terminal: "acorn:new-session",
  isolated: "acorn:new-isolated-session",
  chat: "acorn:new-chat-session",
  control: "acorn:new-control-session",
};

function dispatchKanbanAction(action: ProjectSessionCreateAction) {
  if (action.flow === "goal") {
    requestNewAutonomousGoalSession();
    return;
  }
  window.dispatchEvent(
    new CustomEvent(KANBAN_CREATE_ACTION_EVENTS[action.id]),
  );
}

function kanbanSessionCreateIcon(id: ProjectSessionCreateAction["id"]) {
  switch (id) {
    case "goal":
      return <Sparkles size={12} />;
    case "terminal":
      return <Plus size={12} />;
    case "isolated":
      return <GitBranch size={12} />;
    case "chat":
      return <MessageSquareText size={12} />;
    case "control":
      return <Bot size={12} />;
  }
}

function KanbanToolbar({
  t,
  filterQuery,
  onFilterQueryChange,
  sortMode,
  onSortModeChange,
  onResetColumnWidths,
  onEqualizeColumnWidths,
}: {
  t: Translator;
  filterQuery: string;
  onFilterQueryChange: (query: string) => void;
  sortMode: KanbanSortMode;
  onSortModeChange: (mode: KanbanSortMode) => void;
  onResetColumnWidths: () => void;
  onEqualizeColumnWidths: () => void;
}) {
  return (
    <div className="shrink-0 px-2 pt-2">
      <div
        className="w-full max-w-full overflow-x-auto rounded-[var(--acorn-pane-radius)] border border-border bg-bg px-2 py-2"
        data-testid="workspace-kanban-toolbar"
      >
        <div className="flex min-w-[54rem] items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <KanbanCreateSessionDropdown t={t} />
            <KanbanToolbarButton
              icon={<RotateCcw size={12} />}
              label={t("workspace.kanban.actions.resetColumnSizes")}
              onClick={onResetColumnWidths}
            />
            <KanbanToolbarButton
              icon={<Columns3 size={12} />}
              label={t("workspace.kanban.actions.equalizeColumnSizes")}
              onClick={onEqualizeColumnWidths}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-border bg-bg-elevated/55 px-2 text-fg-muted transition focus-within:border-accent/40 focus-within:bg-bg-elevated focus-within:ring-2 focus-within:ring-accent/40 hover:border-accent/40 hover:bg-bg-elevated">
              <Search size={12} className="shrink-0" aria-hidden="true" />
              <input
                value={filterQuery}
                onChange={(event) =>
                  onFilterQueryChange(event.currentTarget.value)
                }
                aria-label={t("workspace.kanban.filterLabel")}
                placeholder={t("workspace.kanban.filterPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[11px] font-medium text-fg outline-none placeholder:text-fg-muted/60"
              />
            </label>
            <select
              value={sortMode}
              onChange={(event) =>
                onSortModeChange(toKanbanSortMode(event.currentTarget.value))
              }
              aria-label={t("workspace.kanban.sort.label")}
              className="h-7 rounded-md border border-border bg-bg-elevated/55 px-2 text-[11px] font-medium text-fg-muted outline-none transition hover:border-accent/40 hover:bg-bg-elevated hover:text-fg focus-visible:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <option value="updated-desc">
                {t("workspace.kanban.sort.updatedDesc")}
              </option>
              <option value="created-desc">
                {t("workspace.kanban.sort.createdDesc")}
              </option>
              <option value="name-asc">
                {t("workspace.kanban.sort.nameAsc")}
              </option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

function KanbanToolbarButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-elevated/55 px-2 text-[11px] font-medium text-fg-muted transition hover:border-accent/40 hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}

function KanbanCreateSessionDropdown({ t }: { t: Translator }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const menuItems = useMemo<ContextMenuItem[]>(
    () => [
      workspaceContextMenuGroupTitle(t, "session"),
      ...PROJECT_SESSION_CREATE_MENU.map((item) => {
        if (item.type === "separator") return { type: "separator" as const };
        const action = item.action;
        return {
          label: sidebarText(t, action.labelKey),
          icon: kanbanSessionCreateIcon(action.id),
          shortcut: action.hotkeyId
            ? formatHotkey(shortcuts[action.hotkeyId])
            : undefined,
          onClick: () => dispatchKanbanAction(action),
        };
      }),
    ],
    [shortcuts, t],
  );
  const label = t("workspace.kanban.actions.createSession");

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu((current) =>
            current === null ? { x: rect.left, y: rect.bottom + 4 } : null,
          );
        }}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-elevated/55 px-2 text-[11px] font-medium text-fg-muted transition hover:border-accent/40 hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          <Plus size={12} />
        </span>
        <span>{label}</span>
        <ChevronDown size={12} className="shrink-0" aria-hidden="true" />
      </button>
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

type KanbanCardFocusDirection = "up" | "down" | "left" | "right";

function nextKanbanSessionId(
  sessionsByStage: ReadonlyMap<KanbanLifecycleStage, readonly Session[]>,
  sessionId: string,
  direction: KanbanCardFocusDirection,
): string | null {
  const columns = KANBAN_COLUMNS.map(
    ({ stage }) => sessionsByStage.get(stage) ?? [],
  );
  let currentColumnIndex = -1;
  let currentSessionIndex = -1;

  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const sessionIndex = columns[columnIndex].findIndex(
      (session) => session.id === sessionId,
    );
    if (sessionIndex === -1) continue;
    currentColumnIndex = columnIndex;
    currentSessionIndex = sessionIndex;
    break;
  }

  if (currentColumnIndex === -1 || currentSessionIndex === -1) return null;

  if (direction === "up" || direction === "down") {
    const column = columns[currentColumnIndex];
    const nextIndex = currentSessionIndex + (direction === "down" ? 1 : -1);
    return column[nextIndex]?.id ?? null;
  }

  const step = direction === "right" ? 1 : -1;
  for (
    let columnIndex = currentColumnIndex + step;
    columnIndex >= 0 && columnIndex < columns.length;
    columnIndex += step
  ) {
    const column = columns[columnIndex];
    if (column.length === 0) continue;
    const nextIndex = Math.min(currentSessionIndex, column.length - 1);
    return column[nextIndex]?.id ?? null;
  }

  return null;
}

function kanbanCardFocusDirection(
  key: string,
): KanbanCardFocusDirection | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    default:
      return null;
  }
}

const KanbanSessionCard = memo(function KanbanSessionCard({
  session,
  stage,
  dwell,
  data,
  now,
  manualDone,
  onOpen,
  onOpenPullRequest,
  onToggleManualDone,
  onFocusAdjacent,
}: {
  session: Session;
  stage: KanbanLifecycleStage;
  dwell: KanbanStageDwell | null;
  data: KanbanSessionBoardData | null;
  now: number;
  manualDone: boolean;
  onOpen: (sessionId: string, anchor: HTMLElement) => void;
  onOpenPullRequest: (repoPath: string, number: number) => void;
  onToggleManualDone: (sessionId: string) => void;
  onFocusAdjacent: (
    sessionId: string,
    direction: KanbanCardFocusDirection,
  ) => void;
}) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const worktreeName = basename(session.worktree_path);
  const transcriptPath = session.agent_transcript_path?.trim() || null;
  const branchName = session.branch?.trim();
  const stalled = isKanbanSessionStalled(session, stage, now);
  const dwellLabel = dwell ? formatKanbanDwell(now - dwell.since) : null;
  const conversationPreview = kanbanConversationPreview(session);
  const lastMessage =
    conversationPreview.agentMessage ?? conversationPreview.fallbackMessage;
  const hasStructuredPreview = Boolean(
    conversationPreview.userMessage || conversationPreview.agentMessage,
  );
  const selectSession = useAppStore((s) => s.selectSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const generateSessionTitle = useAppStore((s) => s.generateSessionTitle);
  const openWorkSummaryTab = useAppStore((s) => s.openWorkSummaryTab);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const sessionSilenced = useAppStore((s) =>
    Boolean(s.silencedSessionIds[session.id]),
  );
  const setSessionSilenced = useAppStore((s) => s.setSessionSilenced);
  const editorCommand = useSettings((s) => s.settings.editor.command);
  const editorConfigured = editorCommand.trim().length > 0;
  const isGeneratingTitle = useAppStore((s) =>
    Boolean(s.generatingSessionTitleIds[session.id]),
  );
  const canRename = canRenameSession(session, { isGeneratingTitle });
  const canRegenerateTitle =
    canRegenerateSessionTitle(session) && !isGeneratingTitle;
  const currentPullRequest = useCurrentPullRequest(session);
  const processSummary = summarizeSessionProcesses(session.active_processes);
  const processTooltipSummary = summarizeAllSessionProcesses(
    session.active_processes,
  );
  const hasContextMetadata = Boolean(currentPullRequest || processSummary);
  const pullRequestColor = currentPullRequest
    ? pullRequestNumberClassName(currentPullRequest)
    : null;
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openLabel = t("workspace.kanban.openSession").replace(
    "{name}",
    session.name,
  );

  useEffect(() => {
    if (isGeneratingTitle && editing) setEditing(false);
  }, [editing, isGeneratingTitle]);

  function openContextMenu(x: number, y: number) {
    setMenu({ x, y });
  }

  function handleContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event.clientX, event.clientY);
  }

  function handlePointerDown(event: ReactPointerEvent) {
    if (editing) return;
    if (event.button !== 2) return;
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY);
  }

  function handleOpen(event: ReactMouseEvent<HTMLElement>) {
    onOpen(session.id, event.currentTarget);
  }

  function handleArrowKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (editing || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = kanbanCardFocusDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    onFocusAdjacent(session.id, direction);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (editing) return;
    if (
      matchesHotkeyEvent(
        useSettings.getState().settings.shortcuts.renameItem,
        event,
      )
    ) {
      event.preventDefault();
      if (canRename) setEditing(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(session.id, event.currentTarget);
      return;
    }
  }

  async function submitRename(next: string) {
    setEditing(false);
    if (canRename && next && next !== session.name) {
      await renameSession(session.id, next);
      const error = useAppStore.getState().consumeError();
      if (error) showToast(`${t("toasts.session.renameFailed")} ${error}`);
    }
  }

  async function regenerateTitle() {
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

  const sessionMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      workspaceContextMenuGroupTitle(t, "session"),
      {
        label: sidebarText(t, "sidebar.actions.rename"),
        icon: <Pencil size={12} />,
        onClick: () => setEditing(true),
        disabled: !canRename,
      },
      {
        label: sidebarText(t, "sidebar.actions.regenerateName"),
        icon: <Sparkles size={12} />,
        onClick: () => void regenerateTitle(),
        disabled: !canRegenerateTitle,
      },
      {
        label: manualDone
          ? t("workspace.kanban.actions.restoreFromDone")
          : t("workspace.kanban.actions.markAsDone"),
        icon: <CheckCircle2 size={12} />,
        onClick: () => onToggleManualDone(session.id),
      },
      {
        label: sidebarText(
          t,
          sessionSilenced
            ? "sidebar.actions.resumeNotifications"
            : "sidebar.actions.silenceNotifications",
        ),
        icon: sessionSilenced ? <Bell size={12} /> : <BellOff size={12} />,
        onClick: () => setSessionSilenced(session.id, !sessionSilenced),
      },
      { type: "separator" },
      workspaceContextMenuGroupTitle(t, "open"),
      {
        label: sidebarText(t, "sidebar.actions.openWorkSummary"),
        icon: <BarChart3 size={12} />,
        onClick: () => {
          selectSession(session.id);
          void openWorkSummaryTab({ sessionId: session.id });
        },
      },
      {
        label: sidebarText(t, "sidebar.actions.openWorktreeInEditor"),
        icon: <PencilLine size={12} />,
        disabled: !editorConfigured,
        onClick: () => {
          void openInConfiguredEditor(session.worktree_path).catch(
            (err: unknown) => {
              console.error("[WorkspaceMain] open in editor failed", err);
            },
          );
        },
      },
      {
        label: sidebarText(t, "sidebar.actions.revealInFinder"),
        icon: <FolderOpen size={12} />,
        onClick: () => {
          void api.fsReveal(session.worktree_path).catch((err: unknown) => {
            console.error("[WorkspaceMain] reveal failed", err);
          });
        },
      },
      { type: "separator" },
      workspaceContextMenuGroupTitle(t, "copy"),
      {
        type: "submenu",
        label: sidebarText(t, "sidebar.actions.copy"),
        icon: <Copy size={12} />,
        children: [
          {
            label: sidebarText(t, "sidebar.actions.worktreePath"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(session.worktree_path),
          },
          ...(transcriptPath
            ? [
                {
                  label: sidebarText(t, "sidebar.actions.transcriptPath"),
                  icon: <Copy size={12} />,
                  onClick: () => void copyToClipboard(transcriptPath),
                } satisfies ContextMenuItem,
              ]
            : []),
          {
            label: sidebarText(t, "sidebar.actions.worktreeName"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(worktreeName),
          },
          {
            label: sidebarText(t, "sidebar.actions.branchName"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(session.branch),
            disabled: !session.branch,
          },
          {
            label: sidebarText(t, "sidebar.actions.sessionId"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(session.id),
          },
        ],
      },
      { type: "separator" },
      workspaceContextMenuGroupTitle(t, "danger"),
      {
        label: sidebarText(t, "sidebar.actions.removeSessionMenu"),
        icon: <Trash2 size={12} />,
        onClick: () => requestRemoveSession(session.id),
      },
    ],
    [
      canRegenerateTitle,
      canRename,
      editorConfigured,
      generateSessionTitle,
      isGeneratingTitle,
      manualDone,
      onToggleManualDone,
      openWorkSummaryTab,
      renameSession,
      requestRemoveSession,
      selectSession,
      sessionSilenced,
      session.branch,
      session.id,
      session.name,
      session.worktree_path,
      showToast,
      setSessionSilenced,
      t,
      transcriptPath,
      worktreeName,
    ],
  );

  return (
    <>
      <Tooltip
        label={
          <KanbanSessionCardTooltip
            t={t}
            title={session.name}
            userMessage={conversationPreview.userMessage}
            agentMessage={conversationPreview.agentMessage}
            fallbackMessage={conversationPreview.fallbackMessage}
            branch={branchName}
            worktreeName={worktreeName}
            worktreePath={session.worktree_path}
            currentPullRequest={currentPullRequest}
            processSummary={processTooltipSummary}
          />
        }
        side="right"
        delay={350}
        multiline
        className="flex w-full"
      >
        {/*
          Not a <button>: cards can contain their own focusable controls, and
          interactive content inside a button is invalid and breaks focus.
        */}
        <div
          role="button"
          tabIndex={0}
          data-testid="workspace-kanban-card"
          data-kanban-session-id={session.id}
          onClick={editing ? undefined : handleOpen}
          onPointerDown={handlePointerDown}
          onContextMenu={handleContextMenu}
          onKeyDownCapture={handleArrowKeyDown}
          onKeyDown={handleKeyDown}
          className="group flex w-full cursor-pointer flex-col gap-2 rounded-md border border-border bg-bg-elevated/45 p-2 text-left transition hover:border-accent/45 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={openLabel}
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <WorkspaceSessionIcon session={session} scope="kanban" />
            <span className="min-w-0 flex-1">
              {editing ? (
                <KanbanCardRenameInput
                  initial={session.name}
                  onSubmit={submitRename}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <span className="block truncate text-[12px] font-medium leading-5 text-fg">
                  {session.name}
                </span>
              )}
            </span>
            {sessionSilenced ? (
              <span
                className="inline-flex shrink-0 text-fg-muted"
                aria-label={sidebarText(
                  t,
                  "sidebar.aria.notificationsSilenced",
                )}
                title={sidebarText(t, "sidebar.aria.notificationsSilenced")}
              >
                <BellOff size={11} aria-hidden />
              </span>
            ) : null}
            {stalled ? (
              <span
                className="shrink-0 rounded bg-danger/15 px-1 py-px text-[9px] font-semibold uppercase leading-4 tracking-wide text-danger"
                data-testid="workspace-kanban-card-stalled"
              >
                {t("workspace.kanban.card.stalled")}
              </span>
            ) : null}
          </span>
          {hasStructuredPreview ? (
            <span
              className="flex min-w-0 flex-col gap-1 text-[11px] leading-4 text-fg-muted"
              data-testid="workspace-kanban-card-last-message"
            >
              {conversationPreview.userMessage ? (
                <span
                  className="flex min-w-0 items-baseline gap-1.5"
                  data-testid="workspace-kanban-card-user-message"
                >
                  <span className="shrink-0 text-[9px] font-medium uppercase text-fg-muted/70">
                    {t("workspace.kanban.preview.user")}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {conversationPreview.userMessage}
                  </span>
                </span>
              ) : null}
              {conversationPreview.agentMessage ? (
                <span
                  className="flex min-w-0 items-baseline gap-1.5"
                  data-testid="workspace-kanban-card-agent-message"
                >
                  <span className="shrink-0 text-[9px] font-medium uppercase text-fg-muted/70">
                    {t("workspace.kanban.preview.agent")}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {conversationPreview.agentMessage}
                  </span>
                </span>
              ) : null}
            </span>
          ) : lastMessage ? (
            <span
              className="line-clamp-2 text-[11px] leading-4 text-fg-muted"
              data-testid="workspace-kanban-card-last-message"
            >
              {lastMessage}
            </span>
          ) : null}
          {data && (data.pr || data.hasDiff) ? (
            <span
              className="flex min-w-0 flex-wrap items-center gap-1.5"
              data-testid="workspace-kanban-card-chips"
            >
              {data.pr ? (
                <KanbanPullRequestChip
                  t={t}
                  pr={data.pr}
                  onOpen={(number) =>
                    onOpenPullRequest(data.repoPath, number)
                  }
                />
              ) : null}
              {data.hasDiff ? (
                <span
                  className="inline-flex items-center gap-1 rounded border border-border bg-bg px-1 py-px text-[10px] leading-4 tabular-nums"
                  data-testid="workspace-kanban-card-diff"
                >
                  <span className="text-success">+{data.additions}</span>
                  <span className="text-danger">-{data.deletions}</span>
                </span>
              ) : null}
            </span>
          ) : null}
          {hasContextMetadata ? (
            <span
              className="flex min-w-0 items-center gap-1 text-[10px] leading-none text-fg-muted"
              data-testid="workspace-kanban-card-context"
            >
              {currentPullRequest ? (
                <button
                  type="button"
                  aria-label={`${sidebarText(t, "sidebar.metadata.openPullRequest")} #${currentPullRequest.number}`}
                  title={currentPullRequest.title}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onKeyUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void openUrl(currentPullRequest.url).catch(
                      (err: unknown) => {
                        console.error(
                          "[WorkspaceMain] open PR URL failed",
                          err,
                        );
                      },
                    );
                  }}
                  className={cn(
                    "inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-sm underline-offset-2 transition hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
                    pullRequestColor,
                  )}
                >
                  <span>{`PR #${currentPullRequest.number}`}</span>
                  <ExternalLink size={9} aria-hidden className="opacity-80" />
                </button>
              ) : null}
              {currentPullRequest && processSummary ? (
                <span aria-hidden className="shrink-0 text-fg-muted/70">
                  ·
                </span>
              ) : null}
              {processSummary ? (
                <span className="min-w-0 truncate font-mono">
                  {processSummary}
                </span>
              ) : null}
            </span>
          ) : null}
          <span
            className="flex min-w-0 items-center gap-1.5 text-[10px] leading-none text-fg-muted"
            data-testid="workspace-kanban-card-meta"
          >
            {branchName ? (
              <>
                <GitBranch size={10} className="shrink-0" />
                <span
                  className="min-w-0 truncate"
                  data-testid="workspace-kanban-card-branch"
                >
                  {branchName}
                </span>
              </>
            ) : null}
            {branchName ? (
              <span className="text-fg-muted/45">|</span>
            ) : null}
            <FolderOpen size={10} className="shrink-0" />
            <span
              className="min-w-0 truncate"
              data-testid="workspace-kanban-card-worktree"
            >
              {worktreeName}
            </span>
            {session.kind === "control" ? (
              <>
                <span className="text-fg-muted/45">|</span>
                <Bot size={10} className="shrink-0 text-accent" />
              </>
            ) : null}
            {dwellLabel ? (
              <span
                className="ml-auto flex shrink-0 items-center gap-1 pl-1"
                title={t("workspace.kanban.card.dwellTitle").replace(
                  "{duration}",
                  dwellLabel,
                )}
                data-testid="workspace-kanban-card-dwell"
              >
                <Clock size={10} className="shrink-0" />
                <span className="tabular-nums">{dwellLabel}</span>
              </span>
            ) : null}
          </span>
        </div>
      </Tooltip>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={sessionMenuItems}
      />
    </>
  );
});

/**
 * Compact PR pill on a kanban card: state-tinted PR icon, number, and a CI
 * rollup glyph. Rendered inside the card's clickable root, so it stops
 * pointer/click propagation and acts as its own keyboard target.
 */
function KanbanPullRequestChip({
  t,
  pr,
  onOpen,
}: {
  t: Translator;
  pr: PullRequestInfo;
  onOpen: (number: number) => void;
}) {
  const state = pr.state.toUpperCase();
  const stateClass =
    state === "OPEN"
      ? pr.is_draft
        ? "text-fg-muted"
        : "text-emerald-400"
      : state === "MERGED"
        ? "text-purple-400"
        : "text-danger";
  const checks = pr.checks;
  const label = t("workspace.kanban.card.openPullRequest").replace(
    "{number}",
    String(pr.number),
  );
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={pr.title}
      data-testid="workspace-kanban-card-pr"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(pr.number);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(pr.number);
      }}
      className="inline-flex items-center gap-1 rounded border border-border bg-bg px-1 py-px text-[10px] leading-4 transition hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <GitPullRequest size={10} className={cn("shrink-0", stateClass)} />
      <span className="tabular-nums text-fg-muted">#{pr.number}</span>
      {checks ? (
        checks.failed > 0 ? (
          <XCircle size={10} className="shrink-0 text-danger" />
        ) : checks.pending > 0 ? (
          <CircleDashed size={10} className="shrink-0 text-warning" />
        ) : (
          <CheckCircle2 size={10} className="shrink-0 text-success" />
        )
      ) : null}
    </span>
  );
}

function KanbanCardRenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      data-kanban-card-rename-input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void onSubmit(value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => void onSubmit(value.trim())}
      className="h-5 w-full min-w-0 rounded border border-accent bg-input px-1 text-[12px] font-medium leading-4 text-fg outline-none"
    />
  );
}

function KanbanTerminalPopover({
  session,
  anchor,
  onClose,
}: {
  session: Session;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const popoverPlacement = useSettings(
    (s) => s.settings.interface.kanbanTerminalPopoverPlacement,
  );
  const popoverDefaultSize = useSettings(
    (s) => s.settings.interface.kanbanTerminalPopoverDefaultSize,
  );
  const closeShortcut = useSettings((s) =>
    formatHotkey(s.settings.shortcuts.closeTab),
  );
  const renameSession = useAppStore((s) => s.renameSession);
  const generateSessionTitle = useAppStore((s) => s.generateSessionTitle);
  const selectSession = useAppStore((s) => s.selectSession);
  const openWorkSummaryTab = useAppStore((s) => s.openWorkSummaryTab);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const sessionSilenced = useAppStore((s) =>
    Boolean(s.silencedSessionIds[session.id]),
  );
  const setSessionSilenced = useAppStore((s) => s.setSessionSilenced);
  const editorCommand = useSettings((s) => s.settings.editor.command);
  const editorConfigured = editorCommand.trim().length > 0;
  const isGeneratingTitle = useAppStore((s) =>
    Boolean(s.generatingSessionTitleIds[session.id]),
  );
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] =
    useState<KanbanTerminalPopoverPosition | null>(null);
  const [size, setSize] = useState<KanbanTerminalPopoverSize>(() =>
    readKanbanTerminalPopoverSize(),
  );
  const [isExpanded, setIsExpanded] = useState(
    () => popoverDefaultSize === "fullscreen",
  );
  const [headerMenu, setHeaderMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const positionRef = useRef<KanbanTerminalPopoverPosition | null>(null);
  const sizeRef = useRef(size);
  const hasManualPositionRef = useRef(false);

  const worktreeName = basename(session.worktree_path);
  const transcriptPath = session.agent_transcript_path?.trim() || null;
  const title = cleanWorkspaceSessionTerminalPopoverTitle(session.name);
  const statusTone = STATUS_TONE[session.status];
  const isChat = session.mode === "chat";
  const canRename = canRenameSession(session, { isGeneratingTitle });
  const canRegenerateTitle =
    canRegenerateSessionTitle(session) && !isGeneratingTitle;
  const currentPullRequest = useCurrentPullRequest(session);

  const updatePosition = useCallback(() => {
    const margin = KANBAN_TERMINAL_POPOVER_MARGIN_PX;
    if (isExpanded) {
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverSize = clampKanbanTerminalPopoverSize(sizeRef.current);
    const { width, height } = popoverSize;
    if (hasManualPositionRef.current) {
      const currentPosition =
        positionRef.current ??
        (popoverRef.current
          ? {
              left: popoverRef.current.getBoundingClientRect().left,
              top: popoverRef.current.getBoundingClientRect().top,
            }
          : { left: margin, top: margin });
      const nextPosition = clampKanbanTerminalPopoverPosition(
        currentPosition,
        popoverSize,
      );
      positionRef.current = nextPosition;
      setPosition(nextPosition);
      return;
    }

    if (popoverPlacement === "center") {
      const nextPosition = clampKanbanTerminalPopoverPosition(
        {
          left: (viewportWidth - width) / 2,
          top: (viewportHeight - height) / 2,
        },
        popoverSize,
      );
      positionRef.current = nextPosition;
      setPosition(nextPosition);
      return;
    }

    const gap = KANBAN_TERMINAL_POPOVER_GAP_PX;
    let left = rect.right + gap;
    if (left + width > viewportWidth - margin) {
      left = rect.left - width - gap;
    }
    if (left < margin) {
      left = Math.min(Math.max(margin, rect.left), viewportWidth - width - margin);
    }
    let top = rect.top;
    if (top + height > viewportHeight - margin) {
      top = viewportHeight - height - margin;
    }
    top = Math.max(margin, top);
    const nextPosition = { left, top };
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, [anchor, isExpanded, popoverPlacement]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    setEditingTitle(false);
    setHeaderMenu(null);
  }, [session.id]);

  useEffect(() => {
    if (isGeneratingTitle && editingTitle) setEditingTitle(false);
  }, [editingTitle, isGeneratingTitle]);

  async function submitTitleRename(next: string) {
    setEditingTitle(false);
    if (!canRename || !next || next === session.name) return;
    await renameSession(session.id, next);
    const error = useAppStore.getState().consumeError();
    if (error) showToast(`${t("toasts.session.renameFailed")} ${error}`);
  }

  async function regenerateTitle() {
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

  const headerMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      workspaceContextMenuGroupTitle(t, "session"),
      {
        label: sidebarText(t, "sidebar.actions.rename"),
        icon: <Pencil size={12} />,
        onClick: () => setEditingTitle(true),
        disabled: !canRename,
      },
      {
        label: sidebarText(t, "sidebar.actions.regenerateName"),
        icon: <Sparkles size={12} />,
        onClick: () => void regenerateTitle(),
        disabled: !canRegenerateTitle,
      },
      {
        label: sidebarText(t, "sidebar.actions.openWorkSummary"),
        icon: <BarChart3 size={12} />,
        onClick: () => {
          selectSession(session.id);
          void openWorkSummaryTab({ sessionId: session.id });
        },
      },
      {
        label: sidebarText(
          t,
          sessionSilenced
            ? "sidebar.actions.resumeNotifications"
            : "sidebar.actions.silenceNotifications",
        ),
        icon: sessionSilenced ? <Bell size={12} /> : <BellOff size={12} />,
        onClick: () => setSessionSilenced(session.id, !sessionSilenced),
      },
      workspaceContextMenuGroupTitle(t, "open"),
      {
        label: sidebarText(t, "sidebar.actions.openWorktreeInEditor"),
        icon: <PencilLine size={12} />,
        disabled: !editorConfigured,
        onClick: () => {
          void openInConfiguredEditor(session.worktree_path).catch(
            (err: unknown) => {
              console.error("[WorkspaceMain] open in editor failed", err);
            },
          );
        },
      },
      {
        label: sidebarText(t, "sidebar.actions.revealInFinder"),
        icon: <FolderOpen size={12} />,
        onClick: () => {
          void api.fsReveal(session.worktree_path).catch((err: unknown) => {
            console.error("[WorkspaceMain] reveal failed", err);
          });
        },
      },
      workspaceContextMenuGroupTitle(t, "copy"),
      {
        type: "submenu",
        label: sidebarText(t, "sidebar.actions.copy"),
        icon: <Copy size={12} />,
        children: [
          {
            label: sidebarText(t, "sidebar.actions.worktreePath"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(session.worktree_path),
          },
          ...(transcriptPath
            ? [
                {
                  label: sidebarText(t, "sidebar.actions.transcriptPath"),
                  icon: <Copy size={12} />,
                  onClick: () => void copyToClipboard(transcriptPath),
                } satisfies ContextMenuItem,
              ]
            : []),
          {
            label: sidebarText(t, "sidebar.actions.worktreeName"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(worktreeName),
          },
          {
            label: sidebarText(t, "sidebar.actions.branchName"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(session.branch),
            disabled: !session.branch,
          },
          {
            label: sidebarText(t, "sidebar.actions.sessionId"),
            icon: <Copy size={12} />,
            onClick: () => void copyToClipboard(session.id),
          },
        ],
      },
      workspaceContextMenuGroupTitle(t, "danger"),
      {
        label: sidebarText(t, "sidebar.actions.removeSessionMenu"),
        icon: <Trash2 size={12} />,
        onClick: () => requestRemoveSession(session.id),
      },
    ],
    [
      canRegenerateTitle,
      canRename,
      editorConfigured,
      generateSessionTitle,
      isGeneratingTitle,
      openWorkSummaryTab,
      requestRemoveSession,
      selectSession,
      sessionSilenced,
      session.branch,
      session.id,
      session.name,
      session.worktree_path,
      showToast,
      setSessionSilenced,
      t,
      transcriptPath,
      worktreeName,
    ],
  );

  useLayoutEffect(() => {
    hasManualPositionRef.current = false;
  }, [anchor, session.id]);

  useLayoutEffect(() => {
    const onUpdate = () => {
      if (!isExpanded) {
        const nextSize = clampKanbanTerminalPopoverSize(sizeRef.current);
        if (
          nextSize.width !== sizeRef.current.width ||
          nextSize.height !== sizeRef.current.height
        ) {
          sizeRef.current = nextSize;
          setSize(nextSize);
        }
      }
      updatePosition();
    };
    onUpdate();
    window.addEventListener("resize", onUpdate);
    window.addEventListener("scroll", onUpdate, true);
    return () => {
      window.removeEventListener("resize", onUpdate);
      window.removeEventListener("scroll", onUpdate, true);
    };
  }, [isExpanded, updatePosition]);

  useEffect(() => {
    const frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [isExpanded, session.id, updatePosition]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (isInAcornFloatingLayer(target)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      if (isModalDialogOpen()) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [anchor, onClose]);

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if (isExpanded || event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "button,a,input,textarea,select,[data-kanban-title-edit-trigger]",
      )
    ) {
      return;
    }
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    if (!popoverRect) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = {
      left: popoverRect.left,
      top: popoverRect.top,
    };
    const dragSize = {
      width: popoverRect.width,
      height: popoverRect.height,
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let didMove = false;

    document.body.style.cursor = "move";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!didMove && Math.abs(deltaX) + Math.abs(deltaY) < 3) return;
      didMove = true;
      hasManualPositionRef.current = true;
      const nextPosition = clampKanbanTerminalPopoverPosition(
        {
          left: startPosition.left + deltaX,
          top: startPosition.top + deltaY,
        },
        dragSize,
      );
      positionRef.current = nextPosition;
      setPosition(nextPosition);
    };

    const stopDrag = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
  }

  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = sizeRef.current;
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    const origin = {
      left:
        popoverRect?.left ??
        position?.left ??
        KANBAN_TERMINAL_POPOVER_MARGIN_PX,
      top:
        popoverRect?.top ?? position?.top ?? KANBAN_TERMINAL_POPOVER_MARGIN_PX,
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let latestSize = startSize;

    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextSize = clampKanbanTerminalPopoverSize(
        {
          width: startSize.width + moveEvent.clientX - startX,
          height: startSize.height + moveEvent.clientY - startY,
        },
        origin,
      );
      latestSize = nextSize;
      sizeRef.current = nextSize;
      setSize(nextSize);
    };

    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      writeKanbanTerminalPopoverSize(latestSize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function openHeaderContextMenu(x: number, y: number) {
    setHeaderMenu({ x, y });
  }

  function handleHeaderContextMenu(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input,textarea,select")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openHeaderContextMenu(event.clientX, event.clientY);
  }

  function resetPopoverPosition() {
    hasManualPositionRef.current = false;
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    updatePosition();
  }

  function resetPopoverSize() {
    const nextSize = clampKanbanTerminalPopoverSize(
      defaultKanbanTerminalPopoverSize(),
    );
    sizeRef.current = nextSize;
    setSize(nextSize);
    writeKanbanTerminalPopoverSize(nextSize);
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    updatePosition();
  }

  function handlePopoverKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  const popoverStyle: CSSProperties = isExpanded
    ? {
        position: "fixed",
        width: `calc(100vw - ${KANBAN_TERMINAL_POPOVER_MARGIN_PX * 2}px)`,
        height: `calc(100vh - ${KANBAN_TERMINAL_POPOVER_MARGIN_PX * 2}px)`,
        left: KANBAN_TERMINAL_POPOVER_MARGIN_PX,
        top: KANBAN_TERMINAL_POPOVER_MARGIN_PX,
        visibility: "visible",
      }
    : {
        position: "fixed",
        width: size.width,
        height: size.height,
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        visibility: position ? "visible" : "hidden",
      };

  const popover = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t("workspace.kanban.terminalPopover.ariaLabel")}
      data-testid="kanban-terminal-popover"
      onKeyDown={handlePopoverKeyDown}
      className="relative z-50 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-2xl shadow-black/35"
      style={popoverStyle}
    >
      <header
        data-testid="kanban-terminal-popover-drag-handle"
        onPointerDown={startDrag}
        onContextMenu={handleHeaderContextMenu}
        className={cn(
          "shrink-0 border-b border-border px-3 py-2.5",
          !isExpanded && "cursor-move select-none",
        )}
      >
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg shadow-sm">
            <WorkspaceSessionIcon session={session} scope="console" size="md" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {editingTitle ? (
                <KanbanTerminalPopoverTitleInput
                  initial={session.name}
                  onSubmit={(next) => void submitTitleRename(next)}
                  onCancel={() => setEditingTitle(false)}
                />
              ) : (
                <h3
                  tabIndex={canRename ? 0 : undefined}
                  data-kanban-title-edit-trigger
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (canRename) setEditingTitle(true);
                  }}
                  onKeyDown={(event) => {
                    if (!canRename) return;
                    if (
                      !matchesHotkeyEvent(
                        useSettings.getState().settings.shortcuts.renameItem,
                        event,
                      ) &&
                      event.key !== "Enter" &&
                      event.key !== " "
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingTitle(true);
                  }}
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-sm text-sm font-semibold text-fg",
                    canRename &&
                      "cursor-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                  )}
                >
                  {title}
                </h3>
              )}
              {sessionSilenced ? (
                <span
                  className="inline-flex shrink-0 text-fg-muted"
                  aria-label={sidebarText(
                    t,
                    "sidebar.aria.notificationsSilenced",
                  )}
                  title={sidebarText(
                    t,
                    "sidebar.aria.notificationsSilenced",
                  )}
                >
                  <BellOff size={12} aria-hidden />
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[11px] font-medium leading-4 text-fg-muted">
              <WorkspaceSessionTerminalPopoverMetaItem
                icon={
                  <StatusDot
                    tone={statusTone}
                    pulse={session.status === "working"}
                    size="xs"
                  />
                }
                title={statusDetailLabel(t, session)}
              >
                {statusDetailLabel(t, session)}
              </WorkspaceSessionTerminalPopoverMetaItem>
              {currentPullRequest ? (
                <KanbanTerminalPopoverPullRequestMetaItem
                  pullRequest={currentPullRequest}
                  t={t}
                />
              ) : null}
              {session.branch ? (
                <WorkspaceSessionTerminalPopoverMetaItem
                  icon={<GitBranch size={11} />}
                >
                  {session.branch}
                </WorkspaceSessionTerminalPopoverMetaItem>
              ) : null}
              <WorkspaceSessionTerminalPopoverMetaItem
                icon={<FolderOpen size={11} />}
                title={session.worktree_path}
              >
                {worktreeName}
              </WorkspaceSessionTerminalPopoverMetaItem>
            </div>
          </div>
          <Tooltip
            label={t("workspace.kanban.terminalPopover.resetPosition")}
            side="bottom"
          >
            <IconButton
              aria-label={t("workspace.kanban.terminalPopover.resetPosition")}
              data-testid="kanban-terminal-popover-reset-position"
              onClick={resetPopoverPosition}
              size="sm"
              surface="panel"
            >
              <LocateFixed size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip
            label={t("workspace.kanban.terminalPopover.resetSize")}
            side="bottom"
          >
            <IconButton
              aria-label={t("workspace.kanban.terminalPopover.resetSize")}
              data-testid="kanban-terminal-popover-reset-size"
              onClick={resetPopoverSize}
              size="sm"
              surface="panel"
            >
              <RotateCcw size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip
            label={t(
              isExpanded
                ? "workspace.kanban.terminalPopover.restore"
                : "workspace.kanban.terminalPopover.expand",
            )}
            side="bottom"
          >
            <IconButton
              aria-label={t(
                isExpanded
                  ? "workspace.kanban.terminalPopover.restore"
                  : "workspace.kanban.terminalPopover.expand",
              )}
              data-testid="kanban-terminal-popover-expand"
              onClick={() => setIsExpanded((current) => !current)}
              size="sm"
              surface="panel"
            >
              {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
          </Tooltip>
          <Tooltip
            label={t("dialogs.common.close")}
            shortcut={closeShortcut}
            side="bottom"
          >
            <IconButton
              aria-label={t("dialogs.common.close")}
              onClick={onClose}
              size="sm"
              surface="panel"
            >
              <X size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </header>
      <ContextMenu
        open={headerMenu !== null}
        x={headerMenu?.x ?? 0}
        y={headerMenu?.y ?? 0}
        onClose={() => setHeaderMenu(null)}
        items={headerMenuItems}
      />
      <div className="min-h-0 flex-1 bg-bg p-2">
        {isChat ? (
          <div
            className="relative h-full min-h-0 overflow-hidden rounded-md border border-border bg-bg shadow-inner"
            data-testid="chat-popover-body"
          >
            <ChatPane
              sessionId={session.id}
              isActive
              repoPath={session.worktree_path}
              session={session}
            />
          </div>
        ) : (
          <div
            className="relative h-full min-h-0 w-full overflow-hidden rounded-md border border-border bg-bg shadow-inner"
            data-terminal-popover-body={session.id}
            data-testid="terminal-popover-body"
          />
        )}
      </div>
      {isExpanded ? null : (
        <button
          type="button"
          aria-label={t("workspace.kanban.terminalPopover.resize")}
          data-testid="kanban-terminal-popover-resize"
          onPointerDown={startResize}
          className="absolute bottom-0 right-0 z-10 flex size-5 cursor-nwse-resize items-end justify-end rounded-tl-md text-fg-muted/70 transition hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <span
            aria-hidden="true"
            className="mb-1 mr-1 block size-2.5 border-b border-r border-current"
          />
        </button>
      )}
    </div>
  );

  return createPortal(popover, document.body);
}

function KanbanTerminalPopoverTitleInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      data-testid="kanban-terminal-popover-title-input"
      autoFocus
      draggable={false}
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onSubmit(value.trim())}
      className="h-6 w-full min-w-0 rounded border border-accent/50 bg-input px-1.5 text-sm font-semibold text-fg outline-none focus:border-accent focus:bg-input-hover"
    />
  );
}

function KanbanTerminalPopoverPullRequestMetaItem({
  pullRequest,
  t,
}: {
  pullRequest: SessionPullRequestSummary;
  t: Translator;
}) {
  const draftLabel = t("rightPanel.prStates.draft");
  const tooltip = `${pullRequest.is_draft ? `${draftLabel} ` : ""}#${pullRequest.number} ${pullRequest.title}\n${pullRequest.head_branch} -> ${pullRequest.base_branch}`;
  return (
    <Tooltip label={tooltip} side="bottom" delay={350} multiline>
      <button
        type="button"
        aria-label={`${sidebarText(t, "sidebar.metadata.openPullRequest")} #${pullRequest.number}: ${pullRequest.title}`}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void openUrl(pullRequest.url).catch((err: unknown) => {
            console.error("[WorkspaceMain] open PR URL failed", err);
          });
        }}
        className={cn(
          "inline-flex min-w-0 max-w-[18rem] shrink items-center gap-1.5 rounded-sm underline-offset-2 transition hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
          pullRequestNumberClassName(pullRequest),
        )}
        title={pullRequest.title}
      >
        <GitPullRequest size={11} aria-hidden className="shrink-0" />
        <span className="shrink-0">{`PR #${pullRequest.number}`}</span>
        <span aria-hidden className="shrink-0 text-fg-muted/55">
          ·
        </span>
        <span className="min-w-0 truncate">{pullRequest.title}</span>
        {pullRequest.is_draft ? (
          <span className="shrink-0 rounded-[2px] border border-current/30 px-0.5 text-[9px] font-semibold leading-3 no-underline">
            {draftLabel}
          </span>
        ) : null}
        <ExternalLink size={10} aria-hidden className="shrink-0 opacity-80" />
      </button>
    </Tooltip>
  );
}

function isModalDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function defaultKanbanTerminalPopoverSize(): KanbanTerminalPopoverSize {
  return {
    width: KANBAN_TERMINAL_POPOVER_DEFAULT_WIDTH_PX,
    height: KANBAN_TERMINAL_POPOVER_DEFAULT_HEIGHT_PX,
  };
}

function clampKanbanTerminalPopoverPosition(
  position: KanbanTerminalPopoverPosition,
  size: KanbanTerminalPopoverSize,
): KanbanTerminalPopoverPosition {
  if (typeof window === "undefined") return position;
  const margin = KANBAN_TERMINAL_POPOVER_MARGIN_PX;
  const maxLeft = Math.max(margin, window.innerWidth - size.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - size.height - margin);
  return {
    left: Math.round(Math.min(Math.max(position.left, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(position.top, margin), maxTop)),
  };
}

function clampKanbanTerminalPopoverSize(
  size: KanbanTerminalPopoverSize,
  origin?: { left: number; top: number },
): KanbanTerminalPopoverSize {
  if (typeof window === "undefined") return size;
  const margin = KANBAN_TERMINAL_POPOVER_MARGIN_PX;
  const maxWidth = Math.max(
    240,
    window.innerWidth - (origin?.left ?? margin) - margin,
  );
  const maxHeight = Math.max(
    180,
    window.innerHeight - (origin?.top ?? margin) - margin,
  );
  const minWidth = Math.min(KANBAN_TERMINAL_POPOVER_MIN_WIDTH_PX, maxWidth);
  const minHeight = Math.min(KANBAN_TERMINAL_POPOVER_MIN_HEIGHT_PX, maxHeight);
  const width = Number.isFinite(size.width)
    ? size.width
    : KANBAN_TERMINAL_POPOVER_DEFAULT_WIDTH_PX;
  const height = Number.isFinite(size.height)
    ? size.height
    : KANBAN_TERMINAL_POPOVER_DEFAULT_HEIGHT_PX;
  return {
    width: Math.round(Math.min(Math.max(width, minWidth), maxWidth)),
    height: Math.round(Math.min(Math.max(height, minHeight), maxHeight)),
  };
}

function readKanbanTerminalPopoverSize(): KanbanTerminalPopoverSize {
  const fallback = defaultKanbanTerminalPopoverSize();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(
      KANBAN_TERMINAL_POPOVER_SIZE_STORAGE_KEY,
    );
    if (!raw) return clampKanbanTerminalPopoverSize(fallback);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return clampKanbanTerminalPopoverSize(fallback);
    }
    const stored = parsed as Partial<KanbanTerminalPopoverSize>;
    return clampKanbanTerminalPopoverSize({
      width:
        typeof stored.width === "number" && Number.isFinite(stored.width)
          ? stored.width
          : fallback.width,
      height:
        typeof stored.height === "number" && Number.isFinite(stored.height)
          ? stored.height
          : fallback.height,
    });
  } catch {
    return clampKanbanTerminalPopoverSize(fallback);
  }
}

function writeKanbanTerminalPopoverSize(
  size: KanbanTerminalPopoverSize,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KANBAN_TERMINAL_POPOVER_SIZE_STORAGE_KEY,
      JSON.stringify(clampKanbanTerminalPopoverSize(size)),
    );
  } catch {
    // Ignore storage failures; resizing should still work for the open popover.
  }
}

function KanbanSessionCardTooltip({
  t,
  title,
  userMessage,
  agentMessage,
  fallbackMessage,
  branch,
  worktreeName,
  worktreePath,
  currentPullRequest,
  processSummary,
}: {
  t: Translator;
  title: string;
  userMessage?: string;
  agentMessage?: string;
  fallbackMessage?: string;
  branch?: string;
  worktreeName: string;
  worktreePath: string;
  currentPullRequest?: SessionPullRequestSummary | null;
  processSummary?: string | null;
}) {
  const detached = t("workspace.kanban.tooltip.detached");
  const hasStructuredPreview = Boolean(userMessage || agentMessage);
  return (
    <span className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5">
      <KanbanSessionTooltipRow
        icon={<Tag size={12} />}
        label={t("workspace.kanban.tooltip.title")}
        value={title}
      />
      {hasStructuredPreview ? (
        <>
          {userMessage ? (
            <KanbanSessionTooltipRow
              icon={<MessageSquareText size={12} />}
              label={t("workspace.kanban.tooltip.lastUserMessage")}
              value={userMessage}
            />
          ) : null}
          {agentMessage ? (
            <KanbanSessionTooltipRow
              icon={<Bot size={12} />}
              label={t("workspace.kanban.tooltip.lastAgentMessage")}
              value={agentMessage}
            />
          ) : null}
        </>
      ) : (
        <KanbanSessionTooltipRow
          icon={<MessageSquareText size={12} />}
          label={t("workspace.kanban.tooltip.lastMessage")}
          value={
            fallbackMessage || t("workspace.kanban.tooltip.noLastMessage")
          }
          valueClassName={fallbackMessage ? undefined : "text-fg-muted"}
        />
      )}
      <KanbanSessionTooltipRow
        icon={<GitBranch size={12} />}
        label={t("workspace.kanban.tooltip.branch")}
        value={branch || detached}
        valueClassName="font-mono"
      />
      {currentPullRequest ? (
        <KanbanSessionTooltipRow
          icon={<GitPullRequest size={12} />}
          label={sidebarText(t, "sidebar.metadata.openPullRequest")}
          value={`#${currentPullRequest.number} ${currentPullRequest.title}`}
          valueClassName={pullRequestNumberClassName(currentPullRequest)}
        />
      ) : null}
      <KanbanSessionTooltipRow
        icon={<FolderOpen size={12} />}
        label={t("workspace.kanban.tooltip.worktree")}
        value={`${worktreeName}\n${worktreePath}`}
        valueClassName="break-all font-mono"
      />
      {processSummary ? (
        <KanbanSessionTooltipRow
          icon={<Activity size={12} />}
          label={sidebarText(t, "sidebar.metadata.processes")}
          value={processSummary}
          valueClassName="font-mono"
        />
      ) : null}
    </span>
  );
}

function KanbanSessionTooltipRow({
  icon,
  label,
  value,
  valueClassName,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border/70 bg-bg/60 text-fg-muted"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] leading-3 text-fg-muted">
          {label}
        </span>
        <span
          className={cn(
            "block min-w-0 whitespace-pre-line break-words text-[11px] leading-snug text-fg",
            valueClassName,
          )}
        >
          {value}
        </span>
      </span>
    </span>
  );
}

function WorkspaceSessionIcon({
  session,
  scope,
  size = "sm",
  className,
}: {
  session: Session;
  scope: "kanban" | "console";
  size?: "sm" | "md";
  className?: string;
}) {
  const agentProvider = resolveSessionAgentProvider(session);
  const fallbackKind =
    session.kind === "control"
      ? "control"
      : session.mode === "chat"
        ? "chat"
        : "terminal";
  const isMedium = size === "md";
  const primaryClassName = cn(
    isMedium ? "size-6 rounded-md" : "size-5 rounded",
    "shrink-0 border border-border bg-bg-elevated",
    "flex items-center justify-center transition-colors",
    session.status === "waiting_for_input" && "border-warning/35",
    session.status === "errored" && "border-danger/35",
    session.status === "working" && "border-accent/35",
    STATUS_ICON_CLASS[session.status],
  );

  return (
    <span
      className={cn("shrink-0", scope === "kanban" && "mt-px", className)}
      aria-hidden="true"
      data-kanban-agent-icon={
        scope === "kanban" ? agentProvider ?? undefined : undefined
      }
      data-kanban-session-icon={
        scope === "kanban" ? agentProvider ?? fallbackKind : undefined
      }
      data-kanban-icon-status={scope === "kanban" ? session.status : undefined}
      data-console-agent-icon={
        scope === "console" ? agentProvider ?? undefined : undefined
      }
      data-console-session-icon={
        scope === "console" ? agentProvider ?? fallbackKind : undefined
      }
      data-console-icon-status={
        scope === "console" ? session.status : undefined
      }
    >
      <span className={primaryClassName}>
        {agentProvider ? (
          <AgentProviderIcon
            provider={agentProvider}
            className={isMedium ? "size-3.5" : "size-3"}
          />
        ) : fallbackKind === "control" ? (
          <Bot size={isMedium ? 14 : 12} />
        ) : fallbackKind === "chat" ? (
          <MessageSquareText size={isMedium ? 14 : 12} />
        ) : (
          <TerminalIcon size={isMedium ? 14 : 12} />
        )}
      </span>
    </span>
  );
}

function cleanWorkspaceSessionTerminalPopoverTitle(title: string): string {
  const cleaned = title.replace(/\s+-\s*$/u, "").trimEnd();
  return cleaned.length > 0 ? cleaned : title;
}

function WorkspaceSessionTerminalPopoverMetaItem({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex min-w-0 shrink items-center gap-1.5"
      title={title}
    >
      <span
        className="inline-flex h-4 shrink-0 items-center justify-center text-fg-muted/75"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function statusLabel(t: Translator, status: SessionStatus): string {
  switch (status) {
    case "ready":
      return t("sidebar.status.ready");
    case "working":
      return t("sidebar.status.working");
    case "waiting_for_input":
      return t("sidebar.status.waiting_for_input");
    case "errored":
      return t("sidebar.status.errored");
  }
}

function stageLabel(t: Translator, stage: KanbanLifecycleStage): string {
  switch (stage) {
    case "idle":
      return t("workspace.kanban.stage.idle");
    case "working":
      return t("workspace.kanban.stage.working");
    case "waiting":
      return t("workspace.kanban.stage.waiting");
    case "review":
      return t("workspace.kanban.stage.review");
    case "done":
      return t("workspace.kanban.stage.done");
  }
}

function statusReasonLabel(
  t: Translator,
  reason: SessionStatusReason | null | undefined,
): string | null {
  switch (reason) {
    case "turn_complete":
      return t("sidebar.statusReason.turn_complete");
    case "shell_prompt":
      return t("sidebar.statusReason.shell_prompt");
    default:
      return null;
  }
}

function statusDetailLabel(t: Translator, session: Session): string {
  const label = statusLabel(t, session.status);
  const reason = statusReasonLabel(t, session.status_reason);
  return reason ? `${label} · ${reason}` : label;
}

function sidebarText(t: Translator, key: SidebarTranslationKey): string {
  return t(key);
}

function workspaceContextMenuGroupTitle(
  t: Translator,
  group: WorkspaceKanbanContextGroup,
): ContextMenuItem {
  return {
    type: "group-title",
    label: sidebarText(t, `sidebar.contextMenu.${group}`),
  };
}

function cssAttributeEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/(["\\\]\[])/g, "\\$1");
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch (err) {
    console.warn("[WorkspaceMain] clipboard write failed", err);
  }
}
