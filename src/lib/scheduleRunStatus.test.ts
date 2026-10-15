import { describe, expect, it } from "vitest";
import { isScheduleRunning, scheduleRunState } from "./scheduleRunStatus";
import type { ScheduleRun } from "./types";

/** Fixed clock, so the staleness bound is exercised deliberately. */
const NOW = Date.parse("2026-03-10T12:00:00Z");

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: "run-1",
    // Recent relative to NOW: a run only reads as active inside the bound.
    started_at: "2026-03-10T11:59:00Z",
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
    expect(scheduleRunState(run({ error: "no agent" }), false, NOW)).toBe("failed");
  });

  it("keeps a failed launch failed even with a summary on disk", () => {
    expect(
      scheduleRunState(run({ error: "boom", summary_ready: true }), true, NOW),
    ).toBe("failed");
  });

  it("reports success once the summary landed", () => {
    expect(scheduleRunState(run({ summary_ready: true }), false, NOW)).toBe(
      "success",
    );
  });

  it("prefers success over a session that is still open", () => {
    // `session` mode leaves the agent sitting at its prompt after the work is
    // done, so a live session must not outrank a finished report.
    expect(scheduleRunState(run({ summary_ready: true }), true, NOW)).toBe(
      "success",
    );
  });

  it("reports running while the session is alive and unsummarized", () => {
    expect(scheduleRunState(run(), true, NOW)).toBe("running");
  });

  it("reports ended when nothing is left to look at", () => {
    expect(scheduleRunState(run(), false, NOW)).toBe("ended");
    // Runs that predate work summaries carry no path at all.
    expect(
      scheduleRunState(run({ summary_path: null }), false, NOW),
    ).toBe("ended");
  });
});

describe("isScheduleRunning", () => {
  const live = new Set(["s-alive"]);

  it("is true while a run's session is still up", () => {
    expect(
      isScheduleRunning(
        { runs: [run({ session_id: "s-alive" })] },
        live,
        NOW,
      ),
    ).toBe(true);
  });

  it("is false once the run wrote its summary", () => {
    // `session` mode leaves the agent at its prompt after the work is done, so
    // a live session alone must not hold the next slot back forever.
    expect(
      isScheduleRunning(
        { runs: [run({ session_id: "s-alive", summary_ready: true })] },
        live,
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a failed run, a finished one, and no runs at all", () => {
    expect(
      isScheduleRunning({ runs: [run({ error: "boom" })] }, live, NOW),
    ).toBe(false);
    expect(
      isScheduleRunning({ runs: [run({ session_id: "s-gone" })] }, live, NOW),
    ).toBe(false);
    expect(isScheduleRunning({ runs: [] }, live, NOW)).toBe(false);
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
        NOW,
      ),
    ).toBe(true);
  });
});

describe("scheduleRunState staleness", () => {
  const now = NOW;
  const fresh = "2026-03-10T11:59:00Z";
  const ancient = "2026-03-09T12:00:00Z";

  it("reads a claimed run as starting, before its session exists", () => {
    expect(
      scheduleRunState(
        run({ started_at: fresh, session_id: null }),
        false,
        now,
      ),
    ).toBe("starting");
  });

  it("gives up on a run that never finished", () => {
    // A `session` run the user interrupts writes no summary and keeps its
    // session open. Without a bound this stayed RUNNING for good, which held
    // the overlap guard shut and the schedule never fired again.
    expect(
      scheduleRunState(run({ started_at: ancient }), true, now),
    ).toBe("ended");
    // Including one stuck in the claim window when the app closed.
    expect(
      scheduleRunState(
        run({ started_at: ancient, session_id: null }),
        false,
        now,
      ),
    ).toBe("ended");
  });

  it("still reports a finished run as success however old it is", () => {
    expect(
      scheduleRunState(
        run({ started_at: ancient, summary_ready: true }),
        false,
        now,
      ),
    ).toBe("success");
  });
});

describe("isScheduleRunning staleness", () => {
  const now = NOW;
  const live = new Set(["s-alive"]);

  it("holds the slot for a run that is only just starting", () => {
    expect(
      isScheduleRunning(
        {
          runs: [
            run({ started_at: "2026-03-10T11:59:50Z", session_id: null }),
          ],
        },
        live,
        now,
      ),
    ).toBe(true);
  });

  it("releases the slot once a stuck run goes stale", () => {
    expect(
      isScheduleRunning(
        {
          runs: [
            run({ started_at: "2026-03-09T12:00:00Z", session_id: "s-alive" }),
          ],
        },
        live,
        now,
      ),
    ).toBe(false);
  });
});
