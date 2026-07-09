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
  Bot,
  ChevronDown,
  Columns3,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitPullRequest,
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
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openInConfiguredEditor } from "../lib/editor";
import type { LayoutNode } from "../lib/layout";
import { basename } from "../lib/pathUtils";
import { pullRequestNumberClassName } from "../lib/pullRequestPresentation";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  PROJECT_SESSION_CREATE_MENU,
  type ProjectSessionCreateAction,
} from "../lib/projectSessionCreateActions";
import {
  canRegenerateSessionTitle,
  canRenameSession,
} from "../lib/sessionTitle";
import type {
  Session,
  SessionPullRequestSummary,
  SessionStatus,
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
import {
  KANBAN_COLUMN_STATUSES,
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
  selectSessionsById,
  useAppStore,
  type WorkspaceViewMode,
} from "../store";
import { IconButton, StatusDot, type StatusTone } from "./ui";
import { ChatPane } from "./ChatPane";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { LayoutRenderer } from "./LayoutRenderer";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";

const STATUS_TONE: Record<SessionStatus, StatusTone> = {
  ready: "neutral",
  working: "accent",
  waiting_for_input: "warning",
  errored: "danger",
};

// Pair each column status (ordered by the board library) with its UI tone, so
// the column order has a single source of truth in `kanbanBoard.ts`.
const KANBAN_COLUMNS: ReadonlyArray<{
  status: SessionStatus;
  tone: StatusTone;
}> = KANBAN_COLUMN_STATUSES.map((status) => ({
  status,
  tone: STATUS_TONE[status],
}));

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
  const closeTerminalPopup = useAppStore((s) => s.closeTerminalPopup);

  useEffect(() => {
    if (!isKanban) closeTerminalPopup();
  }, [closeTerminalPopup, isKanban]);

  return (
    <div className="h-full min-w-0 overflow-hidden" data-workspace-main>
      {isKanban ? (
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1">
            <WorkspaceKanbanBoard />
          </div>
        </div>
      ) : null}
      {/*
        Keep the pane layout mounted (hidden) in kanban mode instead of
        unmounting it. TerminalHost appendChild's each live terminal's target
        div into a pane body; unmounting the layout orphans those divs, so
        returning to panes shows blank terminals until an unrelated reattach.
        Hiding preserves the pane-body DOM identity so the terminals stay put.
      */}
      <div className={cn("h-full min-w-0", isKanban && "hidden")}>
        <LayoutRenderer node={layout} />
      </div>
    </div>
  );
}

function WorkspaceKanbanBoard() {
  // Remount per project so each board hydrates its own persisted prefs through
  // the useState initializer rather than racing an effect to swap them in.
  const projectId = useAppStore((s) => s.activeProject);
  return (
    <KanbanBoard key={projectId ?? "__no-project__"} projectId={projectId} />
  );
}

function KanbanBoard({ projectId }: { projectId: string | null }) {
  const t = useTranslation();
  const panes = useAppStore((s) => s.panes);
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

  const sessions = useMemo(() => {
    const ordered: Session[] = [];
    const seen = new Set<string>();
    for (const pane of Object.values(panes)) {
      for (const id of pane.tabIds) {
        if (seen.has(id)) continue;
        const session = sessionsById.get(id);
        if (!session) continue;
        seen.add(id);
        ordered.push(session);
      }
    }
    return ordered;
  }, [panes, sessionsById]);

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

  const sessionsByStatus = useMemo(() => {
    const grouped = new Map<SessionStatus, Session[]>();
    for (const { status } of KANBAN_COLUMNS) grouped.set(status, []);
    for (const session of visibleSessions) {
      grouped.get(session.status)?.push(session);
    }
    return grouped;
  }, [visibleSessions]);

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
        sessionsByStatus,
        sessionId,
        direction,
      );
      if (nextSessionId) focusKanbanSessionCard(nextSessionId);
    },
    [focusKanbanSessionCard, sessionsByStatus],
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
            const columnSessions = sessionsByStatus.get(column.status) ?? [];
            const label = statusLabel(t, column.status);
            return (
              <Fragment key={column.status}>
                <div
                  className="h-full min-w-0 grow shrink-0"
                  style={{
                    flexBasis: `${
                      columnWidths[columnIndex] ?? KANBAN_COLUMN_DEFAULT_WIDTH
                    }px`,
                  }}
                >
                  <section
                    className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg"
                    aria-label={label}
                    data-kanban-column-status={column.status}
                  >
                    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
                      <StatusDot
                        tone={column.tone}
                        pulse={column.status === "working"}
                      />
                      <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
                        {label}
                      </h2>
                      <span className="rounded bg-fg-muted/10 px-1.5 py-px text-[10px] tabular-nums text-fg-muted">
                        {columnSessions.length}
                      </span>
                    </header>
                    <div className="acorn-no-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                      {columnSessions.length > 0 ? (
                        columnSessions.map((session) => (
                          <KanbanSessionCard
                            key={session.id}
                            session={session}
                            onOpen={openSessionTerminal}
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
                    data-kanban-resize-status={column.status}
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
    </div>
  );
}

type KanbanActionEvent =
  | "acorn:new-session"
  | "acorn:new-isolated-session"
  | "acorn:new-chat-session"
  | "acorn:new-control-session";

const KANBAN_CREATE_ACTION_EVENTS: Record<
  ProjectSessionCreateAction["id"],
  KanbanActionEvent
> = {
  terminal: "acorn:new-session",
  isolated: "acorn:new-isolated-session",
  chat: "acorn:new-chat-session",
  control: "acorn:new-control-session",
};

function dispatchKanbanAction(eventName: KanbanActionEvent) {
  window.dispatchEvent(new CustomEvent(eventName));
}

function kanbanSessionCreateIcon(id: ProjectSessionCreateAction["id"]) {
  switch (id) {
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
  const menuItems = useMemo<ContextMenuItem[]>(
    () => [
      workspaceContextMenuGroupTitle(t, "session"),
      ...PROJECT_SESSION_CREATE_MENU.map((item) => {
        if (item.type === "separator") return { type: "separator" as const };
        const action = item.action;
        return {
          label: sidebarText(t, action.labelKey),
          icon: kanbanSessionCreateIcon(action.id),
          onClick: () =>
            dispatchKanbanAction(KANBAN_CREATE_ACTION_EVENTS[action.id]),
        };
      }),
    ],
    [t],
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
  sessionsByStatus: ReadonlyMap<SessionStatus, readonly Session[]>,
  sessionId: string,
  direction: KanbanCardFocusDirection,
): string | null {
  const columns = KANBAN_COLUMNS.map(
    ({ status }) => sessionsByStatus.get(status) ?? [],
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
  onOpen,
  onFocusAdjacent,
}: {
  session: Session;
  onOpen: (sessionId: string, anchor: HTMLElement) => void;
  onFocusAdjacent: (
    sessionId: string,
    direction: KanbanCardFocusDirection,
  ) => void;
}) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const worktreeName = basename(session.worktree_path);
  const branchName = session.branch?.trim();
  const lastMessage =
    session.last_agent_message?.trim() || session.last_message?.trim();
  const selectSession = useAppStore((s) => s.selectSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const generateSessionTitle = useAppStore((s) => s.generateSessionTitle);
  const openWorkSummaryTab = useAppStore((s) => s.openWorkSummaryTab);
  const setWorkspaceViewMode = useAppStore((s) => s.setWorkspaceViewMode);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
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

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (editing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(session.id, event.currentTarget);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      if (canRename) setEditing(true);
      return;
    }
    const direction = kanbanCardFocusDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    onFocusAdjacent(session.id, direction);
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
        label: openLabel,
        icon:
          session.mode === "chat" ? (
            <MessageSquareText size={12} />
          ) : (
            <TerminalIcon size={12} />
          ),
        onClick: () => {
          const anchor = document.querySelector<HTMLElement>(
            `[data-kanban-session-id="${cssAttributeEscape(session.id)}"]`,
          );
          if (anchor) onOpen(session.id, anchor);
        },
      },
      {
        label: sidebarText(t, "sidebar.actions.openWorkSummary"),
        icon: <BarChart3 size={12} />,
        onClick: () => {
          selectSession(session.id);
          void openWorkSummaryTab({ sessionId: session.id })
            .then(() => setWorkspaceViewMode("panes"))
            .catch((err: unknown) => {
              console.error("[WorkspaceMain] open work summary failed", err);
            });
        },
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
      onOpen,
      openLabel,
      openWorkSummaryTab,
      renameSession,
      requestRemoveSession,
      selectSession,
      session.branch,
      session.id,
      session.mode,
      session.name,
      session.worktree_path,
      showToast,
      setWorkspaceViewMode,
      t,
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
            lastMessage={lastMessage}
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
        <div
          role="button"
          tabIndex={0}
          data-testid="workspace-kanban-card"
          data-kanban-session-id={session.id}
          onClick={editing ? undefined : handleOpen}
          onPointerDown={handlePointerDown}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          className="group flex w-full flex-col gap-2 rounded-md border border-border bg-bg-elevated/45 p-2 text-left transition hover:border-accent/45 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
          </span>
          {lastMessage ? (
            <span
              className="line-clamp-2 text-[11px] leading-4 text-fg-muted"
              data-testid="workspace-kanban-card-last-message"
            >
              {lastMessage}
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
  const popoverPlacement = useSettings(
    (s) => s.settings.interface.kanbanTerminalPopoverPlacement,
  );
  const popoverDefaultSize = useSettings(
    (s) => s.settings.interface.kanbanTerminalPopoverDefaultSize,
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
  const positionRef = useRef<KanbanTerminalPopoverPosition | null>(null);
  const sizeRef = useRef(size);
  const hasManualPositionRef = useRef(false);

  const worktreeName = basename(session.worktree_path);
  const title = cleanWorkspaceSessionTerminalPopoverTitle(session.name);
  const statusTone = STATUS_TONE[session.status];
  const isChat = session.mode === "chat";

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
      target.closest("button,a,input,textarea,select")
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
            <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>
            <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[11px] font-medium leading-4 text-fg-muted">
              <WorkspaceSessionTerminalPopoverMetaItem
                icon={
                  <StatusDot
                    tone={statusTone}
                    pulse={session.status === "working"}
                    size="xs"
                  />
                }
              >
                {statusLabel(t, session.status)}
              </WorkspaceSessionTerminalPopoverMetaItem>
              {session.branch ? (
                <WorkspaceSessionTerminalPopoverMetaItem icon={<GitBranch size={11} />}>
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
          <IconButton
            aria-label={t("dialogs.common.close")}
            onClick={onClose}
            size="sm"
            surface="panel"
          >
            <X size={14} />
          </IconButton>
        </div>
      </header>
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
  lastMessage,
  branch,
  worktreeName,
  worktreePath,
  currentPullRequest,
  processSummary,
}: {
  t: Translator;
  title: string;
  lastMessage?: string;
  branch?: string;
  worktreeName: string;
  worktreePath: string;
  currentPullRequest?: SessionPullRequestSummary | null;
  processSummary?: string | null;
}) {
  const detached = t("workspace.kanban.tooltip.detached");
  return (
    <span className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5">
      <KanbanSessionTooltipRow
        icon={<Tag size={12} />}
        label={t("workspace.kanban.tooltip.title")}
        value={title}
      />
      <KanbanSessionTooltipRow
        icon={<MessageSquareText size={12} />}
        label={t("workspace.kanban.tooltip.lastMessage")}
        value={lastMessage || t("workspace.kanban.tooltip.noLastMessage")}
        valueClassName={lastMessage ? undefined : "text-fg-muted"}
      />
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
  const showAgentProviderIcons = useSettings(
    (s) => s.settings.sessionDisplay.icons.agentProvider,
  );
  const agentProvider = showAgentProviderIcons
    ? resolveSessionAgentProvider(session)
    : null;
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
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[WorkspaceMain] clipboard write failed", err);
  }
}
