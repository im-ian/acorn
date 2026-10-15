import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  FileText,
  Pencil,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { copyTextWithFeedback } from "../lib/clipboardActions";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import {
  launchScheduleRun,
  notifySchedulesChanged,
  SCHEDULE_RUN_POLL_MS,
} from "../lib/scheduleRunner";
import {
  SCHEDULE_RUN_STATE_CLASS,
  SCHEDULE_RUN_STATE_LABEL,
  scheduleRunState,
} from "../lib/scheduleRunStatus";
import {
  scheduleNextRunLabel,
  scheduleRunTimeLabel,
} from "../lib/scheduleTrigger";
import { taskAbsoluteTime, taskAgeLabel } from "../lib/taskAge";
import { useToasts } from "../lib/toasts";
import type { ProjectSchedule, ScheduleRun } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import type { ScheduleWorkspaceTab } from "../lib/workspaceTabs";
import { useAppStore } from "../store";
import { Tooltip } from "./Tooltip";
import {
  Button,
  IconButton,
  ListEmptyState,
  ListRow,
  Markdown,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  RefreshButton,
  listBoxClassName,
} from "./ui";
import {
  ScheduleEditorModal,
  useScheduleTriggerSummary,
  useSchedulesChangedSignal,
} from "./WorkspaceSchedulesTab";

/**
 * Board for one schedule: what it repeats, when it fires next, and every run
 * it has launched. A run links back to its session so the user can pick the
 * work up or read the summary of what the agent did.
 */
export function ScheduleRunsView({ tab }: { tab: ScheduleWorkspaceTab }) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const sessions = useAppStore((s) => s.sessions);
  const openSessionSurface = useAppStore((s) => s.openSessionSurface);
  const summarize = useScheduleTriggerSummary();
  const changed = useSchedulesChangedSignal();
  const [schedule, setSchedule] = useState<ProjectSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [starting, setStarting] = useState(false);
  const [summaryRun, setSummaryRun] = useState<ScheduleRun | null>(null);
  const [clearing, setClearing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const closeWorkspaceTab = useAppStore((s) => s.closeWorkspaceTab);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listProjectSchedules(tab.repoPath)
      .then((next) => {
        if (cancelled) return;
        setSchedule(
          next.find((item) => item.id === tab.scheduleId) ?? null,
        );
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
  }, [tab.repoPath, tab.scheduleId, revision, changed]);

  const runs = schedule ? [...schedule.runs].reverse() : [];
  const runStates = runs.map((run) =>
    scheduleRunState(
      run,
      sessions.some((session) => session.id === run.session_id),
    ),
  );
  const hasActiveRun = runStates.includes("running");

  // Only polls while something is actually in flight, so an idle board costs
  // nothing and a watched run still flips to SUCCESS on its own.
  useEffect(() => {
    if (!hasActiveRun) return;
    const handle = window.setInterval(
      () => setRevision((current) => current + 1),
      SCHEDULE_RUN_POLL_MS,
    );
    return () => window.clearInterval(handle);
  }, [hasActiveRun]);

  if (loading && !schedule) {
    return <ListEmptyState>{t("rightPanel.schedules.loading")}</ListEmptyState>;
  }
  if (error) {
    return (
      <div className="p-3 text-xs text-danger" role="alert">
        {t("rightPanel.schedules.loadFailed")} {error}
      </div>
    );
  }
  if (!schedule) {
    return <ListEmptyState>{t("rightPanel.schedules.notFound")}</ListEmptyState>;
  }

  function runNow() {
    if (!schedule || starting) return;
    setStarting(true);
    void launchScheduleRun(tab.repoPath, schedule)
      .catch((cause: unknown) => {
        showToast(`${t("rightPanel.schedules.runFailedToast")} ${String(cause)}`);
      })
      .finally(() => {
        setStarting(false);
        setRevision((current) => current + 1);
      });
  }

  async function deleteRun(run: ScheduleRun) {
    if (!schedule) return;
    try {
      const next = await api.deleteProjectScheduleRun(
        tab.repoPath,
        schedule.id,
        run.id,
      );
      setSchedule(next);
      setSummaryRun((current) => (current?.id === run.id ? null : current));
    } catch (cause) {
      showToast(
        `${t("rightPanel.schedules.deleteRunFailed")} ${String(cause)}`,
      );
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-fg">
            {schedule.name}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
            <span className="font-mono text-accent">
              {summarize(schedule.trigger)}
            </span>
            <span>
              {t("rightPanel.schedules.nextRun")}{" "}
              <span className="font-mono">
                {scheduleNextRunLabel(schedule)}
              </span>
            </span>
            {/* Spelled out because it decides what "Run now" does, not just
                what the timer does. */}
            <span>
              {schedule.mode === "oneshot"
                ? t("rightPanel.schedules.modeOneshot")
                : t("rightPanel.schedules.modeSession")}
            </span>
            {schedule.background ? (
              <span className="rounded bg-fill px-1 py-0.5 text-[9px] uppercase tracking-wide">
                {t("rightPanel.schedules.backgroundBadge")}
              </span>
            ) : null}
          </p>
        </div>
        <RefreshButton
          loading={loading}
          size={12}
          title={t("rightPanel.schedules.refresh")}
          ariaLabel={t("rightPanel.schedules.refresh")}
          onClick={() => setRevision((current) => current + 1)}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => setEditing(true)}
        >
          <Pencil size={11} />
          {t("rightPanel.schedules.edit")}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="xs"
          disabled={starting}
          onClick={runNow}
        >
          {t("rightPanel.schedules.runNow")}
        </Button>
        <Tooltip label={t("rightPanel.schedules.delete")} side="bottom">
          <IconButton
            variant="dangerGhost"
            size="sm"
            aria-label={t("rightPanel.schedules.delete")}
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={13} />
          </IconButton>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-border px-4 py-3">
          <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
            {t("rightPanel.schedules.prompt")}
          </h3>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
            {schedule.prompt}
          </p>
        </section>
        <section className="px-2 py-2">
          <div className="mb-1 flex items-center gap-2 px-2">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              {t("rightPanel.schedules.runs")} {runs.length}
            </h3>
            {runs.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => setClearing(true)}
              >
                <Trash2 size={11} />
                {t("rightPanel.schedules.clearRuns")}
              </Button>
            ) : null}
          </div>
          {runs.length === 0 ? (
            <p className="px-2 text-[11px] text-fg-muted">
              {t("rightPanel.schedules.noRuns")}
            </p>
          ) : (
            <ul className={listBoxClassName({ inset: "none" })}>
              {runs.map((run, index) => {
                const session = run.session_id
                  ? sessions.find((item) => item.id === run.session_id)
                  : undefined;
                const state = runStates[index];
                return (
                  <ListRow
                    key={run.id}
                    surface="subtle"
                    density="compact"
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      className={cn(
                        // Fixed width so the timestamps beside it stay in a
                        // column instead of stepping with the label length.
                        "w-14 shrink-0 text-[10px] font-bold uppercase tracking-wide",
                        SCHEDULE_RUN_STATE_CLASS[state],
                        state === "running" && "animate-pulse",
                      )}
                    >
                      {t(SCHEDULE_RUN_STATE_LABEL[state])}
                    </span>
                    {/* When it ran is the run's identity: the session behind
                        it can be removed, the timestamp cannot. */}
                    <RunTime iso={run.started_at} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        run.error ? "text-danger" : "text-fg-muted",
                      )}
                    >
                      {run.error
                        ? `${t("rightPanel.schedules.runFailed")} ${run.error}`
                        : (session?.name ?? "")}
                    </span>
                    {session ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => openSessionSurface(session.id)}
                      >
                        <SquareTerminal size={11} />
                        {t("rightPanel.schedules.resume")}
                      </Button>
                    ) : null}
                    {run.summary_ready ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setSummaryRun(run)}
                      >
                        <FileText size={11} />
                        {t("rightPanel.schedules.summary")}
                      </Button>
                    ) : null}
                    <Tooltip
                      label={t("rightPanel.schedules.deleteRun")}
                      side="top"
                    >
                      <IconButton
                        variant="dangerGhost"
                        size="xs"
                        aria-label={t("rightPanel.schedules.deleteRun")}
                        onClick={() => void deleteRun(run)}
                      >
                        <Trash2 size={11} />
                      </IconButton>
                    </Tooltip>
                  </ListRow>
                );
              })}
            </ul>
          )}
          {runs.length > 0 ? (
            <p className="px-2 pt-1.5 text-[10px] text-fg-muted">
              {t("rightPanel.schedules.retention")}
            </p>
          ) : null}
        </section>
      </div>
      <ConfirmDialog
        open={clearing}
        titleId="schedule-clear-runs-title"
        title={t("rightPanel.schedules.clearRunsTitle")}
        body={t("rightPanel.schedules.clearRunsBody")}
        confirmLabel={t("rightPanel.schedules.clearRunsConfirm")}
        onCancel={() => setClearing(false)}
        onConfirm={async () => {
          try {
            await api.clearProjectScheduleRuns(tab.repoPath, schedule.id);
            setSummaryRun(null);
            setRevision((current) => current + 1);
          } catch (cause) {
            showToast(
              `${t("rightPanel.schedules.clearRunsFailed")} ${String(cause)}`,
            );
          } finally {
            setClearing(false);
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        titleId="schedule-delete-title"
        title={t("rightPanel.schedules.deleteTitle")}
        body={t("rightPanel.schedules.deleteBody")}
        confirmLabel={t("rightPanel.schedules.delete")}
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          try {
            await api.deleteProjectSchedule(tab.repoPath, schedule.id);
            notifySchedulesChanged();
            // Nothing left for this tab to show.
            closeWorkspaceTab(tab.id);
          } catch (cause) {
            showToast(
              `${t("rightPanel.schedules.deleteFailed")} ${String(cause)}`,
            );
            setDeleting(false);
          }
        }}
      />
      {editing ? (
        <ScheduleEditorModal
          initial={schedule}
          onClose={() => setEditing(false)}
          onSave={async (name, prompt, trigger, mode, background) => {
            try {
              const next = await api.updateProjectSchedule(
                tab.repoPath,
                schedule.id,
                { name, prompt, trigger, mode, background },
              );
              setSchedule(next);
              setEditing(false);
              notifySchedulesChanged();
            } catch (cause) {
              showToast(
                `${t("rightPanel.schedules.saveFailed")} ${String(cause)}`,
              );
            }
          }}
        />
      ) : null}
      {summaryRun ? (
        <RunSummaryModal
          run={summaryRun}
          scheduleName={schedule.name}
          onClose={() => setSummaryRun(null)}
        />
      ) : null}
    </div>
  );
}

/** Clearing a history and deleting a schedule ask the same question. */
function ConfirmDialog({
  open,
  titleId,
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  titleId: string;
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslation();
  useDialogShortcuts(open, { onCancel, onConfirm: () => void onConfirm() });

  return (
    <Modal
      open={open}
      variant="dialog"
      size="sm"
      ariaLabelledBy={titleId}
      onClose={onCancel}
    >
      <ModalHeader
        title={title}
        titleId={titleId}
        variant="dialog"
        onClose={onCancel}
      />
      <div className="px-4 pb-1">
        <Notice tone="danger">{body}</Notice>
      </div>
      <ModalFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("rightPanel.schedules.cancel")}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => void onConfirm()}
        >
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * The summary the agent wrote for one run. Read on open rather than with the
 * schedule: the file lands minutes after the run is recorded, so anything
 * cached alongside the run would be stale by definition.
 */
function RunSummaryModal({
  run,
  scheduleName,
  onClose,
}: {
  run: ScheduleRun;
  scheduleName: string;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; body: string } | { kind: "missing" }
  >({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const titleId = "schedule-run-summary-title";

  useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(handle);
  }, [copied]);

  useEffect(() => {
    let cancelled = false;
    const path = run.summary_path;
    if (!path) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    api
      .fsReadFile(path)
      .then((result) => {
        if (cancelled) return;
        const body = result.binary ? "" : result.content.trim();
        setState(body ? { kind: "ready", body } : { kind: "missing" });
      })
      .catch(() => {
        // A missing file is the normal case for a run still in flight, and
        // `fs_read_file` reports that the same way as a real failure.
        if (!cancelled) setState({ kind: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [run.summary_path]);

  return (
    <Modal
      open
      variant="dialog"
      size="lg"
      ariaLabelledBy={titleId}
      onClose={onClose}
      className="flex flex-col overflow-hidden"
    >
      <ModalHeader
        title={`${scheduleName} — ${t("rightPanel.schedules.summaryTitle")}`}
        titleId={titleId}
        variant="dialog"
        onClose={onClose}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <RunTime iso={run.started_at} />
          </span>
        }
        actions={
          // The summary is the run's deliverable, so it has to be liftable out
          // of here — into a PR body, an issue, a message.
          state.kind === "ready" ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                void copyTextWithFeedback(state.body).then((ok) => {
                  if (ok) setCopied(true);
                });
              }}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied
                ? t("rightPanel.schedules.copiedSummary")
                : t("rightPanel.schedules.copySummary")}
            </Button>
          ) : null
        }
      />
      <div className="acorn-no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.kind === "loading" ? (
          <p className="text-[11px] text-fg-muted">
            {t("rightPanel.schedules.loading")}
          </p>
        ) : state.kind === "missing" ? (
          <p className="text-[13px] text-fg-muted">
            {t("rightPanel.schedules.summaryPending")}
          </p>
        ) : (
          <Markdown content={state.body} />
        )}
      </div>
    </Modal>
  );
}

function RunTime({ iso }: { iso: string }) {
  const t = useTranslation();
  const age = taskAgeLabel(iso, Date.now(), t("rightPanel.schedules.justNow"));
  const absolute = taskAbsoluteTime(iso);
  return (
    <Tooltip
      label={[absolute, age].filter(Boolean).join(" · ")}
      side="top"
      className="shrink-0"
    >
      <time
        dateTime={iso}
        className="shrink-0 whitespace-nowrap font-mono text-[10px] text-fg"
      >
        {scheduleRunTimeLabel(iso)}
      </time>
    </Tooltip>
  );
}
