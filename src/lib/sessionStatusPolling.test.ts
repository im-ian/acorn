import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "./types";
import {
  ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
  STABLE_SESSION_STATUS_POLL_INTERVAL_MS,
  VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS,
  nextSessionStatusPollDelayMs,
  selectDueSessionStatusPollIds,
  selectImmediateSessionStatusPollIds,
  sessionStatusPollIntervalMs,
} from "./sessionStatusPolling";

const REPO = "/Users/me/repo";

function session(id: string, status: SessionStatus): Session {
  return {
    id,
    name: id,
    repo_path: REPO,
    worktree_path: `${REPO}/.worktrees/${id}`,
    branch: `feat/${id}`,
    isolated: false,
    status,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
  };
}

describe("session status polling schedule", () => {
  it("uses fast active, medium volatile, and slow stable intervals", () => {
    expect(sessionStatusPollIntervalMs(session("a", "idle"), "a")).toBe(
      ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(sessionStatusPollIntervalMs(session("b", "running"), "a")).toBe(
      VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(sessionStatusPollIntervalMs(session("c", "needs_input"), "a")).toBe(
      VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(sessionStatusPollIntervalMs(session("d", "completed"), "a")).toBe(
      STABLE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
  });

  it("selects only sessions whose adaptive interval has elapsed", () => {
    const now = 60_000;
    const sessions = [
      session("active", "idle"),
      session("running", "running"),
      session("needs", "needs_input"),
      session("idle", "idle"),
      session("failed", "failed"),
    ];
    const lastPolledAt = new Map([
      ["active", now - ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS],
      ["running", now - VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS + 1],
      ["needs", now - VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS],
      ["idle", now - STABLE_SESSION_STATUS_POLL_INTERVAL_MS + 1],
      ["failed", now - STABLE_SESSION_STATUS_POLL_INTERVAL_MS],
    ]);

    expect(
      selectDueSessionStatusPollIds({
        sessions,
        activeSessionId: "active",
        lastPolledAt,
        now,
      }),
    ).toEqual(["active", "needs", "failed"]);
  });

  it("prioritizes active and newly seen sessions for immediate polling", () => {
    const sessions = [
      session("active", "idle"),
      session("running", "running"),
      session("new", "idle"),
      session("stable", "completed"),
    ];
    const lastPolledAt = new Map([
      ["active", 100],
      ["running", 100],
      ["stable", 100],
    ]);

    expect(
      selectImmediateSessionStatusPollIds({
        sessions,
        activeSessionId: "active",
        lastPolledAt,
      }),
    ).toEqual(["active", "new"]);
    expect(
      selectImmediateSessionStatusPollIds({
        sessions,
        activeSessionId: "active",
        lastPolledAt,
        includeVolatile: true,
      }),
    ).toEqual(["active", "running", "new"]);
  });

  it("returns the delay until the next session becomes due", () => {
    const now = 60_000;
    const sessions = [
      session("active", "idle"),
      session("running", "running"),
      session("idle", "idle"),
    ];
    const lastPolledAt = new Map([
      ["active", now - 250],
      ["running", now - 4500],
      ["idle", now - 1000],
    ]);

    expect(
      nextSessionStatusPollDelayMs({
        sessions,
        activeSessionId: "active",
        lastPolledAt,
        now,
      }),
    ).toBe(500);
  });
});
