import type { ProjectSchedule, ScheduleTrigger } from "./types";

export const SCHEDULE_TRIGGER_KINDS = [
  "interval",
  "daily",
  "weekly",
] as const;

export type ScheduleTriggerKind = (typeof SCHEDULE_TRIGGER_KINDS)[number];

function parseHourMinute(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":");
  return {
    hour: Math.min(23, Math.max(0, Number(hour) || 0)),
    minute: Math.min(59, Math.max(0, Number(minute) || 0)),
  };
}

/**
 * First fire time strictly after `fromMs`, in the user's local zone. Daily and
 * weekly triggers mean a wall-clock instant, so the math has to run here and
 * not in the backend, which has no idea what zone the user sits in.
 */
export function nextScheduleRunAt(
  trigger: ScheduleTrigger,
  fromMs: number,
): number {
  if (trigger.kind === "interval") {
    const every = Math.max(1, Math.round(trigger.every_minutes));
    return fromMs + every * 60_000;
  }
  const { hour, minute } = parseHourMinute(trigger.time);
  const next = new Date(fromMs);
  next.setHours(hour, minute, 0, 0);
  if (trigger.kind === "daily") {
    if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const target = ((Math.round(trigger.weekday) % 7) + 7) % 7;
  let days = (target - next.getDay() + 7) % 7;
  if (days === 0 && next.getTime() <= fromMs) days = 7;
  next.setDate(next.getDate() + days);
  return next.getTime();
}

/**
 * Where the next slot is measured from: the last slot the timer consumed, else
 * creation.
 *
 * Deliberately not `last_run_at`. A run starts up to a tick late, so anchoring
 * on it folds that lateness into every slot after it — at a 60s tick and a
 * 10-minute interval that compounds to over an hour of skew a day. It would
 * also let a manual "Run now" shove the whole schedule forward, which is not
 * what pressing a button should do.
 */
export function scheduleAnchorMs(schedule: ProjectSchedule): number {
  return Date.parse(schedule.last_slot_at ?? schedule.created_at);
}

export function nextScheduleRunAtFor(schedule: ProjectSchedule): number | null {
  const anchor = scheduleAnchorMs(schedule);
  if (!Number.isFinite(anchor)) return null;
  return nextScheduleRunAt(schedule.trigger, anchor);
}

/**
 * The slot a schedule is currently owed, or `null` when it is not due.
 *
 * Returns the *latest* slot at or before `nowMs`, not the first one missed: a
 * schedule that slept through twenty slots fires once and resumes in step,
 * rather than replaying twenty runs or drifting off the sequence.
 */
export function dueScheduleSlotMs(
  schedule: ProjectSchedule,
  nowMs: number,
): number | null {
  const anchor = scheduleAnchorMs(schedule);
  if (!Number.isFinite(anchor)) return null;
  let slot = nextScheduleRunAt(schedule.trigger, anchor);
  if (slot > nowMs) return null;
  // Walk forward to the last slot that has already come due. Bounded by a
  // hard cap so a pathological anchor cannot spin here.
  for (let step = 0; step < MAX_SLOT_CATCHUP_STEPS; step += 1) {
    const following = nextScheduleRunAt(schedule.trigger, slot);
    if (following > nowMs) return slot;
    slot = following;
  }
  return slot;
}

/** Enough to walk a year of 1-minute slots, which no real anchor needs. */
const MAX_SLOT_CATCHUP_STEPS = 600_000;

export function isScheduleDue(
  schedule: ProjectSchedule,
  nowMs: number,
): boolean {
  return dueScheduleSlotMs(schedule, nowMs) !== null;
}

/**
 * A run's wall-clock time, `MM/DD HH:MM` in local time. This is what identifies
 * a run on the board: the session behind it can be removed, but when it ran
 * never changes.
 */
export function scheduleRunTimeLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Absolute local time of the next run, for the schedule board header. */
export function scheduleNextRunLabel(schedule: ProjectSchedule): string {
  const next = nextScheduleRunAtFor(schedule);
  if (next === null) return "";
  return new Date(next).toLocaleString();
}

/** Short weekday name for `0`=Sunday … `6`=Saturday, in the app's language. */
export function weekdayShortLabel(weekday: number, locale: string): string {
  // 2024-01-07 is a Sunday, so the offset lines up with `Date#getDay`.
  const index = ((Math.round(weekday) % 7) + 7) % 7;
  const date = new Date(2024, 0, 7 + index);
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
}

/** One-line recurrence, e.g. `Every 1h 30m`, `Daily 09:30`, `Fri 07:15`. */
export function scheduleTriggerSummary(
  trigger: ScheduleTrigger,
  labels: { locale: string; every: string; daily: string },
): string {
  if (trigger.kind === "interval") {
    const total = Math.max(1, Math.round(trigger.every_minutes));
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    const span =
      hours === 0
        ? `${minutes}m`
        : minutes === 0
          ? `${hours}h`
          : `${hours}h ${minutes}m`;
    return `${labels.every} ${span}`;
  }
  if (trigger.kind === "daily") return `${labels.daily} ${trigger.time}`;
  return `${weekdayShortLabel(trigger.weekday, labels.locale)} ${trigger.time}`;
}
