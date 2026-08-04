import { describe, expect, it } from "vitest";
import type { GraphRunState } from "./types";
import {
  selectLatestGraphRunState,
  sessionStatusForGraphRun,
} from "./graphSessionRun";

function runState(
  runId: string,
  revision: number,
  startedAt: string,
  updatedAt = startedAt,
): GraphRunState {
  return {
    schema_version: 1,
    session_id: "graph-session",
    run_id: runId,
    revision,
    graph_revision: 1,
    objective: "Test graph state ordering",
    agent: { provider: "claude" },
    status: "running",
    definition: {
      version: 2,
      execution_mode: "parallel",
      nodes: [
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [],
      groups: [],
    },
    nodes: {
      goal: { node_id: "goal", status: "queued", attempt: 0 },
    },
    edges: {},
    started_at: startedAt,
    updated_at: updatedAt,
  };
}

describe("sessionStatusForGraphRun", () => {
  it.each([
    ["running", "working"],
    ["waiting", "waiting_for_input"],
    ["completed", "ready"],
    ["failed", "errored"],
    ["cancelled", "ready"],
  ] as const)("maps %s Graph runs to %s sessions", (run, session) => {
    expect(sessionStatusForGraphRun(run)).toBe(session);
  });
});

describe("selectLatestGraphRunState", () => {
  it("does not let a slow snapshot replace a newer event revision", () => {
    const event = runState("run-1", 8, "2026-01-01T00:00:00Z");
    const staleSnapshot = runState("run-1", 7, "2026-01-01T00:00:00Z");

    expect(selectLatestGraphRunState(event, staleSnapshot)).toBe(event);
    expect(selectLatestGraphRunState(staleSnapshot, event)).toBe(event);
  });

  it("accepts a newer run even when its revision restarts at one", () => {
    const oldRun = runState("run-1", 12, "2026-01-01T00:00:00Z");
    const newRun = runState("run-2", 1, "2026-01-01T00:01:00Z");

    expect(selectLatestGraphRunState(oldRun, newRun)).toBe(newRun);
    expect(selectLatestGraphRunState(newRun, oldRun)).toBe(newRun);
  });
});
