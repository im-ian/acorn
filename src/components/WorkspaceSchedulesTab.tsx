import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pencil, Play, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  launchScheduleRun,
  releaseBackgroundSessionsForRuns,
  SCHEDULES_CHANGED_EVENT,
} from "../lib/scheduleRunner";
import {
  SCHEDULE_TRIGGER_KINDS,
  scheduleTriggerSummary,
  weekdayShortLabel,
  type ScheduleTriggerKind,
} from "../lib/scheduleTrigger";
import { useSettings } from "../lib/settings";
import { taskAbsoluteTime, taskAgeLabel } from "../lib/taskAge";
import { useToasts } from "../lib/toasts";
import type {
  ProjectSchedule,
  ScheduleMode,
  ScheduleTrigger,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Tooltip } from "./Tooltip";
import {
  Button,
  CheckboxRow,
  ListActionRow,
  ListEmptyState,
  Modal,
  ModalFooter,
  ModalHeader,
  RefreshButton,
  TEXT_INPUT_CLASS,
  listBoxClassName,
} from "./ui";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Shared by the list rows and the board tab so both read the same way. */
export function useScheduleTriggerSummary(): (
  trigger: ScheduleTrigger,
) => string {
  const t = useTranslation();
  const locale = useSettings((s) => s.settings.language);
  return useCallback(
    (trigger: ScheduleTrigger) =>
      scheduleTriggerSummary(trigger, {
        locale,
        every: t("rightPanel.schedules.everyPrefix"),
        daily: t("rightPanel.schedules.kind.daily"),
      }),
    [locale, t],
  );
}

/** Re-fetch whenever the ticker records a run so boards stay current. */
export function useSchedulesChangedSignal(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((current) => current + 1);
    window.addEventListener(SCHEDULES_CHANGED_EVENT, bump);
    return () => window.removeEventListener(SCHEDULES_CHANGED_EVENT, bump);
  }, []);
  return revision;
}

export function WorkspaceSchedulesTab({ repoPath }: { repoPath: string }) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const openScheduleTab = useAppStore((s) => s.openScheduleTab);
  const summarize = useScheduleTriggerSummary();
  const changed = useSchedulesChangedSignal();
  const [schedules, setSchedules] = useState<ProjectSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; schedule: ProjectSchedule } | null
  >(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    schedule: ProjectSchedule;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listProjectSchedules(repoPath)
      .then((next) => {
        if (cancelled) return;
        setSchedules(Array.isArray(next) ? next : []);
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
  }, [repoPath, revision, changed]);

  const menuSchedule = menu?.schedule ?? null;
  const menuItems: ContextMenuItem[] = menuSchedule
    ? [
        {
          label: t("rightPanel.schedules.openBoard"),
          icon: <CalendarClock size={12} />,
          onClick: () =>
            openScheduleTab({
              repoPath,
              scheduleId: menuSchedule.id,
              title: menuSchedule.name,
            }),
        },
        {
          label: t("rightPanel.schedules.edit"),
          icon: <Pencil size={12} />,
          onClick: () => setEditor({ mode: "edit", schedule: menuSchedule }),
        },
        {
          label: t("rightPanel.schedules.runNow"),
          icon: <Play size={12} />,
          onClick: () => {
            void launchScheduleRun(repoPath, menuSchedule)
              .then(() => setRevision((current) => current + 1))
              .catch((cause: unknown) => {
                showToast(
                  `${t("rightPanel.schedules.runFailedToast")} ${String(cause)}`,
                );
              });
          },
        },
        { type: "separator" },
        {
          label: t("rightPanel.schedules.delete"),
          icon: <Trash2 size={12} />,
          onClick: () => {
            void releaseBackgroundSessionsForRuns(menuSchedule.runs)
              .then(() => api.deleteProjectSchedule(repoPath, menuSchedule.id))
              .then(() => {
                setSchedules((current) =>
                  current.filter((item) => item.id !== menuSchedule.id),
                );
              })
              .catch((cause: unknown) => {
                showToast(
                  `${t("rightPanel.schedules.deleteFailed")} ${String(cause)}`,
                );
              });
          },
        },
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1.5">
        <RefreshButton
          loading={loading}
          size={12}
          title={t("rightPanel.schedules.refresh")}
          ariaLabel={t("rightPanel.schedules.refresh")}
          onClick={() => setRevision((current) => current + 1)}
        />
        <Button
          type="button"
          variant="primary"
          size="xs"
          onClick={() => setEditor({ mode: "create" })}
        >
          {t("rightPanel.schedules.new")}
        </Button>
      </div>
      {error ? (
        <div className="px-3 pb-2 text-xs text-danger" role="alert">
          {t("rightPanel.schedules.loadFailed")} {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && schedules.length === 0 ? (
          <ListEmptyState>{t("rightPanel.schedules.loading")}</ListEmptyState>
        ) : schedules.length === 0 ? (
          <ListEmptyState>{t("rightPanel.schedules.empty")}</ListEmptyState>
        ) : (
          <ul className={listBoxClassName()}>
            {schedules.map((schedule) => {
              const open = () =>
                openScheduleTab({
                  repoPath,
                  scheduleId: schedule.id,
                  title: schedule.name,
                });
              return (
                <ListActionRow
                  key={schedule.id}
                  surface="subtle"
                  density="compact"
                  onOpen={open}
                  onClick={open}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, schedule });
                  }}
                  className="flex items-center gap-2 text-left text-xs"
                >
                  <CalendarClock
                    size={12}
                    className="shrink-0 text-fg-muted"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {schedule.name}
                  </span>
                  {schedule.background ? (
                    <span className="shrink-0 rounded bg-fill px-1 py-0.5 text-[9px] uppercase tracking-wide text-fg-muted">
                      {t("rightPanel.schedules.backgroundBadge")}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-[10px] text-accent">
                    {summarize(schedule.trigger)}
                  </span>
                  <ScheduleAge iso={schedule.last_run_at} />
                </ListActionRow>
              );
            })}
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
        <ScheduleEditorModal
          key={editor.mode === "edit" ? editor.schedule.id : "create"}
          initial={editor.mode === "edit" ? editor.schedule : null}
          onClose={() => setEditor(null)}
          onSave={async (name, prompt, trigger, mode, background) => {
            try {
              if (editor.mode === "create") {
                const created = await api.createProjectSchedule(
                  repoPath,
                  name,
                  prompt,
                  trigger,
                  mode,
                  background,
                );
                setSchedules((current) => [...current, created]);
              } else {
                const next = await api.updateProjectSchedule(
                  repoPath,
                  editor.schedule.id,
                  { name, prompt, trigger, mode, background },
                );
                setSchedules((current) =>
                  current.map((item) => (item.id === next.id ? next : item)),
                );
              }
              setEditor(null);
            } catch (cause) {
              showToast(
                `${t("rightPanel.schedules.saveFailed")} ${String(cause)}`,
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}

export function ScheduleEditorModal({
  initial,
  onClose,
  onSave,
}: {
  /** The schedule being edited, or `null` when creating a new one. */
  initial: ProjectSchedule | null;
  onClose: () => void;
  onSave: (
    name: string,
    prompt: string,
    trigger: ScheduleTrigger,
    mode: ScheduleMode,
    background: boolean,
  ) => Promise<void>;
}) {
  const t = useTranslation();
  const locale = useSettings((s) => s.settings.language);
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [kind, setKind] = useState<ScheduleTriggerKind>(
    initial?.trigger.kind ?? "daily",
  );
  const [everyMinutes, setEveryMinutes] = useState(
    initial?.trigger.kind === "interval" ? initial.trigger.every_minutes : 60,
  );
  const [time, setTime] = useState(
    initial && initial.trigger.kind !== "interval"
      ? initial.trigger.time
      : "09:00",
  );
  const [weekday, setWeekday] = useState(
    initial?.trigger.kind === "weekly" ? initial.trigger.weekday : 1,
  );
  const [mode, setMode] = useState<ScheduleMode>(initial?.mode ?? "session");
  const [background, setBackground] = useState(initial?.background ?? false);
  // A background run has nowhere to live without the daemon, so the editor
  // says so up front instead of letting the first run fail.
  const [daemonEnabled, setDaemonEnabled] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api
      .daemonStatus()
      .then((status) => {
        if (!cancelled) setDaemonEnabled(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setDaemonEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [saving, setSaving] = useState(false);
  const titleId = "workspace-schedule-editor-title";

  // Background implies one-shot — the backend enforces it, and the form shows
  // it rather than letting the user pick something that will be overridden.
  const effectiveMode: ScheduleMode = background ? "oneshot" : mode;

  function buildTrigger(): ScheduleTrigger {
    if (kind === "interval") {
      return { kind: "interval", every_minutes: everyMinutes };
    }
    if (kind === "daily") return { kind: "daily", time };
    return { kind: "weekly", weekday, time };
  }

  return (
    <Modal
      open
      variant="dialog"
      size="md"
      ariaLabelledBy={titleId}
      onClose={onClose}
    >
      <ModalHeader
        title={
          initial
            ? t("rightPanel.schedules.editTitle")
            : t("rightPanel.schedules.newTitle")
        }
        titleId={titleId}
        variant="dialog"
        onClose={onClose}
      />
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !prompt.trim() || saving) return;
          setSaving(true);
          void onSave(
            name,
            prompt,
            buildTrigger(),
            effectiveMode,
            background,
          ).finally(() => setSaving(false));
        }}
      >
        <div className="flex flex-col gap-4 px-4 pb-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">
              {t("rightPanel.schedules.name")}
            </span>
            <input
              className={cn(TEXT_INPUT_CLASS, "h-9 font-sans text-[13px]")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              required
            />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-fg">
              {t("rightPanel.schedules.trigger")}
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={cn(TEXT_INPUT_CLASS, "h-8 w-auto text-xs")}
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as ScheduleTriggerKind)
                }
                aria-label={t("rightPanel.schedules.trigger")}
              >
                {SCHEDULE_TRIGGER_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`rightPanel.schedules.kind.${option}`)}
                  </option>
                ))}
              </select>
              {kind === "interval" ? (
                <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    className={cn(TEXT_INPUT_CLASS, "h-8 w-20 text-xs")}
                    value={everyMinutes}
                    onChange={(event) =>
                      setEveryMinutes(Number(event.target.value))
                    }
                    required
                  />
                  {t("rightPanel.schedules.minutes")}
                </label>
              ) : null}
              {kind === "weekly" ? (
                <select
                  className={cn(TEXT_INPUT_CLASS, "h-8 w-auto text-xs")}
                  value={weekday}
                  onChange={(event) => setWeekday(Number(event.target.value))}
                  aria-label={t("rightPanel.schedules.weekday")}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {weekdayShortLabel(day, locale)}
                    </option>
                  ))}
                </select>
              ) : null}
              {kind === "interval" ? null : (
                <input
                  type="time"
                  className={cn(TEXT_INPUT_CLASS, "h-8 w-auto text-xs")}
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  aria-label={t("rightPanel.schedules.time")}
                  required
                />
              )}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">
              {t("rightPanel.schedules.mode")}
            </span>
            <select
              className={cn(TEXT_INPUT_CLASS, "h-8 w-auto text-xs")}
              value={effectiveMode}
              disabled={background}
              onChange={(event) =>
                setMode(event.target.value as ScheduleMode)
              }
            >
              <option value="session">
                {t("rightPanel.schedules.modeSession")}
              </option>
              <option value="oneshot">
                {t("rightPanel.schedules.modeOneshot")}
              </option>
            </select>
            <span className="text-[11px] text-fg-muted">
              {background
                ? t("rightPanel.schedules.modeForcedByBackground")
                : effectiveMode === "oneshot"
                  ? t("rightPanel.schedules.modeOneshotHint")
                  : t("rightPanel.schedules.modeSessionHint")}
            </span>
          </label>
          <CheckboxRow
            label={t("rightPanel.schedules.background")}
            description={
              daemonEnabled
                ? t("rightPanel.schedules.backgroundHint")
                : t("rightPanel.schedules.backgroundDaemonOff")
            }
            // Show what will be saved. Rendering this unchecked while the
            // state stayed `true` meant editing an existing background
            // schedule with the daemon off looked like it was turning
            // background off while quietly keeping it on.
            checked={background}
            // Turning it *on* needs the daemon; turning it off never does, so
            // an existing background schedule stays fixable either way.
            disabled={!daemonEnabled && !background}
            onChange={setBackground}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">
              {t("rightPanel.schedules.prompt")}
            </span>
            <textarea
              className={cn(
                TEXT_INPUT_CLASS,
                "min-h-32 resize-y py-2 font-sans leading-relaxed",
              )}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              required
            />
            <span className="text-[11px] text-fg-muted">
              {t("rightPanel.schedules.promptHint")}
            </span>
          </label>
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("rightPanel.schedules.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving || !name.trim() || !prompt.trim()}
          >
            {t("rightPanel.schedules.save")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Last-run age, or the next due time when the schedule has never run. */
function ScheduleAge({ iso }: { iso: string | null }) {
  const t = useTranslation();
  if (!iso) {
    return (
      <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-fg-muted">
        {t("rightPanel.schedules.neverRun")}
      </span>
    );
  }
  const label = taskAgeLabel(iso, Date.now(), t("rightPanel.schedules.justNow"));
  if (!label) return null;
  return (
    <Tooltip
      label={taskAbsoluteTime(iso) || label}
      side="top"
      className="shrink-0"
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
