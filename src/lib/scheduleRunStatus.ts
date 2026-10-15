import type { TranslationKey } from "./i18n";
import type { ProjectSchedule, ScheduleRun } from "./types";

export type ScheduleRunState =
  | "failed"
  | "success"
  | "running"
  | "starting"
  | "ended";

/**
 * How long a run may look active before it is treated as abandoned.
 *
 * Nothing tells Acorn that an agent gave up: a `session` run the user
 * interrupts never writes a summary and its session stays open, which without
 * a bound reads as RUNNING for good — holding the overlap guard shut so the
 * schedule never fires again, and keeping an open board polling forever.
 *
 * ponytail: one flat ceiling for every cadence. A schedule firing more often
 * than this loses at most one window of slots to a stuck run; per-cadence
 * bounds would only matter if that proves too coarse in practice.
 */
export const RUN_STALE_AFTER_MS = 6 * 60 * 60 * 1_000;

/**
 * What a run amounts to, from the three things Acorn actually knows: whether
 * the launch itself failed, whether the agent got as far as writing its work
 * summary, and whether the run's session is still around.
 *
 * Precedence is deliberate. A failed launch stays failed even if a summary file
 * happens to sit at that path, and a written summary outranks a live session
 * because `session` mode leaves the agent open long after it finished the work.
 */
export function scheduleRunState(
  run: ScheduleRun,
  sessionAlive: boolean,
  nowMs: number = Date.now(),
): ScheduleRunState {
  if (run.error) return "failed";
  if (run.summary_ready) return "success";
  const startedAt = Date.parse(run.started_at);
  const stale =
    Number.isFinite(startedAt) && nowMs - startedAt > RUN_STALE_AFTER_MS;
  // The claim lands before the session exists, and creating one takes seconds.
  // Without this the row reads ENDED — grey and terminal — for that whole
  // window, and forever if the app closes inside it.
  if (!stale && run.session_id === null) return "starting";
  if (sessionAlive && !stale) return "running";
  // No error, no report, nothing still running: the run is over and left
  // nothing behind. True for anything that predates work summaries, for a
  // session removed before the agent finished, and for a run that sat active
  // past `RUN_STALE_AFTER_MS`.
  return "ended";
}

/**
 * Whether any of this schedule's runs is still going.
 *
 * Slots are fixed instants, so a run that outlasts its interval would other-
 * wise have the next slot launch straight over the top of it — three
 * concurrent agents on a 10-minute schedule whose work takes 25. The timer
 * skips a slot while this is true and picks the sequence back up on the next
 * one, which is why the cadence stays exact without ever overlapping.
 */
export function isScheduleRunning(
  schedule: Pick<ProjectSchedule, "runs">,
  liveSessionIds: ReadonlySet<string>,
  nowMs: number = Date.now(),
): boolean {
  return schedule.runs.some((run) => {
    const state = scheduleRunState(
      run,
      run.session_id ? liveSessionIds.has(run.session_id) : false,
      nowMs,
    );
    return state === "running" || state === "starting";
  });
}

/** Colour carries the state; the row stays a single line of text. */
export const SCHEDULE_RUN_STATE_CLASS: Record<ScheduleRunState, string> = {
  failed: "text-danger",
  success: "text-emerald-400",
  running: "text-accent",
  starting: "text-accent",
  ended: "text-fg-muted",
};

export const SCHEDULE_RUN_STATE_LABEL: Record<
  ScheduleRunState,
  TranslationKey
> = {
  failed: "rightPanel.schedules.state.failed",
  success: "rightPanel.schedules.state.success",
  running: "rightPanel.schedules.state.running",
  starting: "rightPanel.schedules.state.starting",
  ended: "rightPanel.schedules.state.ended",
};
