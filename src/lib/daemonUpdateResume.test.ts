import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDaemonUpdateResumePass,
  collectDaemonUpdateResumeEntries,
  stashDaemonUpdateResumePass,
} from "./daemonUpdateResume";
import type { Session } from "./types";
import { useAppStore } from "../store";

const STORAGE_KEY = "acorn:daemon-update-resume";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: "session",
    repo_path: "/repo",
    worktree_path: "/repo",
    branch: "main",
    isolated: false,
    status: "working",
    created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z",
    last_message: null,
    title_source: "generated",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  } as Session;
}

const GROK_SESSION = makeSession({
  id: "b94a531c-455a-4912-8f6d-eb3a09267446",
  agent_provider: "grok",
  agent_transcript_provider: "grok",
  agent_transcript_id: "01a11a58-1780-78b3-91e9-1f6198c9d200",
});

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
  useAppStore.setState({ pendingTerminalInput: {} });
});

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
  useAppStore.setState({ pendingTerminalInput: {} });
});

describe("collectDaemonUpdateResumeEntries", () => {
  it("collects sessions with a resumable agent transcript", () => {
    expect(collectDaemonUpdateResumeEntries([GROK_SESSION])).toEqual([
      {
        sessionId: GROK_SESSION.id,
        agent: "grok",
        uuid: "01a11a58-1780-78b3-91e9-1f6198c9d200",
      },
    ]);
  });

  it("skips archived, chat-mode, and transcript-less sessions", () => {
    const sessions = [
      makeSession({
        ...GROK_SESSION,
        id: "archived",
        archived_at: "2026-10-08T00:00:00Z",
      }),
      makeSession({ ...GROK_SESSION, id: "chat", mode: "chat" }),
      makeSession({ id: "plain-shell" }),
      makeSession({
        id: "no-uuid",
        agent_provider: "grok",
        agent_transcript_id: null,
      }),
    ];
    expect(collectDaemonUpdateResumeEntries(sessions)).toEqual([]);
  });

  it("prefers the transcript provider over the live provider", () => {
    const entries = collectDaemonUpdateResumeEntries([
      makeSession({
        id: "mixed",
        agent_provider: "grok",
        agent_transcript_provider: "claude",
        agent_transcript_id: "uuid-1",
      }),
    ]);
    expect(entries).toEqual([
      { sessionId: "mixed", agent: "claude", uuid: "uuid-1" },
    ]);
  });
});

describe("stash + apply roundtrip", () => {
  it("queues the resume command once per stashed session", () => {
    expect(stashDaemonUpdateResumePass([GROK_SESSION])).toBe(1);

    expect(applyDaemonUpdateResumePass([GROK_SESSION])).toBe(1);
    expect(
      useAppStore.getState().pendingTerminalInput[GROK_SESSION.id],
    ).toMatchObject({
      command: "grok --resume 01a11a58-1780-78b3-91e9-1f6198c9d200",
      agentProvider: "grok",
    });

    // The stash is consumed — a second boot must not re-queue.
    useAppStore.setState({ pendingTerminalInput: {} });
    expect(applyDaemonUpdateResumePass([GROK_SESSION])).toBe(0);
    expect(useAppStore.getState().pendingTerminalInput).toEqual({});
  });

  it("skips stashed sessions that no longer exist", () => {
    stashDaemonUpdateResumePass([GROK_SESSION]);
    expect(applyDaemonUpdateResumePass([])).toBe(0);
    expect(useAppStore.getState().pendingTerminalInput).toEqual({});
  });

  it("survives a corrupt stash", () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");
    expect(applyDaemonUpdateResumePass([GROK_SESSION])).toBe(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
