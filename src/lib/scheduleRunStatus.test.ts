import { describe, expect, it } from "vitest";
import { isScheduleRunning, scheduleRunState } from "./scheduleRunStatus";
import type { ScheduleRun } from "./types";

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: "run-1",
    started_at: "2026-01-01T09:00:00Z",
    session_id: "s1",
    worktree_path: "/repo/demo",
    summary_path: "/repo/demo/.acorn/schedule-summaries/run-1.md",
    summary_ready: false,
    error: null,
    ...overrides,
  };
}

describe("scheduleRunState", () => {
  it("reports a failed launch", () => {
    expect(scheduleRunState(run({ error: "no agent" }), false)).toBe("failed");
  });

  it("keeps a failed launch failed even with a summary on disk", () => {
    expect(
      scheduleRunState(run({ error: "boom", summary_ready: true }), true),
    ).toBe("failed");
  });

  it("reports success once the summary landed", () => {
    expect(scheduleRunState(run({ summary_ready: true }), false)).toBe(
      "success",
    );
  });

  it("prefers success over a session that is still open", () => {
    // `session` mode leaves the agent sitting at its prompt after the work is
    // done, so a live session must not outrank a finished report.
    expect(scheduleRunState(run({ summary_ready: true }), true)).toBe(
      "success",
    );
  });

  it("reports running while the session is alive and unsummarized", () => {
    expect(scheduleRunState(run(), true)).toBe("running");
  });

  it("reports ended when nothing is left to look at", () => {
    expect(scheduleRunState(run(), false)).toBe("ended");
    // Runs that predate work summaries carry no path at all.
    expect(scheduleRunState(run({ summary_path: null }), false)).toBe("ended");
  });
});

describe("isScheduleRunning", () => {
  const live = new Set(["s-alive"]);

  it("is true while a run's session is still up", () => {
    expect(
      isScheduleRunning({ runs: [run({ session_id: "s-alive" })] }, live),
    ).toBe(true);
  });

  it("is false once the run wrote its summary", () => {
    // `session` mode leaves the agent at its prompt after the work is done, so
    // a live session alone must not hold the next slot back forever.
    expect(
      isScheduleRunning(
        { runs: [run({ session_id: "s-alive", summary_ready: true })] },
        live,
      ),
    ).toBe(false);
  });

  it("is false for a failed run, a finished one, and no runs at all", () => {
    expect(
      isScheduleRunning({ runs: [run({ error: "boom" })] }, live),
    ).toBe(false);
    expect(
      isScheduleRunning({ runs: [run({ session_id: "s-gone" })] }, live),
    ).toBe(false);
    expect(isScheduleRunning({ runs: [] }, live)).toBe(false);
  });

  it("is true when any one of several runs is still going", () => {
    expect(
      isScheduleRunning(
        {
          runs: [
            run({ id: "old", session_id: "s-gone", summary_ready: true }),
            run({ id: "new", session_id: "s-alive" }),
          ],
        },
        live,
      ),
    ).toBe(true);
  });
});
