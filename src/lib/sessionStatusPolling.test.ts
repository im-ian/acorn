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

function session(
  id: string,
  status: SessionStatus,
  overrides: Partial<Session> = {},
): Session {
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
    ...overrides,
  };
}

describe("session status polling schedule", () => {
  it("uses fast active, medium volatile, and slow stable intervals", () => {
    expect(sessionStatusPollIntervalMs(session("a", "ready"), "a")).toBe(
      ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(sessionStatusPollIntervalMs(session("b", "working"), "a")).toBe(
      VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(sessionStatusPollIntervalMs(session("c", "waiting_for_input"), "a")).toBe(
      VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(sessionStatusPollIntervalMs(session("d", "ready"), "a")).toBe(
      STABLE_SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(
      sessionStatusPollIntervalMs(
        session("e", "ready", { agent_provider: "claude" }),
        "a",
      ),
    ).toBe(VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS);
  });

  it("selects only sessions whose adaptive interval has elapsed", () => {
    const now = 60_000;
    const sessions = [
      session("active", "ready"),
      session("working", "working"),
      session("needs", "waiting_for_input"),
      session("ready", "ready"),
      session("errored", "errored"),
    ];
    const lastPolledAt = new Map([
      ["active", now - ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS],
      ["working", now - VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS + 1],
      ["needs", now - VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS],
      ["ready", now - STABLE_SESSION_STATUS_POLL_INTERVAL_MS + 1],
      ["errored", now - STABLE_SESSION_STATUS_POLL_INTERVAL_MS],
    ]);

    expect(
      selectDueSessionStatusPollIds({
        sessions,
        activeSessionId: "active",
        lastPolledAt,
        now,
      }),
    ).toEqual(["active", "needs", "errored"]);
  });

  it("prioritizes active and newly seen sessions for immediate polling", () => {
    const sessions = [
      session("active", "ready"),
      session("working", "working"),
      session("new", "ready"),
      session("stable", "ready"),
    ];
    const lastPolledAt = new Map([
      ["active", 100],
      ["working", 100],
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
    ).toEqual(["active", "working", "new"]);
  });

  it("returns the delay until the next session becomes due", () => {
    const now = 60_000;
    const sessions = [
      session("active", "ready"),
      session("working", "working"),
      session("ready", "ready"),
    ];
    const lastPolledAt = new Map([
      ["active", now - 250],
      ["working", now - 4500],
      ["ready", now - 1000],
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
