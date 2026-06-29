import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  BarChart3,
  Bot,
  ChevronDown,
  CheckCircle2,
  Columns3,
  Copy,
  FolderOpen,
  GitBranch,
  MessageSquareText,
  PencilLine,
  Plus,
  RotateCcw,
  Search,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openInConfiguredEditor } from "../lib/editor";
import type { LayoutNode } from "../lib/layout";
import { basename } from "../lib/pathUtils";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  PROJECT_SESSION_CREATE_MENU,
  type ProjectSessionCreateAction,
} from "../lib/projectSessionCreateActions";
import { canConfigureSessionAutoClose } from "../lib/sessionAgentState";
import type { Session, SessionStatus } from "../lib/types";
import {
  AgentProviderIcon,
  resolveSessionAgentProvider,
} from "../lib/agentProvider";
import { useDialogShortcuts } from "../lib/dialog";
import { useSettings } from "../lib/settings";
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
import { IconButton, Modal, StatusDot, type StatusTone } from "./ui";
import { ChatPane } from "./ChatPane";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { LayoutRenderer } from "./LayoutRenderer";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";

const STATUS_TONE: Record<SessionStatus, StatusTone> = {
  idle: "neutral",
  running: "accent",
  needs_input: "warning",
  failed: "danger",
  completed: "success",
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
  idle: "text-fg-muted",
  running: "text-accent",
  needs_input: "text-warning",
  failed: "text-danger",
  completed: "text-accent/70",
};

type SidebarTranslationKey = Extract<TranslationKey, `sidebar.${string}`>;
type WorkspaceKanbanContextGroup = "session" | "open" | "copy" | "danger";

const KANBAN_COLUMN_GAP_PX = 6;
const KANBAN_BOARD_PADDING_X_PX = 16;

interface WorkspaceMainProps {
  layout: LayoutNode;
  viewMode: WorkspaceViewMode;
}

export function WorkspaceMain({ layout, viewMode }: WorkspaceMainProps) {
  return (
    <div className="h-full min-w-0" data-workspace-main>
      {viewMode === "kanban" ? (
        <WorkspaceKanbanBoard />
      ) : (
        <LayoutRenderer node={layout} />
      )}
      <WorkspaceSessionPopup />
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
  const openTerminalPopup = useAppStore((s) => s.openTerminalPopup);
  const [prefs, setPrefs] = useState<KanbanBoardPrefs>(() =>
    readKanbanBoardPrefs(projectId),
  );
  const { filterQuery, sortMode, columnWidths } = prefs;
  const [resizingColumnIndex, setResizingColumnIndex] = useState<number | null>(
    null,
  );

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

  // Persist board prefs per project. projectId is fixed for this instance (the
  // wrapper remounts via key on project switch), so a board can never write one
  // project's prefs into another project's bucket.
  useEffect(() => {
    writeKanbanBoardPrefs(projectId, prefs);
  }, [projectId, prefs]);

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

  function openSession(id: string) {
    openTerminalPopup(id);
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent("acorn:focus-session", {
            detail: { sessionId: id },
          }),
        );
      });
    }
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

    const startX = event.clientX;
    const startWidth = columnWidths[index] ?? KANBAN_COLUMN_DEFAULT_WIDTH;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingColumnIndex(index);

    function cleanup() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizingColumnIndex(null);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    }

    function onPointerMove(moveEvent: PointerEvent) {
      resizeColumn(index, startWidth + moveEvent.clientX - startX);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
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
                  className="h-full min-h-0 shrink-0"
                  style={{
                    width: `${
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
                        pulse={column.status === "running"}
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
                            onOpen={() => openSession(session.id)}
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

function KanbanSessionCard({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: () => void;
}) {
  const t = useTranslation();
  const worktreeName = basename(session.worktree_path);
  const statusTone = STATUS_TONE[session.status];
  const selectSession = useAppStore((s) => s.selectSession);
  const openWorkSummaryTab = useAppStore((s) => s.openWorkSummaryTab);
  const setWorkspaceViewMode = useAppStore((s) => s.setWorkspaceViewMode);
  const toggleSessionAutoClose = useAppStore(
    (s) => s.toggleSessionAutoClose,
  );
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const autoCloseEnabled = useAppStore((s) =>
    Boolean(s.autoCloseSessionIds[session.id]),
  );
  const editorCommand = useSettings((s) => s.settings.editor.command);
  const editorConfigured = editorCommand.trim().length > 0;
  const canConfigureAutoClose = canConfigureSessionAutoClose(session);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openLabel = t("workspace.kanban.openSession").replace(
    "{name}",
    session.name,
  );
  const sessionMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      workspaceContextMenuGroupTitle(t, "session"),
      {
        label: openLabel,
        icon:
          session.mode === "chat" ? (
            <MessageSquareText size={12} />
          ) : (
            <TerminalIcon size={12} />
          ),
        onClick: onOpen,
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
      ...(canConfigureAutoClose
        ? [
            {
              type: "checkbox",
              label: sidebarText(t, "sidebar.actions.autoCloseWhenFinished"),
              checked: autoCloseEnabled,
              onChange: () => toggleSessionAutoClose(session.id),
            } satisfies ContextMenuItem,
          ]
        : []),
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
      autoCloseEnabled,
      canConfigureAutoClose,
      editorConfigured,
      onOpen,
      openLabel,
      openWorkSummaryTab,
      requestRemoveSession,
      selectSession,
      session.branch,
      session.id,
      session.mode,
      session.worktree_path,
      setWorkspaceViewMode,
      t,
      toggleSessionAutoClose,
      worktreeName,
    ],
  );

  return (
    <>
      <Tooltip
        label={session.worktree_path}
        side="right"
        multiline
        className="flex w-full"
      >
        <button
          type="button"
          data-testid="workspace-kanban-card"
          data-kanban-session-id={session.id}
          onClick={onOpen}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          className="group flex w-full flex-col gap-2 rounded-md border border-border bg-bg-elevated/45 p-2 text-left transition hover:border-accent/45 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={openLabel}
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <WorkspaceSessionIcon session={session} scope="kanban" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium leading-5 text-fg">
                {session.name}
              </span>
              <span className="block truncate text-[11px] leading-4 text-fg-muted">
                {worktreeName}
              </span>
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[10px] leading-none text-fg-muted">
            <StatusDot
              tone={statusTone}
              pulse={session.status === "running"}
              size="xs"
            />
            <span className="truncate">{statusLabel(t, session.status)}</span>
            {session.branch ? (
              <>
                <span className="text-fg-muted/45">|</span>
                <GitBranch size={10} className="shrink-0" />
                <span className="min-w-0 truncate">{session.branch}</span>
              </>
            ) : null}
            {session.kind === "control" ? (
              <>
                <span className="text-fg-muted/45">|</span>
                <Bot size={10} className="shrink-0 text-accent" />
              </>
            ) : null}
            {session.status === "completed" ? (
              <CheckCircle2
                size={10}
                className="ml-auto shrink-0 text-accent"
              />
            ) : null}
          </span>
        </button>
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
}

function WorkspaceSessionIcon({
  session,
  scope,
  size = "sm",
  className,
}: {
  session: Session;
  scope: "kanban" | "popup";
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
    session.status === "needs_input" && "border-warning/35",
    session.status === "failed" && "border-danger/35",
    session.status === "running" && "border-accent/35",
    session.status === "completed" && "border-accent/25",
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
      data-popup-agent-icon={
        scope === "popup" ? agentProvider ?? undefined : undefined
      }
      data-popup-session-icon={
        scope === "popup" ? agentProvider ?? fallbackKind : undefined
      }
      data-popup-icon-status={scope === "popup" ? session.status : undefined}
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

function WorkspaceSessionPopupHeader({
  session,
  titleId,
  t,
  onClose,
}: {
  session: Session;
  titleId: string;
  t: Translator;
  onClose: () => void;
}) {
  const worktreeName = basename(session.worktree_path);
  const statusTone = STATUS_TONE[session.status];
  const title = cleanWorkspaceSessionPopupTitle(session.name);

  return (
    <header className="shrink-0 border-b border-border bg-bg-elevated/70 px-4 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg shadow-sm">
            <WorkspaceSessionIcon session={session} scope="popup" size="md" />
          </span>
          <div className="min-w-0 flex-1">
            <h3
              id={titleId}
              className="truncate text-sm font-semibold tracking-tight text-fg"
            >
              {title}
            </h3>
            <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[11px] font-medium leading-4 text-fg-muted">
              <WorkspaceSessionPopupMetaItem
                icon={
                  <StatusDot
                    tone={statusTone}
                    pulse={session.status === "running"}
                    size="xs"
                  />
                }
              >
                {statusLabel(t, session.status)}
              </WorkspaceSessionPopupMetaItem>
              <WorkspaceSessionPopupMetaItem
                icon={<FolderOpen size={11} />}
                title={session.worktree_path}
              >
                {worktreeName}
              </WorkspaceSessionPopupMetaItem>
              {session.branch ? (
                <WorkspaceSessionPopupMetaItem icon={<GitBranch size={11} />}>
                  {session.branch}
                </WorkspaceSessionPopupMetaItem>
              ) : null}
              {session.mode === "chat" ? (
                <WorkspaceSessionPopupMetaItem
                  icon={<MessageSquareText size={11} />}
                >
                  {t("sidebar.aria.chatSession")}
                </WorkspaceSessionPopupMetaItem>
              ) : null}
              {session.kind === "control" ? (
                <WorkspaceSessionPopupMetaItem icon={<Bot size={11} />}>
                  {t("sidebar.aria.controlSession")}
                </WorkspaceSessionPopupMetaItem>
              ) : null}
            </div>
          </div>
        </div>
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
  );
}

function cleanWorkspaceSessionPopupTitle(title: string): string {
  const cleaned = title.replace(/\s+-\s*$/u, "").trimEnd();
  return cleaned.length > 0 ? cleaned : title;
}

function WorkspaceSessionPopupMetaItem({
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

function WorkspaceSessionPopup() {
  const titleId = useId();
  const t = useTranslation();
  const sessionsById = useAppStore(selectSessionsById);
  const sessionId = useAppStore((s) => s.terminalPopupSessionId);
  const closeTerminalPopup = useAppStore((s) => s.closeTerminalPopup);
  const session = sessionId ? sessionsById.get(sessionId) ?? null : null;
  const open = session !== null;

  useDialogShortcuts(open, { onCancel: closeTerminalPopup });

  useEffect(() => {
    if (!sessionId || session) return;
    closeTerminalPopup();
  }, [closeTerminalPopup, session, sessionId]);

  const isChat = session?.mode === "chat";

  return (
    <Modal
      open={open}
      onClose={closeTerminalPopup}
      variant="panel"
      size="5xl"
      ariaLabelledBy={titleId}
      className="h-[min(82vh,54rem)] max-w-[min(76rem,calc(100vw-2rem))] border-border/80 bg-bg-elevated/95"
    >
      {session ? (
        <>
          <WorkspaceSessionPopupHeader
            session={session}
            titleId={titleId}
            t={t}
            onClose={closeTerminalPopup}
          />
          <div className="min-h-0 flex-1 bg-bg p-2">
            {isChat ? (
              <div className="relative h-full min-h-0 overflow-hidden rounded-md border border-border bg-bg shadow-inner">
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
                data-terminal-popup-body={session.id}
                data-testid="terminal-popup-body"
              />
            )}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function statusLabel(t: Translator, status: SessionStatus): string {
  switch (status) {
    case "idle":
      return t("sidebar.status.idle");
    case "running":
      return t("sidebar.status.running");
    case "needs_input":
      return t("sidebar.status.needs_input");
    case "failed":
      return t("sidebar.status.failed");
    case "completed":
      return t("sidebar.status.completed");
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

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[WorkspaceMain] clipboard write failed", err);
  }
}
