import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ListChecks, Pencil, Play, SquareTerminal, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { isSessionAgentProvider } from "../lib/agentProviderRegistry";
import type { TranslationKey } from "../lib/i18n";
import { isArchivedSession } from "../lib/sessionArchive";
import { useSyntheticDoubleClick } from "../lib/doubleClick";
import { taskAbsoluteTime, taskAgeLabel } from "../lib/taskAge";
import { useSettings } from "../lib/settings";
import {
  buildTaskAgentCommand,
  launchTaskStartWork,
} from "../lib/taskStartWork";
import { useToasts } from "../lib/toasts";
import type {
  ProjectTask,
  ProjectTaskComment,
  ProjectTaskStatus,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Tooltip } from "./Tooltip";
import {
  Button,
  ListActionRow,
  ListEmptyState,
  Modal,
  ModalFooter,
  ModalHeader,
  RefreshButton,
  TEXT_INPUT_CLASS,
  listBoxClassName,
} from "./ui";
import { cn } from "../lib/cn";

const CLOSED_STATUSES = new Set<ProjectTaskStatus>(["done", "canceled"]);

const TASK_LIST_FILTERS: ProjectTaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
];

// `null` is All. Done and canceled stay out of this row — their section
// headers filter the list — so the chips that remain can scroll without
// pushing Refresh and New off the right edge.
const CHIP_FILTERS: (ProjectTaskStatus | null)[] = [
  null,
  "todo",
  "in_progress",
  "in_review",
];

// The comment list grows with its notes, then stops and scrolls. Older notes
// stay out of the DOM until the reader asks for them.
const COMMENT_PAGE = 20;

const STATUS_LABEL: Record<ProjectTaskStatus, TranslationKey> = {
  todo: "rightPanel.tasks.status.todo",
  in_progress: "rightPanel.tasks.status.in_progress",
  in_review: "rightPanel.tasks.status.in_review",
  done: "rightPanel.tasks.status.done",
  canceled: "rightPanel.tasks.status.canceled",
};

// Modal `#number` and the list's status word. Distinct hues so a glance
// tells the state apart. List numbers stay emerald/muted (open vs closed),
// same as GitHub issue rows.
const STATUS_TONE: Record<ProjectTaskStatus, string> = {
  todo: "text-emerald-400",
  in_progress: "text-amber-400",
  in_review: "text-sky-400",
  done: "text-purple-400",
  canceled: "text-rose-400",
};

export function WorkspaceTasksTab({
  repoPath,
  originSessionId,
}: {
  repoPath: string;
  originSessionId: string | null;
}) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const sessions = useAppStore((s) => s.sessions);
  const openSessionSurface = useAppStore((s) => s.openSessionSurface);
  const setPendingTerminalInput = useAppStore((s) => s.setPendingTerminalInput);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<ProjectTaskStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; task: ProjectTask } | null
  >(null);
  const [detail, setDetail] = useState<ProjectTask | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    task: ProjectTask;
  } | null>(null);
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  // A list response that started before a create, edit, or delete must not
  // paint over that newer write.
  const listEpoch = useRef(0);
  const onEmptyAreaClick = useSyntheticDoubleClick(() =>
    setEditor({ mode: "create" }),
  );
  const toggleListFilter = (status: ProjectTaskStatus) =>
    setListFilter((current) => (current === status ? null : status));

  useEffect(() => {
    let cancelled = false;
    const epoch = listEpoch.current;
    setLoading(true);
    setError(null);
    api
      .listProjectTasks(repoPath)
      .then((next) => {
        if (cancelled || listEpoch.current !== epoch) return;
        const loaded = Array.isArray(next) ? next : [];
        setTasks(loaded);
        setDetail((current) => {
          if (!current) return current;
          return loaded.find((task) => task.id === current.id) ?? null;
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, revision]);

  function replaceTask(next: ProjectTask) {
    listEpoch.current += 1;
    setTasks((current) =>
      current.map((task) => (task.id === next.id ? next : task)),
    );
    setDetail((current) => (current?.id === next.id ? next : current));
  }

  async function startWork(task: ProjectTask) {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const result = await launchTaskStartWork(repoPath, task);
      if (!result.ok) {
        showToast(
          `${t("toasts.session.createFailed")} ${result.error ?? t("rightPanel.errors.startWorkFailed")}`,
        );
        return;
      }
      try {
        const next = await api.updateProjectTask(repoPath, task.id, {
          status: "in_progress",
          sessionId: result.session.id,
          setSessionId: true,
        });
        replaceTask(next);
      } catch (cause) {
        showToast(`${t("rightPanel.tasks.saveFailed")} ${String(cause)}`);
      }
      openSessionSurface(result.session.id);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  async function sendToSession(task: ProjectTask, sessionId: string) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || isArchivedSession(session)) return;
    const selected = useSettings.getState().settings.agents.selected;
    const agentProvider = isSessionAgentProvider(selected) ? selected : null;
    if (agentProvider) {
      const command = await buildTaskAgentCommand(
        repoPath,
        task,
        session.branch,
        agentProvider,
      );
      setPendingTerminalInput(session.id, command, {
        agentProvider,
        adoptWorktreeOnExit: false,
      });
    }
    try {
      const next = await api.updateProjectTask(repoPath, task.id, {
        status: "in_progress",
        sessionId: session.id,
        setSessionId: true,
      });
      replaceTask(next);
    } catch (cause) {
      showToast(`${t("rightPanel.tasks.saveFailed")} ${String(cause)}`);
    }
    openSessionSurface(session.id);
  }

  function removeTask(id: string) {
    return api
      .deleteProjectTask(repoPath, id)
      .then(() => {
        listEpoch.current += 1;
        setTasks((current) => current.filter((task) => task.id !== id));
        setDetail((current) => (current?.id === id ? null : current));
      })
      .catch((cause: unknown) => {
        showToast(`${t("rightPanel.tasks.deleteFailed")} ${String(cause)}`);
      });
  }

  const groups = TASK_LIST_FILTERS.flatMap((status) => {
    if (listFilter !== null && status !== listFilter) return [];
    const items = tasks.filter((task) => task.status === status);
    if (items.length === 0) return [];
    return [{ status, items }];
  });
  const menuTask = menu?.task ?? null;
  const linkedSession = menuTask
    ? sessions.find((session) => session.id === menuTask.session_id)
    : undefined;
  const originSession = menuTask?.origin_session_id
    ? sessions.find((session) => session.id === menuTask.origin_session_id)
    : undefined;
  const canSendToOrigin = Boolean(
    originSession &&
      !isArchivedSession(originSession) &&
      originSession.id !== linkedSession?.id,
  );

  const menuItems: ContextMenuItem[] = menuTask
    ? [
        {
          label: t("rightPanel.menu.openDetail"),
          icon: <ListChecks size={12} />,
          onClick: () => setDetail(menuTask),
        },
        {
          label: t("rightPanel.tasks.edit"),
          icon: <Pencil size={12} />,
          onClick: () => setEditor({ mode: "edit", task: menuTask }),
        },
        linkedSession
          ? {
              label: t("rightPanel.menu.openSession"),
              icon: <SquareTerminal size={12} />,
              onClick: () => openSessionSurface(linkedSession.id),
            }
          : {
              label: t("rightPanel.menu.startWork"),
              icon: <Play size={12} />,
              disabled: starting,
              onClick: () => void startWork(menuTask),
            },
        ...(canSendToOrigin && originSession
          ? [
              {
                label: t("rightPanel.tasks.sendToSession"),
                icon: <SquareTerminal size={12} />,
                onClick: () => void sendToSession(menuTask, originSession.id),
              } satisfies ContextMenuItem,
            ]
          : []),
        { type: "separator" },
        {
          label: t("rightPanel.tasks.delete"),
          icon: <Trash2 size={12} />,
          onClick: () => void removeTask(menuTask.id),
        },
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border">
        <div className="acorn-no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5">
          {CHIP_FILTERS.map((filter) => (
            <button
              key={filter ?? "all"}
              type="button"
              aria-pressed={listFilter === filter}
              onClick={() =>
                filter === null ? setListFilter(null) : toggleListFilter(filter)
              }
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 text-[11px] transition",
                listFilter === filter
                  ? "bg-bg-elevated text-fg"
                  : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
              )}
            >
              {filter === null
                ? t("rightPanel.tasks.allFilter")
                : t(STATUS_LABEL[filter])}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
          <RefreshButton
            loading={loading}
            size={12}
            title={t("rightPanel.tasks.refresh")}
            ariaLabel={t("rightPanel.tasks.refresh")}
            onClick={() => setRevision((current) => current + 1)}
          />
          <Button
            type="button"
            variant="primary"
            size="xs"
            onClick={() => setEditor({ mode: "create" })}
          >
            {t("rightPanel.tasks.new")}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="px-3 pb-2 text-xs text-danger" role="alert">
          {t("rightPanel.tasks.loadFailed")} {error}
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onClick={(event) => {
          // A second click on a row is the row's own open gesture.
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest("[data-task-row], [data-task-group-header]")) return;
          // New tasks are created as todo, so a double-click under another
          // filter would save a row this list cannot show.
          if (listFilter !== null && listFilter !== "todo") return;
          onEmptyAreaClick(event);
        }}
      >
        {loading && tasks.length === 0 ? (
          <ListEmptyState>{t("rightPanel.tasks.loading")}</ListEmptyState>
        ) : groups.length === 0 ? (
          <ListEmptyState>
            {listFilter !== null && tasks.length > 0
              ? t("rightPanel.tasks.emptyFiltered").replace(
                  "{status}",
                  t(STATUS_LABEL[listFilter]),
                )
              : t("rightPanel.tasks.empty")}
          </ListEmptyState>
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => (
              <section key={group.status}>
                {listFilter === null ? (
                  <button
                    type="button"
                    data-task-group-header
                    onClick={() => toggleListFilter(group.status)}
                    className="flex w-full items-center px-3 pt-2 pb-0.5 text-left text-[10px] font-medium uppercase tracking-wide text-fg-muted"
                  >
                    <span className={STATUS_TONE[group.status]}>
                      {t(STATUS_LABEL[group.status])}
                    </span>
                  </button>
                ) : null}
                <ul className={listBoxClassName()}>
                  {group.items.map((task) => (
                    <ListActionRow
                      key={task.id}
                      data-task-row
                      surface="subtle"
                      density="compact"
                      onOpen={() => setDetail(task)}
                      onClick={() => setDetail(task)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({ x: event.clientX, y: event.clientY, task });
                      }}
                      className="flex items-center gap-2 text-left text-xs"
                    >
                      <span
                        className={cn(
                          "shrink-0 font-mono tabular-nums",
                          CLOSED_STATUSES.has(task.status)
                            ? "text-fg-muted"
                            : "text-emerald-400",
                        )}
                      >
                        #{task.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {task.title}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-[10px] font-medium",
                          STATUS_TONE[task.status],
                        )}
                      >
                        {t(STATUS_LABEL[task.status])}
                      </span>
                      <TaskAge iso={task.created_at} />
                    </ListActionRow>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
      {editor ? (
        <TaskEditorModal
          key={editor.mode === "edit" ? editor.task.id : "create"}
          mode={editor.mode}
          initialTitle={editor.mode === "edit" ? editor.task.title : ""}
          initialDescription={
            editor.mode === "edit" ? editor.task.description : ""
          }
          onClose={() => setEditor(null)}
          onSave={async (title, description) => {
            try {
              if (editor.mode === "create") {
                const created = await api.createProjectTask(
                  repoPath,
                  title,
                  description,
                  originSessionId,
                );
                listEpoch.current += 1;
                setTasks((current) => [created, ...current]);
              } else {
                const next = await api.updateProjectTask(
                  repoPath,
                  editor.task.id,
                  { title, description },
                );
                replaceTask(next);
              }
              setEditor(null);
            } catch (cause) {
              showToast(`${t("rightPanel.tasks.saveFailed")} ${String(cause)}`);
            }
          }}
        />
      ) : null}
      {detail ? (
        <TaskDetailModal
          task={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditor({ mode: "edit", task: detail });
          }}
          onStart={() => void startWork(detail)}
          starting={starting}
          onOpenSession={
            sessions.some((session) => session.id === detail.session_id)
              ? () => openSessionSurface(detail.session_id!)
              : null
          }
          onStatus={async (status) => {
            try {
              replaceTask(
                await api.updateProjectTask(repoPath, detail.id, { status }),
              );
            } catch (cause) {
              showToast(
                `${t("rightPanel.tasks.saveFailed")} ${String(cause)}`,
              );
            }
          }}
          onComment={async (body) => {
            try {
              replaceTask(
                await api.addProjectTaskComment(repoPath, detail.id, body),
              );
            } catch (cause) {
              showToast(
                `${t("rightPanel.tasks.commentFailed")} ${String(cause)}`,
              );
              throw cause;
            }
          }}
          onDelete={() => removeTask(detail.id)}
          onDeleteComment={async (commentId) => {
            try {
              replaceTask(
                await api.deleteProjectTaskComment(
                  repoPath,
                  detail.id,
                  commentId,
                ),
              );
            } catch (cause) {
              showToast(
                `${t("rightPanel.tasks.deleteCommentFailed")} ${String(cause)}`,
              );
              throw cause;
            }
          }}
        />
      ) : null}
    </div>
  );
}

function TaskEditorModal({
  mode,
  initialTitle,
  initialDescription,
  onClose,
  onSave,
}: {
  mode: "create" | "edit";
  initialTitle: string;
  initialDescription: string;
  onClose: () => void;
  onSave: (title: string, description: string) => Promise<void>;
}) {
  const t = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const titleId = "workspace-task-editor-title";

  return (
    <Modal open variant="dialog" size="md" ariaLabelledBy={titleId} onClose={onClose}>
      <ModalHeader
        title={
          mode === "create"
            ? t("rightPanel.tasks.newTitle")
            : t("rightPanel.tasks.editTitle")
        }
        titleId={titleId}
        variant="dialog"
        onClose={onClose}
      />
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || saving) return;
          setSaving(true);
          void onSave(title, description).finally(() => setSaving(false));
        }}
      >
        {/* Fields carry their own inset so ModalFooter's px-4 lines the
            buttons up with the header instead of doubling the padding. */}
        <div className="flex flex-col gap-4 px-4 pb-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">
              {t("rightPanel.tasks.title")}
            </span>
            <input
              className={cn(TEXT_INPUT_CLASS, "h-9 font-sans text-[13px]")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">
              {t("rightPanel.tasks.description")}
            </span>
            <textarea
              className={cn(
                TEXT_INPUT_CLASS,
                "min-h-40 resize-y py-2 font-sans leading-relaxed",
              )}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("rightPanel.tasks.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving || title.trim().length === 0}
          >
            {t("rightPanel.tasks.save")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

type CommentScrollHold = {
  beforeHeight: number;
  scrollTop: number;
  // True when the change is entirely above the viewport. A prepend always is.
  above: boolean;
};

// The detail modal portals in after its own mount effect, so a scroll effect
// on the parent runs before this node exists. The effect lives here so it
// runs on the frame the list is actually in the document.
function TaskCommentWindow({
  taskId,
  comments,
  earlierLabel,
  deleteLabel,
  onDeleteComment,
}: {
  taskId: string;
  comments: ProjectTaskComment[];
  earlierLabel: string;
  deleteLabel: string;
  onDeleteComment: (commentId: string) => Promise<void>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousKey = useRef<string | null>(null);
  const pendingAnchor = useRef<CommentScrollHold | null>(null);
  const [seenTaskId, setSeenTaskId] = useState(taskId);
  // Null means "the newest page". A stored list pins notes the reader has not
  // asked for, so a delete cannot slide one of them into the window.
  const [hiddenIds, setHiddenIds] = useState<string[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (seenTaskId !== taskId) {
    previousKey.current = null;
    pendingAnchor.current = null;
    setSeenTaskId(taskId);
    setHiddenIds(null);
  }

  const implicitHidden = comments
    .slice(0, Math.max(0, comments.length - COMMENT_PAGE))
    .map((item) => item.id);
  const present = new Set(comments.map((item) => item.id));
  const hidden = (hiddenIds ?? implicitHidden).filter((id) =>
    present.has(id),
  );
  const hiddenSet = new Set(hidden);
  const visibleComments =
    hiddenIds == null
      ? comments.slice(Math.max(0, comments.length - COMMENT_PAGE))
      : comments.filter((item) => !hiddenSet.has(item.id));
  const visibleKey = visibleComments.map((item) => item.id).join("\0");

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = previousKey.current;
    previousKey.current = visibleKey;
    if (previous == null) {
      pendingAnchor.current = null;
      list.scrollTop = list.scrollHeight;
      return;
    }
    if (previous === visibleKey) return;
    const prevIds = previous.split("\0").filter(Boolean);
    const nextIds = visibleKey.split("\0").filter(Boolean);
    const nextNewest = nextIds[nextIds.length - 1];
    const addedAtEnd =
      nextNewest != null &&
      nextNewest !== prevIds[prevIds.length - 1] &&
      !prevIds.includes(nextNewest);
    if (addedAtEnd) {
      pendingAnchor.current = null;
      list.scrollTop = list.scrollHeight;
      return;
    }
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!pending) return;
    const delta = list.scrollHeight - pending.beforeHeight;
    list.scrollTop = pending.above
      ? pending.scrollTop + delta
      : pending.scrollTop;
  }, [visibleKey]);

  function holdScroll(row?: HTMLElement) {
    const list = listRef.current;
    if (!list) return;
    let above = true;
    if (row) {
      const rowBottom = row.getBoundingClientRect().bottom;
      const listTop = list.getBoundingClientRect().top;
      above = rowBottom <= listTop + 1;
    }
    pendingAnchor.current = {
      beforeHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
      above,
    };
  }

  return (
    <>
      {hidden.length > 0 ? (
        <button
          type="button"
          className="mb-1.5 w-full rounded-md px-2 py-1 text-left text-[11px] text-fg-muted transition hover:bg-fill hover:text-fg"
          onClick={() => {
            holdScroll();
            const reveal = new Set(hidden.slice(-COMMENT_PAGE));
            setHiddenIds(hidden.filter((id) => !reveal.has(id)));
          }}
        >
          {earlierLabel}
        </button>
      ) : null}
      <div
        ref={listRef}
        data-task-comments
        className="max-h-72 overflow-y-auto"
        // Tailwind does not emit overflow-anchor. Leaving Chromium's default
        // on would add this same delta again after a prepend.
        style={{ overflowAnchor: "none" }}
      >
        <ul className="flex flex-col gap-1.5">
          {visibleComments.map((item) => (
            <li
              key={item.id}
              className="group flex items-start gap-2 rounded-md bg-fill px-2.5 py-1.5 text-xs leading-relaxed text-fg"
            >
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap">{item.body}</p>
                <TaskAge iso={item.created_at} className="mt-0.5" />
              </div>
              <Tooltip label={deleteLabel} side="top" className="shrink-0">
                <button
                  type="button"
                  aria-label={deleteLabel}
                  disabled={deletingId === item.id}
                  onClick={(event) => {
                    const row = event.currentTarget.closest("li");
                    if (row instanceof HTMLElement) holdScroll(row);
                    if (hiddenIds == null) setHiddenIds(implicitHidden);
                    setDeletingId(item.id);
                    void onDeleteComment(item.id)
                      .catch(() => {
                        pendingAnchor.current = null;
                      })
                      .finally(() =>
                        setDeletingId((current) =>
                          current === item.id ? null : current,
                        ),
                      );
                  }}
                  className="rounded p-1 text-fg-muted opacity-0 transition hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                >
                  <Trash2 size={12} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function TaskDetailModal({
  task,
  onClose,
  onEdit,
  onStart,
  starting,
  onOpenSession,
  onStatus,
  onComment,
  onDelete,
  onDeleteComment,
}: {
  task: ProjectTask;
  onClose: () => void;
  onEdit: () => void;
  onStart: () => void;
  starting: boolean;
  onOpenSession: (() => void) | null;
  onStatus: (status: ProjectTaskStatus) => Promise<void>;
  onComment: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
}) {
  const t = useTranslation();
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const titleId = "workspace-task-detail-title";
  const comments = task.comments ?? [];
  const changes = task.status_changes ?? [];

  return (
    <Modal
      open
      variant="dialog"
      size="lg"
      ariaLabelledBy={titleId}
      onClose={onClose}
      // Read-a-note shape: title and composer stay put, only the note scrolls.
      className="flex flex-col overflow-hidden"
    >
      <ModalHeader
        title={
          <>
            <span
              className={cn(
                "font-mono tabular-nums",
                STATUS_TONE[task.status],
              )}
            >
              #{task.number}
            </span>{" "}
            {task.title}
          </>
        }
        titleId={titleId}
        variant="dialog"
        onClose={onClose}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            {t("rightPanel.tasks.createdLabel")}
            <TaskAge iso={task.created_at} />
          </span>
        }
        actions={
          <>
            <Button
              type="button"
              variant="dangerSoft"
              size="xs"
              disabled={deletingTask}
              onClick={() => {
                setDeletingTask(true);
                void onDelete().finally(() => setDeletingTask(false));
              }}
            >
              {t("rightPanel.tasks.delete")}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={onEdit}>
              {t("rightPanel.tasks.edit")}
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 items-center justify-between gap-2 border-y border-border bg-fill/40 px-4 py-1.5">
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          {t("rightPanel.tasks.statusLabel")}
          <select
            className={cn(TEXT_INPUT_CLASS, "h-7 w-auto text-xs")}
            value={task.status}
            onChange={(event) =>
              void onStatus(event.target.value as ProjectTaskStatus)
            }
          >
            {(Object.keys(STATUS_LABEL) as ProjectTaskStatus[]).map(
              (status) => (
                <option key={status} value={status}>
                  {t(STATUS_LABEL[status])}
                </option>
              ),
            )}
          </select>
        </label>
        {onOpenSession ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onOpenSession}
          >
            {t("rightPanel.menu.openSession")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="xs"
            disabled={starting}
            onClick={onStart}
          >
            {t("rightPanel.menu.startWork")}
          </Button>
        )}
      </div>
      <div className="acorn-no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p
          className={cn(
            "whitespace-pre-wrap text-[13px] leading-relaxed",
            task.description.trim() ? "text-fg" : "text-fg-muted",
          )}
        >
          {task.description.trim()
            ? task.description
            : t("rightPanel.tasks.noDescription")}
        </p>
        {changes.length > 0 ? (
          <section className="mt-4 border-t border-border pt-3">
            <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              {t("rightPanel.tasks.statusHistory")}
            </h3>
            <ul>
              {changes.map((change, index) => (
                <li
                  key={`${index}-${change.from}-${change.to}-${change.at}`}
                  className="flex items-baseline gap-2 py-0.5 text-[11px] text-fg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t(STATUS_LABEL[change.from])} →{" "}
                    {t(STATUS_LABEL[change.to])}
                  </span>
                  <TaskAge iso={change.at} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="mt-4 border-t border-border pt-3">
          <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
            {t("rightPanel.tasks.comments")}
          </h3>
          {comments.length === 0 ? (
            <p className="text-[11px] text-fg-muted">
              {t("rightPanel.tasks.noComments")}
            </p>
          ) : (
            <TaskCommentWindow
              taskId={task.id}
              comments={comments}
              earlierLabel={t("rightPanel.tasks.earlierComments")}
              deleteLabel={t("rightPanel.tasks.deleteComment")}
              onDeleteComment={onDeleteComment}
            />
          )}
        </section>
      </div>
      <ModalFooter className="items-end border-t border-border">
        <form
          className="flex w-full items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const body = comment.trim();
            if (!body || posting) return;
            setPosting(true);
            void onComment(body)
              .then(() => {
                setComment("");
                const field = commentRef.current;
                if (field) fitCommentBox(field);
              })
              .catch(() => {
                // The parent toasts. A failed submit keeps the draft.
              })
              .finally(() => setPosting(false));
          }}
        >
          <textarea
            ref={commentRef}
            rows={1}
            className={cn(
              TEXT_INPUT_CLASS,
              "max-h-40 min-h-9 flex-1 resize-none overflow-y-auto py-1.5 font-sans leading-relaxed",
            )}
            value={comment}
            placeholder={t("rightPanel.tasks.commentPlaceholder")}
            onChange={(event) => {
              setComment(event.target.value);
              fitCommentBox(event.currentTarget);
            }}
          />
          <Button
            type="submit"
            variant="neutral"
            size="sm"
            disabled={posting || comment.trim().length === 0}
          >
            {t("rightPanel.tasks.commentSubmit")}
          </Button>
        </form>
      </ModalFooter>
    </Modal>
  );
}

function fitCommentBox(field: HTMLTextAreaElement) {
  field.style.height = "0px";
  field.style.height = `${field.scrollHeight}px`;
}

function TaskAge({ iso, className }: { iso: string; className?: string }) {
  const t = useTranslation();
  const label = taskAgeLabel(iso, Date.now(), t("rightPanel.tasks.justNow"));
  if (!label) return null;
  const absolute = taskAbsoluteTime(iso);
  return (
    <Tooltip
      label={absolute || label}
      side="top"
      className={cn("shrink-0", className)}
    >
      <time
        dateTime={iso}
        className="whitespace-nowrap font-mono text-[10px] text-fg-muted"
      >
        {label}
      </time>
    </Tooltip>
  );
}
