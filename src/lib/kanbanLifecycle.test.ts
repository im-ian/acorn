import { describe, expect, it } from "vitest";
import {
  EMPTY_KANBAN_STAGE_CONTEXT,
  KANBAN_LIFECYCLE_STAGES,
  KANBAN_STALL_THRESHOLD_MS,
  deriveKanbanStage,
  formatKanbanDwell,
  isKanbanSessionStalled,
  updateKanbanStageDwell,
  type KanbanLifecycleStage,
  type KanbanStageContext,
  type KanbanStageDwell,
} from "./kanbanLifecycle";
import type { PullRequestInfo, Session, SessionStatus } from "./types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s",
    name: "session",
    branch: "feat/x",
    worktree_path: "/repo/x",
    status: "ready",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Session;
}

function makePr(state: string): PullRequestInfo {
  return {
    number: 7,
    title: "PR",
    state,
    author: "me",
    head_branch: "feat/x",
    base_branch: "main",
    url: "https://example.test/pr/7",
    updated_at: "2026-01-01T00:00:00.000Z",
    is_draft: false,
    checks: null,
    labels: [],
  };
}

function ctx(overrides: Partial<KanbanStageContext> = {}): KanbanStageContext {
  return { ...EMPTY_KANBAN_STAGE_CONTEXT, ...overrides };
}

describe("deriveKanbanStage", () => {
  it("maps bare statuses without board context", () => {
    const expected: Record<SessionStatus, KanbanLifecycleStage> = {
      ready: "idle",
      working: "working",
      waiting_for_input: "waiting",
      errored: "waiting",
    };
    for (const [status, stage] of Object.entries(expected)) {
      expect(
        deriveKanbanStage(
          makeSession({ status: status as SessionStatus }),
          ctx(),
        ),
      ).toBe(stage);
    }
  });

  it("keeps a ready session with a pre-existing dirty worktree in idle", () => {
    expect(
      deriveKanbanStage(
        makeSession({ status: "ready" }),
        ctx({ hasDiff: true }),
      ),
    ).toBe("idle");
  });

  it("puts a ready session with a dirty worktree and agent transcript in review", () => {
    expect(
      deriveKanbanStage(
        makeSession({
          status: "ready",
          agent_transcript_id: "codex-turn-1",
        }),
        ctx({ hasDiff: true }),
      ),
    ).toBe("review");
  });

  it("uses agent conversation previews when transcript metadata is unavailable", () => {
    expect(
      deriveKanbanStage(
        makeSession({
          status: "ready",
          last_user_message: "Implement the requested change",
        }),
        ctx({ hasDiff: true }),
      ),
    ).toBe("review");
  });

  it("uses a detected completed turn when transcript previews are unavailable", () => {
    expect(
      deriveKanbanStage(
        makeSession({ status: "ready", status_reason: "turn_complete" }),
        ctx({ hasDiff: true }),
      ),
    ).toBe("review");
  });

  it("keeps a ready session with a clean worktree in idle", () => {
    expect(
      deriveKanbanStage(makeSession({ status: "ready" }), ctx()),
    ).toBe("idle");
  });

  it("puts an idle session with an open PR in review", () => {
    expect(
      deriveKanbanStage(makeSession(), ctx({ pr: makePr("OPEN") })),
    ).toBe("review");
  });

  it("normalizes PR state casing", () => {
    expect(
      deriveKanbanStage(makeSession(), ctx({ pr: makePr("open") })),
    ).toBe("review");
    expect(
      deriveKanbanStage(makeSession(), ctx({ pr: makePr("merged") })),
    ).toBe("done");
  });

  it("keeps running and waiting sessions live even with an open PR", () => {
    expect(
      deriveKanbanStage(
        makeSession({ status: "working" }),
        ctx({ pr: makePr("OPEN") }),
      ),
    ).toBe("working");
    expect(
      deriveKanbanStage(
        makeSession({ status: "waiting_for_input" }),
        ctx({ pr: makePr("OPEN") }),
      ),
    ).toBe("waiting");
    expect(
      deriveKanbanStage(
        makeSession({ status: "errored" }),
        ctx({ pr: makePr("OPEN") }),
      ),
    ).toBe("waiting");
  });

  it("moves merged and closed PRs to done regardless of status", () => {
    for (const state of ["MERGED", "CLOSED"]) {
      expect(
        deriveKanbanStage(
          makeSession({ status: "working" }),
          ctx({ pr: makePr(state) }),
        ),
      ).toBe("done");
    }
  });

  it("lets a manual done pin outrank everything", () => {
    expect(
      deriveKanbanStage(
        makeSession({ status: "waiting_for_input" }),
        ctx({ pr: makePr("OPEN"), hasDiff: true, manualDone: true }),
      ),
    ).toBe("done");
  });

  it("orders stages idle → working → waiting → review → done", () => {
    expect(KANBAN_LIFECYCLE_STAGES).toEqual([
      "idle",
      "working",
      "waiting",
      "review",
      "done",
    ]);
  });
});

describe("updateKanbanStageDwell", () => {
  const t0 = 1_000;
  const t1 = 61_000;

  it("stamps new sessions with the current time", () => {
    const next = updateKanbanStageDwell(
      new Map(),
      new Map([["a", "working"]]),
      t0,
    );
    expect(next.get("a")).toEqual({ stage: "working", since: t0 });
  });

  it("preserves since while the stage is unchanged", () => {
    const previous = new Map<string, KanbanStageDwell>([
      ["a", { stage: "working", since: t0 }],
    ]);
    const next = updateKanbanStageDwell(
      previous,
      new Map([["a", "working"]]),
      t1,
    );
    expect(next.get("a")).toEqual({ stage: "working", since: t0 });
  });

  it("restarts since on a stage change", () => {
    const previous = new Map<string, KanbanStageDwell>([
      ["a", { stage: "working", since: t0 }],
    ]);
    const next = updateKanbanStageDwell(
      previous,
      new Map([["a", "review"]]),
      t1,
    );
    expect(next.get("a")).toEqual({ stage: "review", since: t1 });
  });

  it("drops sessions that disappeared and never mutates the input", () => {
    const previous = new Map<string, KanbanStageDwell>([
      ["gone", { stage: "idle", since: t0 }],
    ]);
    const next = updateKanbanStageDwell(
      previous,
      new Map([["kept", "idle"]]),
      t1,
    );
    expect(next.has("gone")).toBe(false);
    expect(previous.get("gone")).toEqual({ stage: "idle", since: t0 });
  });
});

describe("isKanbanSessionStalled", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const startedMs = Date.parse(startedAt);

  it("flags a working session with no live processes past the threshold", () => {
    expect(
      isKanbanSessionStalled(
        makeSession({
          status: "working",
          status_started_at: startedAt,
          active_processes: [],
        }),
        "working",
        startedMs + KANBAN_STALL_THRESHOLD_MS,
      ),
    ).toBe(true);
  });

  it("does not use updated_at as a heartbeat", () => {
    expect(
      isKanbanSessionStalled(
        makeSession({
          status: "working",
          updated_at: "2026-01-01T00:00:00.000Z",
        }),
        "working",
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(false);
  });

  it("does not flag working sessions with live processes", () => {
    expect(
      isKanbanSessionStalled(
        makeSession({
          status: "working",
          status_started_at: startedAt,
          active_processes: [{ pid: 12, name: "codex", depth: 1 }],
        }),
        "working",
        startedMs + KANBAN_STALL_THRESHOLD_MS * 10,
      ),
    ).toBe(false);
  });

  it("does not flag fresh working sessions or other stages", () => {
    expect(
      isKanbanSessionStalled(
        makeSession({ status: "working", status_started_at: startedAt }),
        "working",
        startedMs + KANBAN_STALL_THRESHOLD_MS - 1,
      ),
    ).toBe(false);
    expect(
      isKanbanSessionStalled(
        makeSession({ status_started_at: startedAt }),
        "waiting",
        startedMs + KANBAN_STALL_THRESHOLD_MS * 10,
      ),
    ).toBe(false);
  });

  it("never flags an unparseable status start", () => {
    expect(
      isKanbanSessionStalled(
        makeSession({ status: "working", status_started_at: "not-a-date" }),
        "working",
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(false);
  });
});

describe("formatKanbanDwell", () => {
  it("formats each magnitude compactly", () => {
    expect(formatKanbanDwell(0)).toBe("0s");
    expect(formatKanbanDwell(45_000)).toBe("45s");
    expect(formatKanbanDwell(12 * 60_000)).toBe("12m");
    expect(formatKanbanDwell(3 * 3_600_000)).toBe("3h");
    expect(formatKanbanDwell(2 * 86_400_000)).toBe("2d");
  });

  it("clamps negative durations to zero", () => {
    expect(formatKanbanDwell(-5_000)).toBe("0s");
  });
});
