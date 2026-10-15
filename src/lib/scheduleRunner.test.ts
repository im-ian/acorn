import { describe, expect, it } from "vitest";
import {
  backgroundRunsToReap,
  buildScheduleRunNotification,
  backgroundSessionIdsForRuns,
  buildScheduleRunCommand,
  buildScheduleRunPrompt,
  scheduleSummaryPath,
} from "./scheduleRunner";
import type { ProjectSchedule, ScheduleMode } from "./types";

function schedule(mode: ScheduleMode): ProjectSchedule {
  return {
    id: "s1",
    name: "Nightly audit",
    prompt: "Review the dependency report",
    trigger: { kind: "daily", time: "09:00" },
    mode,
    background: false,
    created_at: "2026-01-01T00:00:00Z",
    last_run_at: null,
    last_slot_at: null,
    runs: [],
  };
}

describe("scheduleSummaryPath", () => {
  it("lands under the project's ignored Acorn directory", () => {
    expect(scheduleSummaryPath("/repo/demo", "run-1")).toBe(
      "/repo/demo/.acorn/schedule-summaries/run-1.md",
    );
  });

  it("uses backslashes for a Windows project root", () => {
    expect(scheduleSummaryPath("C:\\repos\\demo", "run-1")).toBe(
      "C:\\repos\\demo\\.acorn\\schedule-summaries\\run-1.md",
    );
  });
});

describe("buildScheduleRunPrompt", () => {
  const prompt = buildScheduleRunPrompt(
    "Review the dependency report",
    "/repo/demo/.acorn/schedule-summaries/run-1.md",
  );

  it("keeps the user's prompt first", () => {
    expect(prompt.startsWith("Review the dependency report")).toBe(true);
  });

  it("names the summary file and the three sections", () => {
    expect(prompt).toContain("/repo/demo/.acorn/schedule-summaries/run-1.md");
    expect(prompt).toContain("## Result");
    expect(prompt).toContain("## Details");
    expect(prompt).toContain("## Follow-up");
  });

  it("stays on one line, because it is typed into a PTY", () => {
    expect(prompt).not.toContain("\n");
  });
});

describe("buildScheduleRunCommand", () => {
  const summaryPath = "/repo/demo/.acorn/schedule-summaries/run-1.md";

  it("starts an interactive agent for a session schedule", () => {
    const command = buildScheduleRunCommand(
      schedule("session"),
      "claude",
      summaryPath,
    );
    expect(command.startsWith("claude '")).toBe(true);
    expect(command).toContain("Review the dependency report");
  });

  it("uses the provider's print form for a one-shot schedule", () => {
    expect(
      buildScheduleRunCommand(schedule("oneshot"), "claude", summaryPath),
    ).toMatch(/^claude -p --output-format text '/);
    expect(
      buildScheduleRunCommand(schedule("oneshot"), "codex", summaryPath),
    ).toMatch(/^codex exec --skip-git-repo-check '/);
  });

  it("single-quotes the prompt so the PTY sees one argument", () => {
    const command = buildScheduleRunCommand(
      { ...schedule("oneshot"), prompt: "it's fine" },
      "claude",
      summaryPath,
    );
    expect(command).toContain(`it'\\''s fine`);
  });
});

describe("backgroundRunsToReap", () => {
  const live = new Set(["s-done", "s-busy", "s-old", "s-failed"]);
  const flagged = {
    "s-done": true,
    "s-busy": true,
    "s-old": true,
    "s-failed": true,
  } as const;
  const now = Date.parse("2026-03-10T12:00:00Z");

  function bgSchedule(runs: ProjectSchedule["runs"]): ProjectSchedule {
    return { ...schedule("oneshot"), background: true, runs };
  }

  function bgRun(
    id: string,
    sessionId: string,
    overrides: Partial<ProjectSchedule["runs"][number]> = {},
  ): ProjectSchedule["runs"][number] {
    return {
      id,
      started_at: "2026-03-10T11:55:00Z",
      session_id: sessionId,
      worktree_path: "/repo/demo",
      summary_path: `/repo/demo/.acorn/schedule-summaries/${id}.md`,
      summary_ready: false,
      error: null,
      ...overrides,
    };
  }

  it("reaps a run that wrote its summary", () => {
    const schedules = [
      bgSchedule([bgRun("r1", "s-done", { summary_ready: true })]),
    ];
    expect(backgroundRunsToReap(schedules, live, flagged, now)).toEqual([
      "s-done",
    ]);
  });

  it("leaves a run that is still going", () => {
    const schedules = [bgSchedule([bgRun("r1", "s-busy")])];
    expect(backgroundRunsToReap(schedules, live, flagged, now)).toEqual([]);
  });

  it("reaps a stalled run once it passes the backstop", () => {
    const schedules = [
      bgSchedule([bgRun("r1", "s-old", { started_at: "2026-03-09T12:00:00Z" })]),
    ];
    expect(backgroundRunsToReap(schedules, live, flagged, now)).toEqual([
      "s-old",
    ]);
  });

  it("reaps a failed run", () => {
    const schedules = [
      bgSchedule([bgRun("r1", "s-failed", { error: "boom" })]),
    ];
    expect(backgroundRunsToReap(schedules, live, flagged, now)).toEqual([
      "s-failed",
    ]);
  });

  it("never reaps a session the user revealed", () => {
    const schedules = [
      bgSchedule([bgRun("r1", "s-done", { summary_ready: true })]),
    ];
    // Revealing clears the background flag, which is what protects it here.
    expect(backgroundRunsToReap(schedules, live, {}, now)).toEqual([]);
  });

  it("ignores foreground schedules and sessions already gone", () => {
    const foreground = {
      ...schedule("session"),
      runs: [bgRun("r1", "s-done", { summary_ready: true })],
    };
    expect(backgroundRunsToReap([foreground], live, flagged, now)).toEqual([]);
    expect(
      backgroundRunsToReap(
        [bgSchedule([bgRun("r1", "s-gone", { summary_ready: true })])],
        live,
        { "s-gone": true },
        now,
      ),
    ).toEqual([]);
  });
});

describe("buildScheduleRunNotification", () => {
  const base = {
    repoPath: "/repo/demo",
    projectName: "demo",
    createdAt: "2026-03-10T12:00:00.000Z",
    seq: 1,
  };

  function run(overrides: Partial<ProjectSchedule["runs"][number]> = {}) {
    return {
      id: "run-1",
      started_at: "2026-03-10T11:55:00Z",
      session_id: "s-done",
      worktree_path: "/repo/demo",
      summary_path: "/repo/demo/.acorn/schedule-summaries/run-1.md",
      summary_ready: true,
      error: null,
      ...overrides,
    };
  }

  it("names the schedule, which is what tells you which job finished", () => {
    const notification = buildScheduleRunNotification({
      ...base,
      schedule: { ...schedule("oneshot"), background: true },
      run: run(),
    });
    expect(notification.sessionName).toBe("Nightly audit");
    expect(notification.projectName).toBe("demo");
    expect(notification.kind).toBe("schedule_done");
  });

  it("routes to the schedule board, not the reaped session", () => {
    const notification = buildScheduleRunNotification({
      ...base,
      schedule: { ...schedule("oneshot"), background: true },
      run: run(),
    });
    expect(notification.scheduleId).toBe("s1");
    expect(notification.repoPath).toBe("/repo/demo");
  });

  it("carries the error styling when the run failed", () => {
    const notification = buildScheduleRunNotification({
      ...base,
      schedule: { ...schedule("oneshot"), background: true },
      run: run({ error: "no agent", summary_ready: false }),
    });
    expect(notification.kind).toBe("errored");
    expect(notification.status).toBe("errored");
  });

  it("stays unique per run so two finishes never collide", () => {
    const first = buildScheduleRunNotification({
      ...base,
      schedule: { ...schedule("oneshot"), background: true },
      run: run({ id: "run-1" }),
    });
    const second = buildScheduleRunNotification({
      ...base,
      seq: 2,
      schedule: { ...schedule("oneshot"), background: true },
      run: run({ id: "run-2" }),
    });
    expect(first.id).not.toBe(second.id);
  });
});

describe("backgroundSessionIdsForRuns", () => {
  function withSession(id: string, sessionId: string | null) {
    return {
      id,
      started_at: "2026-03-10T11:55:00Z",
      session_id: sessionId,
      worktree_path: "/repo/demo",
      summary_path: null,
      summary_ready: false,
      error: null,
    };
  }

  it("picks the hidden sessions a set of records owns", () => {
    // These are only reachable through their run record, so dropping the
    // record without removing them leaves a daemon PTY nobody can see.
    expect(
      backgroundSessionIdsForRuns(
        [withSession("r1", "s-bg"), withSession("r2", "s-visible")],
        { "s-bg": true },
      ),
    ).toEqual(["s-bg"]);
  });

  it("leaves a revealed session alone and tolerates runs with none", () => {
    // Revealing clears the flag, which is what keeps the user's own tab from
    // being closed under them.
    expect(
      backgroundSessionIdsForRuns([withSession("r1", "s-bg")], {}),
    ).toEqual([]);
    expect(
      backgroundSessionIdsForRuns([withSession("r1", null)], { "s-bg": true }),
    ).toEqual([]);
  });

  it("does not repeat a session two records share", () => {
    expect(
      backgroundSessionIdsForRuns(
        [withSession("r1", "s-bg"), withSession("r2", "s-bg")],
        { "s-bg": true },
      ),
    ).toEqual(["s-bg"]);
  });
});
