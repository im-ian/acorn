import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionState, Session } from "../lib/types";
import { makeWorkSummaryWorkspaceTab } from "../lib/workspaceTabs";

const mocks = vi.hoisted(() => ({
  fsGitStatus: vi.fn(),
  fsGitDiffStats: vi.fn(),
  loadChatSessionState: vi.fn(),
  agentTranscriptSummary: vi.fn(),
  agentTranscriptSummaryAtPath: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  listen: vi.fn(
    (
      event: string,
      handler: (event: { payload: unknown }) => void,
    ): Promise<() => void> => {
      const listeners = eventMocks.listeners.get(event) ?? new Set();
      listeners.add(handler);
      eventMocks.listeners.set(event, listeners);
      return Promise.resolve(() => listeners.delete(handler));
    },
  ),
}));

vi.mock("../lib/api", () => ({
  CHAT_SESSION_STATE_CHANGED_EVENT: "acorn:chat-session-state-changed",
  FS_CHANGED_EVENT: "acorn:fs-changed",
  api: {
    fsGitStatus: mocks.fsGitStatus,
    fsGitDiffStats: mocks.fsGitDiffStats,
    loadChatSessionState: mocks.loadChatSessionState,
    agentTranscriptSummary: mocks.agentTranscriptSummary,
    agentTranscriptSummaryAtPath: mocks.agentTranscriptSummaryAtPath,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

import { WorkSummaryView } from "./WorkSummaryView";

const REPO = "/Users/me/repo";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "Feature runner",
    repo_path: REPO,
    worktree_path: `${REPO}/.worktrees/s1`,
    branch: "feat/summary",
    isolated: false,
    status: "idle",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: "done",
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: true,
    ...overrides,
  };
}

function chatState(): ChatSessionState {
  return {
    schema_version: 1,
    session_id: "s1",
    session: {
      id: "s1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    messages: [
      {
        id: "u1",
        role: "user",
        content: "Do it",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Done",
        created_at: "2026-01-01T00:00:01Z",
        metadata: {
          provider_response: {
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              total_tokens: 140,
            },
          },
        },
      },
    ],
    turns: [
      {
        id: "t1",
        session_id: "s1",
        provider: "codex",
        status: "complete",
        user_message_id: "u1",
        assistant_message_id: "a1",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:00:01Z",
      },
    ],
    provider_threads: [],
    context_snapshots: [],
    memory: {
      session_id: "s1",
      important_decisions: [],
      facts: [],
      updated_at: "2026-01-01T00:00:00Z",
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z",
  };
}

function chatStateWithTokenTotal(totalTokens: number): ChatSessionState {
  const state = chatState();
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: "u2",
        role: "user",
        content: "Again",
        created_at: "2026-01-01T00:00:02Z",
      },
      {
        id: "a2",
        role: "assistant",
        content: "Again done",
        created_at: "2026-01-01T00:00:03Z",
        metadata: {
          provider_response: {
            usage: {
              input_tokens: totalTokens - 80,
              output_tokens: 80,
              total_tokens: totalTokens,
            },
          },
        },
      },
    ],
    turns: [
      ...state.turns,
      {
        id: "t2",
        session_id: "s1",
        provider: "codex",
        status: "complete",
        user_message_id: "u2",
        assistant_message_id: "a2",
        started_at: "2026-01-01T00:00:02Z",
        completed_at: "2026-01-01T00:00:03Z",
      },
    ],
    updated_at: "2026-01-01T00:00:03Z",
  };
}

function emitEvent(event: string, payload: unknown) {
  const listeners = eventMocks.listeners.get(event);
  if (!listeners || listeners.size === 0) {
    throw new Error(`listener not registered: ${event}`);
  }
  for (const listener of listeners) {
    listener({ payload });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WorkSummaryView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    eventMocks.listeners.clear();
    eventMocks.listen.mockClear();
    mocks.fsGitStatus.mockResolvedValue({
      statuses: {
        [`${REPO}/src/App.tsx`]: {
          kind: "modified",
          additions: 0,
          deletions: 0,
        },
        [`${REPO}/README.md`]: {
          kind: "added",
          additions: 0,
          deletions: 0,
        },
      },
      huge: false,
      limit: 500,
    });
    mocks.fsGitDiffStats.mockResolvedValue({
      [`${REPO}/src/App.tsx`]: { additions: 12, deletions: 3 },
      [`${REPO}/README.md`]: { additions: 4, deletions: 0 },
    });
    mocks.loadChatSessionState.mockResolvedValue(chatState());
    mocks.agentTranscriptSummary.mockResolvedValue(null);
    mocks.agentTranscriptSummaryAtPath.mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows completed details while the first git summary snapshot is loading", async () => {
    const pendingStatus = deferred<Awaited<ReturnType<typeof mocks.fsGitStatus>>>();
    mocks.fsGitStatus.mockReturnValueOnce(pendingStatus.promise);
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({ mode: "chat" })}
          isActive
        />,
      );
    });

    expect(container.textContent).toContain("Feature runner");
    expect(
      container.querySelector('[data-work-summary-section-skeleton="files"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-work-summary-section-skeleton="charts"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-work-summary-skeleton="true"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("README.md");

    await act(async () => {
      pendingStatus.resolve({
        statuses: {},
        huge: false,
        limit: 500,
      });
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-work-summary-section-skeleton="files"]'),
    ).toBeNull();
  });

  it("renders completed git summary while conversation metrics are still loading", async () => {
    const pendingChat = deferred<ChatSessionState>();
    mocks.loadChatSessionState.mockReturnValueOnce(pendingChat.promise);
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({ mode: "chat" })}
          isActive
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2 files");
    expect(container.textContent).toContain("README.md");
    expect(
      container.querySelector(
        '[data-work-summary-section-skeleton="conversation"]',
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(container.textContent).not.toContain("2 messages");

    await act(async () => {
      pendingChat.resolve(chatState());
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2 messages");
  });

  it("renders git and chat summary metrics for a chat session", async () => {
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
      tokenBaseline: {
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 50,
        messagesWithUsage: 1,
        capturedAt: "2026-01-01T00:00:00Z",
      },
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({ mode: "chat" })}
          isActive
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.fsGitStatus).toHaveBeenCalledWith(`${REPO}/.worktrees/s1`, 500);
    expect(mocks.fsGitDiffStats).toHaveBeenCalledWith(
      `${REPO}/.worktrees/s1`,
      expect.arrayContaining([
        { path: `${REPO}/src/App.tsx`, kind: "modified" },
        { path: `${REPO}/README.md`, kind: "added" },
      ]),
    );
    expect(mocks.loadChatSessionState).toHaveBeenCalledWith("s1");
    expect(container.textContent).toContain("2 files");
    expect(container.textContent).toContain("+16");
    expect(container.textContent).toContain("-3");
    expect(container.textContent).toContain("2 messages");
    expect(container.textContent).toContain("140 tokens");
    expect(container.textContent).toContain("Summary start");
    expect(container.textContent).toContain("50");
    expect(container.textContent).toContain("Session used");
    expect(container.textContent).toContain("+90");
    expect(container.textContent).toContain("Input");
    expect(container.textContent).toContain("Output");
    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("src/App.tsx");
  });

  it("updates conversation and token metrics when the chat session changes", async () => {
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({ mode: "chat" })}
          isActive
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2 messages");
    expect(container.textContent).toContain("140 tokens");

    act(() => {
      emitEvent("acorn:chat-session-state-changed", {
        session_id: "s1",
        state: chatStateWithTokenTotal(260),
      });
    });

    expect(container.textContent).toContain("4 messages");
    expect(container.textContent).toContain("400 tokens");
  });

  it("renders conversation and token metrics from a terminal agent transcript", async () => {
    mocks.agentTranscriptSummary.mockResolvedValue({
      provider: "codex",
      id: "transcript-1",
      transcript_path: "/Users/me/.codex/sessions/transcript-1.jsonl",
      updated_at: 1_766_000_000,
      message_count: 4,
      user_messages: 2,
      assistant_messages: 2,
      turn_count: 2,
      complete_turns: 2,
      running_turns: 0,
      token_usage: {
        input_tokens: 220,
        output_tokens: 80,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
        reasoning_tokens: 12,
        total_tokens: 320,
        messages_with_usage: 1,
      },
    });
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({
            mode: "terminal",
            agent_transcript_id: "transcript-1",
          })}
          isActive
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.loadChatSessionState).not.toHaveBeenCalled();
    expect(mocks.agentTranscriptSummary).toHaveBeenCalledWith(
      REPO,
      "transcript-1",
    );
    expect(container.textContent).toContain("4 messages");
    expect(container.textContent).toContain("320 tokens");
  });

  it("polls a terminal agent transcript by cached path after the initial id lookup", async () => {
    vi.useFakeTimers();
    mocks.agentTranscriptSummary.mockResolvedValueOnce({
      provider: "codex",
      id: "transcript-1",
      transcript_path: "/Users/me/.codex/sessions/transcript-1.jsonl",
      updated_at: 1_766_000_000,
      message_count: 4,
      user_messages: 2,
      assistant_messages: 2,
      turn_count: 2,
      complete_turns: 2,
      running_turns: 0,
      token_usage: {
        input_tokens: 220,
        output_tokens: 80,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
        reasoning_tokens: 12,
        total_tokens: 320,
        messages_with_usage: 1,
      },
    });
    mocks.agentTranscriptSummaryAtPath.mockResolvedValueOnce({
      provider: "codex",
      id: "transcript-1",
      transcript_path: "/Users/me/.codex/sessions/transcript-1.jsonl",
      updated_at: 1_766_000_015,
      message_count: 6,
      user_messages: 3,
      assistant_messages: 3,
      turn_count: 3,
      complete_turns: 3,
      running_turns: 0,
      token_usage: {
        input_tokens: 300,
        output_tokens: 120,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
        reasoning_tokens: 12,
        total_tokens: 452,
        messages_with_usage: 2,
      },
    });
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({
            mode: "terminal",
            agent_transcript_id: "transcript-1",
          })}
          isActive
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.agentTranscriptSummary).toHaveBeenCalledTimes(1);
    expect(mocks.agentTranscriptSummaryAtPath).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.agentTranscriptSummaryAtPath).toHaveBeenCalledWith(
      REPO,
      "codex",
      "transcript-1",
      "/Users/me/.codex/sessions/transcript-1.jsonl",
    );
    expect(mocks.agentTranscriptSummary).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("6 messages");
    expect(container.textContent).toContain("452 tokens");
  });

  it("opens a changed file when its row is double-clicked", async () => {
    const onOpenFile = vi.fn();
    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: REPO,
      cwdPath: `${REPO}/.worktrees/s1`,
      sessionId: "s1",
      title: "Feature runner Summary",
    });

    await act(async () => {
      root.render(
        <WorkSummaryView
          tab={tab}
          session={session({ mode: "chat" })}
          isActive
          onOpenFile={onOpenFile}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const fileRow = container.querySelector(
      `[data-work-summary-file-path="${REPO}/README.md"]`,
    );
    expect(fileRow).toBeInstanceOf(HTMLElement);

    await act(async () => {
      fileRow!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });

    expect(onOpenFile).toHaveBeenCalledWith(`${REPO}/README.md`);
  });
});
