import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import {
  shouldAutoCloseFinishedSession,
  startSessionAutoCloseWatcher,
} from "./sessionAutoClose";
import type { Session } from "./types";

const BASE_SESSION: Session = {
  id: "session-1",
  name: "Agent",
  repo_path: "/repo/acorn",
  worktree_path: "/repo/acorn",
  branch: "main",
  isolated: false,
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_message: null,
  title_source: "default",
  kind: "regular",
  owner: { kind: "user" },
  position: null,
  in_worktree: false,
  agent_provider: "codex",
};

function session(patch: Partial<Session> = {}): Session {
  return { ...BASE_SESSION, ...patch };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

const originalRemoveSession = useAppStore.getState().removeSession;

describe("session auto-close", () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [session()],
      projects: [
        {
          repo_path: "/repo/acorn",
          name: "acorn",
          created_at: "",
          position: 0,
        },
      ],
      activeSessionId: null,
      sessionNotifications: [],
      autoCloseSessionIds: {},
      sessionsLoadedCleanly: true,
      removeSession: originalRemoveSession,
    });
  });

  it("matches agent-backed sessions that transition to ready states", () => {
    expect(
      shouldAutoCloseFinishedSession(
        session({
          status: "needs_input",
          status_reason: "turn_complete",
          agent_provider: "codex",
        }),
        "running",
        true,
      ),
    ).toBe(true);
    expect(
      shouldAutoCloseFinishedSession(
        session({ status: "completed" }),
        "running",
        true,
      ),
    ).toBe(true);
    expect(
      shouldAutoCloseFinishedSession(
        session({
          status: "idle",
          agent_provider: null,
          agent_transcript_id: null,
        }),
        "running",
        true,
        true,
      ),
    ).toBe(true);
  });

  it("ignores plain shell sessions and failures", () => {
    expect(
      shouldAutoCloseFinishedSession(
        session({
          status: "needs_input",
          agent_provider: null,
          agent_transcript_id: null,
        }),
        "running",
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoCloseFinishedSession(
        session({ status: "failed" }),
        "running",
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoCloseFinishedSession(
        session({ status: "needs_input" }),
        "running",
        false,
      ),
    ).toBe(false);
  });

  it("does not close active needs_input states that may be approvals", () => {
    expect(
      shouldAutoCloseFinishedSession(
        session({ status: "needs_input", agent_provider: "codex" }),
        "running",
        true,
      ),
    ).toBe(false);
  });

  it("does not treat historical transcripts as an active agent signal", () => {
    const historicalAgentSession = session({
      status: "needs_input",
      status_reason: "turn_complete",
      agent_provider: null,
      agent_transcript_id: "codex-old",
    });

    expect(
      shouldAutoCloseFinishedSession(
        historicalAgentSession,
        "running",
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoCloseFinishedSession(
        { ...historicalAgentSession, status: "idle" },
        "running",
        true,
      ),
    ).toBe(false);
  });

  it("does not auto-close control sessions that could cascade to workers", () => {
    expect(
      shouldAutoCloseFinishedSession(
        session({ kind: "control", status: "needs_input" }),
        "running",
        true,
      ),
    ).toBe(false);
  });

  it("removes an agent-backed session when its tab auto-close flag is enabled", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          status_reason: "turn_complete",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).toHaveBeenCalledWith("session-1", false);
    dispose();
  });

  it("removes a session when turn-complete reason arrives after needs_input", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      sessions: [session({ status: "needs_input", agent_provider: "codex" })],
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          status_reason: "turn_complete",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).toHaveBeenCalledWith("session-1", false);
    dispose();
  });

  it("does not remove active needs_input without turn-complete reason", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).not.toHaveBeenCalled();
    dispose();
  });

  it("removes an agent-backed session when it returns to idle after running", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "idle",
          agent_provider: null,
          agent_transcript_id: null,
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).toHaveBeenCalledWith("session-1", false);
    dispose();
  });

  it("removes an agent-backed session when it exits to idle from needs_input", async () => {
    // A hooked Claude/Codex session settles at needs_input between turns; when
    // the agent process exits the poll reports idle. That exit should close the
    // session, matching the running→idle path.
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "idle",
          agent_provider: null,
          agent_transcript_id: null,
          updated_at: "2026-01-01T00:02:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).toHaveBeenCalledWith("session-1", false);
    dispose();
  });

  it("does not remove a historical agent session for a later shell transition", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      sessions: [
        session({
          agent_provider: null,
          agent_transcript_id: "codex-old",
        }),
      ],
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          agent_provider: null,
          agent_transcript_id: "codex-old",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).not.toHaveBeenCalled();
    dispose();
  });

  it("does not remove a session whose status reverts to running before the queued close runs", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          status_reason: "turn_complete",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    // A new turn starts synchronously in the same tick, before the queued
    // microtask drains.
    useAppStore.setState({
      sessions: [
        session({
          status: "running",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:01Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).not.toHaveBeenCalled();
    dispose();
  });

  it("still closes after an aborted close once the next turn finishes", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          status_reason: "turn_complete",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    useAppStore.setState({
      sessions: [
        session({
          status: "running",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:01:01Z",
        }),
      ],
    });
    await flushPromises();
    expect(removeSession).not.toHaveBeenCalled();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          status_reason: "turn_complete",
          agent_provider: "codex",
          updated_at: "2026-01-01T00:02:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(removeSession).toHaveBeenCalledWith("session-1", false);
    dispose();
  });

  it("does not remove stale finished sessions on watcher startup", async () => {
    const removeSession = vi.fn(async () => null);
    useAppStore.setState({
      sessions: [
        session({ status: "needs_input", status_reason: "turn_complete" }),
      ],
      autoCloseSessionIds: { "session-1": true },
      removeSession,
    });
    const dispose = startSessionAutoCloseWatcher();
    await flushPromises();

    expect(removeSession).not.toHaveBeenCalled();
    dispose();
  });
});
