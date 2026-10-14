import { useEffect, useRef, useState } from "react";
import { ListChecks, Pencil, Play, SquareTerminal, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { isSessionAgentProvider } from "../lib/agentProviderRegistry";
import type { TranslationKey } from "../lib/i18n";
import { isArchivedSession } from "../lib/sessionArchive";
import { taskAbsoluteTime, taskAgeLabel } from "../lib/taskAge";
import { useSettings } from "../lib/settings";
import {
  buildTaskAgentCommand,
  launchTaskStartWork,
} from "../lib/taskStartWork";
import { useToasts } from "../lib/toasts";
import type { ProjectTask, ProjectTaskStatus } from "../lib/types";
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

const TASK_LIST_FILTERS = ["open", "closed", "all"] as const;
type TaskListFilter = (typeof TASK_LIST_FILTERS)[number];

const FILTER_LABEL: Record<TaskListFilter, TranslationKey> = {
  open: "rightPanel.tasks.listFilter.open",
  closed: "rightPanel.tasks.listFilter.closed",
  all: "rightPanel.tasks.listFilter.all",
};

const STATUS_LABEL: Record<ProjectTaskStatus, TranslationKey> = {
  todo: "rightPanel.tasks.status.todo",
  in_progress: "rightPanel.tasks.status.in_progress",
  in_review: "rightPanel.tasks.status.in_review",
  done: "rightPanel.tasks.status.done",
  canceled: "rightPanel.tasks.status.canceled",
};

// Status tone mirrors the GitHub rows next door: the `#number` carries
// open/closed (emerald vs muted, like IssueRow), and the trailing status
// word carries progress. Keeps a glance at the row enough to tell state.
const STATUS_TONE: Record<ProjectTaskStatus, string> = {
  todo: "text-fg-muted",
  in_progress: "text-emerald-400",
  in_review: "text-accent",
  done: "text-emerald-400",
  canceled: "text-danger",
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
  const [listFilter, setListFilter] = useState<TaskListFilter>("open");
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listProjectTasks(repoPath)
      .then((next) => {
        if (cancelled) return;
        setTasks(Array.isArray(next) ? next : []);
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
        openSessionSurface(result.session.id);
      } catch (cause) {
        showToast(`${t("rightPanel.tasks.saveFailed")} ${String(cause)}`);
      }
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
      openSessionSurface(session.id);
    } catch (cause) {
      showToast(`${t("rightPanel.tasks.saveFailed")} ${String(cause)}`);
    }
  }

  const visible = tasks.filter((task) => {
    if (listFilter === "all") return true;
    const closed = CLOSED_STATUSES.has(task.status);
    return listFilter === "closed" ? closed : !closed;
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
          onClick: () => {
            void api
              .deleteProjectTask(repoPath, menuTask.id)
              .then(() => {
                setTasks((current) =>
                  current.filter((task) => task.id !== menuTask.id),
                );
                setDetail((current) =>
                  current?.id === menuTask.id ? null : current,
                );
              })
              .catch((cause: unknown) => {
                showToast(
                  `${t("rightPanel.tasks.deleteFailed")} ${String(cause)}`,
                );
              });
          },
        },
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {TASK_LIST_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            aria-pressed={listFilter === filter}
            onClick={() => setListFilter(filter)}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] transition",
              listFilter === filter
                ? "bg-bg-elevated text-fg"
                : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
            )}
          >
            {t(FILTER_LABEL[filter])}
          </button>
        ))}
        <RefreshButton
          loading={loading}
          size={12}
          title={t("rightPanel.tasks.refresh")}
          ariaLabel={t("rightPanel.tasks.refresh")}
          onClick={() => setRevision((current) => current + 1)}
          className="ml-auto"
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
      {error ? (
        <div className="px-3 pb-2 text-xs text-danger" role="alert">
          {t("rightPanel.tasks.loadFailed")} {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && tasks.length === 0 ? (
          <ListEmptyState>{t("rightPanel.tasks.loading")}</ListEmptyState>
        ) : visible.length === 0 ? (
          <ListEmptyState>{t("rightPanel.tasks.empty")}</ListEmptyState>
        ) : (
          <ul className={listBoxClassName()}>
            {visible.map((task) => (
              <ListActionRow
                key={task.id}
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

function TaskDetailModal({
  task,
  onClose,
  onEdit,
  onStart,
  starting,
  onOpenSession,
  onStatus,
  onComment,
}: {
  task: ProjectTask;
  onClose: () => void;
  onEdit: () => void;
  onStart: () => void;
  starting: boolean;
  onOpenSession: (() => void) | null;
  onStatus: (status: ProjectTaskStatus) => Promise<void>;
  onComment: (body: string) => Promise<void>;
}) {
  const t = useTranslation();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
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
        title={`#${task.number} ${task.title}`}
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
          <Button type="button" variant="ghost" size="xs" onClick={onEdit}>
            {t("rightPanel.tasks.edit")}
          </Button>
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
              {changes.map((change) => (
                <li
                  key={`${change.at}-${change.to}`}
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
            <ul className="flex flex-col gap-1.5">
              {comments.map((item) => (
                <li
                  key={item.id}
                  className="rounded-md bg-fill px-2.5 py-1.5 text-xs leading-relaxed text-fg"
                >
                  {/* Time trails the body inline so a one-line note reads as
                      one line instead of a two-column block. */}
                  <p className="whitespace-pre-wrap">
                    {item.body}{" "}
                    <TaskAge
                      iso={item.created_at}
                      className="ml-1 align-baseline"
                    />
                  </p>
                </li>
              ))}
            </ul>
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
              .then(() => setComment(""))
              .finally(() => setPosting(false));
          }}
        >
          <textarea
            rows={1}
            className={cn(
              TEXT_INPUT_CLASS,
              "min-h-9 flex-1 resize-y py-1.5 font-sans leading-relaxed",
            )}
            value={comment}
            placeholder={t("rightPanel.tasks.commentPlaceholder")}
            onChange={(event) => setComment(event.target.value)}
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
