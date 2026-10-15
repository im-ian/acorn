import type { TranslationKey } from "./i18n";
import type { ProjectSchedule, ScheduleRun } from "./types";

export type ScheduleRunState = "failed" | "success" | "running" | "ended";

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
): ScheduleRunState {
  if (run.error) return "failed";
  if (run.summary_ready) return "success";
  if (sessionAlive) return "running";
  // No error, no report, nothing still running: the run is over and left
  // nothing behind. True for anything that predates work summaries, and for a
  // session removed before the agent finished.
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
): boolean {
  return schedule.runs.some(
    (run) =>
      scheduleRunState(
        run,
        run.session_id ? liveSessionIds.has(run.session_id) : false,
      ) === "running",
  );
}

/** Colour carries the state; the row stays a single line of text. */
export const SCHEDULE_RUN_STATE_CLASS: Record<ScheduleRunState, string> = {
  failed: "text-danger",
  success: "text-emerald-400",
  running: "text-accent",
  ended: "text-fg-muted",
};

export const SCHEDULE_RUN_STATE_LABEL: Record<
  ScheduleRunState,
  TranslationKey
> = {
  failed: "rightPanel.schedules.state.failed",
  success: "rightPanel.schedules.state.success",
  running: "rightPanel.schedules.state.running",
  ended: "rightPanel.schedules.state.ended",
};
