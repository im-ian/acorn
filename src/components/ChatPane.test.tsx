import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSessionState } from "../lib/types";

const mocks = vi.hoisted(() => ({
  loadChatSessionState: vi.fn(),
  sendChatMessage: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  updateSessionWorktree: vi.fn(),
  prepareChatSessionWorktree: vi.fn(),
  saveChatSessionState: vi.fn(),
  listSessions: vi.fn(),
  listProjects: vi.fn(),
  ptyInWorktreeAll: vi.fn(),
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

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  CHAT_SESSION_STATE_CHANGED_EVENT: "acorn:chat-session-state-changed",
  api: {
    loadChatSessionState: mocks.loadChatSessionState,
    sendChatMessage: mocks.sendChatMessage,
    createSession: mocks.createSession,
    renameSession: mocks.renameSession,
    updateSessionWorktree: mocks.updateSessionWorktree,
    prepareChatSessionWorktree: mocks.prepareChatSessionWorktree,
    saveChatSessionState: mocks.saveChatSessionState,
    listSessions: mocks.listSessions,
    listProjects: mocks.listProjects,
    ptyInWorktreeAll: mocks.ptyInWorktreeAll,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.open,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { ChatPane } from "./ChatPane";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import { useAppStore } from "../store";
import type { Session } from "../lib/types";

function chatState(
  sessionId: string,
  messages: ChatMessage[] = [],
  provider: string | null = null,
): ChatSessionState {
  const now = "2026-01-01T00:00:00Z";
  return {
    schema_version: 1,
    session_id: sessionId,
    session: {
      id: sessionId,
      workspace_path: null,
      title: null,
      active_provider: provider,
      active_model: null,
      created_at: now,
      updated_at: now,
    },
    provider,
    model: null,
    messages,
    turns: [],
    provider_threads: [],
    context_snapshots: [],
    memory: {
      session_id: sessionId,
      summary: null,
      important_decisions: [],
      facts: [],
      through_message_id: null,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function nextAnimationFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

function mockScrollRegion(
  element: HTMLElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop,
  }: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  let currentScrollTop = scrollTop;
  const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    currentScrollTop =
      typeof options === "number"
        ? options
        : Number(options?.top ?? currentScrollTop);
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => currentScrollTop,
    set: (next) => {
      currentScrollTop = Number(next);
    },
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return {
    get scrollTop() {
      return currentScrollTop;
    },
    scrollTo,
  };
}

function changeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function emitChatState(state: ChatSessionState) {
  for (const listener of eventMocks.listeners.get(
    "acorn:chat-session-state-changed",
  ) ?? []) {
    listener({ payload: { session_id: state.session_id, state } });
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "Chat",
    repo_path: "/tmp/acorn",
    worktree_path: "/tmp/acorn",
    branch: "main",
    isolated: false,
    project_scoped: true,
    status: "idle",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    generated_title_transcript_id: null,
    kind: "regular",
    mode: "chat",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    agent_provider: null,
    agent_transcript_id: null,
    ...overrides,
  };
}

describe("ChatPane", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    eventMocks.listeners.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    useAppStore.setState({ sessions: [] });
    mocks.listSessions.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue([]);
    mocks.ptyInWorktreeAll.mockResolvedValue({});
    mocks.renameSession.mockImplementation(async (_id, name) =>
      session({ name }),
    );
    mocks.updateSessionWorktree.mockImplementation(async (id, worktreePath) =>
      session({ id, worktree_path: worktreePath, isolated: true }),
    );
    mocks.prepareChatSessionWorktree.mockResolvedValue(
      session({
        id: "s1",
        worktree_path: "/tmp/acorn/.acorn/worktrees/chat",
        isolated: true,
        in_worktree: true,
      }),
    );
    dialogMocks.open.mockResolvedValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
  });

  it("sends messages to the selected Claude or Codex provider", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));
    mocks.sendChatMessage.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "hello",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "hi from codex",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
        ],
        "codex",
      ),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat provider"]',
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    );
    const actions = container.querySelector<HTMLElement>(
      "[data-chat-composer-actions]",
    );
    const form = container.querySelector("form");

    expect(select).toBeTruthy();
    expect(textarea).toBeTruthy();
    expect(sendButton).toBeTruthy();
    expect(actions).toBeTruthy();
    expect(actions!.contains(select)).toBe(true);
    expect(actions!.contains(sendButton)).toBe(true);
    expect(form).toBeTruthy();

    await act(async () => {
      select!.value = "codex";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      changeTextareaValue(textarea!, "hello");
    });
    await settle();

    await act(async () => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ provider: "codex" }),
      "hello",
    );
    expect(container.textContent).toContain("hi from codex");
  });

  it("can prepare a new worktree before the first chat message", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));
    mocks.sendChatMessage.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "start isolated",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "ready",
            created_at: "2026-01-01T00:00:01Z",
            status: "complete",
            metadata: { provider: "claude" },
          },
        ],
        "claude",
      ),
    );

    await act(async () => {
      root.render(
        <ChatPane
          sessionId="s1"
          repoPath="/tmp/acorn"
          session={session()}
        />,
      );
    });
    await settle();

    const worktreeSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat worktree mode"]',
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const form = container.querySelector("form");
    expect(worktreeSelect).toBeTruthy();
    expect(textarea).toBeTruthy();
    expect(form).toBeTruthy();

    await act(async () => {
      worktreeSelect!.value = "new";
      worktreeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      changeTextareaValue(textarea!, "start isolated");
    });
    await settle();

    await act(async () => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(mocks.prepareChatSessionWorktree).toHaveBeenCalledWith("s1");
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ provider: "claude" }),
      "start isolated",
    );
    expect(
      mocks.prepareChatSessionWorktree.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.sendChatMessage.mock.invocationCallOrder[0]);
  });

  it("submits on Enter and leaves Shift Enter for multiline input", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));
    mocks.sendChatMessage.mockResolvedValue(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "hello",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "response",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
        ],
        "claude",
      ),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    expect(textarea).toBeTruthy();

    await act(async () => {
      changeTextareaValue(textarea!, "hello");
    });
    await settle();

    await act(async () => {
      textarea!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => {
      textarea!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ provider: "claude" }),
      "hello",
    );
  });

  it("adds picked file attachments to outgoing chat messages", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));
    mocks.sendChatMessage.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content:
              "Attached files:\n- @docs/spec.md\n- @assets/mock.png\n\nreview these",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "reviewed",
            created_at: "2026-01-01T00:00:01Z",
            status: "complete",
            metadata: null,
          },
        ],
        "claude",
      ),
    );
    dialogMocks.open.mockResolvedValueOnce([
      "/tmp/acorn/docs/spec.md",
      "/tmp/acorn/assets/mock.png",
    ]);

    await act(async () => {
      root.render(<ChatPane sessionId="s1" repoPath="/tmp/acorn" />);
    });
    await settle();

    const attach = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Attach file"]',
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const form = container.querySelector("form");
    expect(attach).toBeTruthy();
    expect(textarea).toBeTruthy();
    expect(form).toBeTruthy();

    await act(async () => {
      attach!.click();
      await Promise.resolve();
    });
    await settle();

    expect(dialogMocks.open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
    });
    expect(container.textContent).toContain("spec.md");
    expect(container.textContent).toContain("mock.png");

    await act(async () => {
      changeTextareaValue(textarea!, "review these");
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ provider: "claude" }),
      "Attached files:\n- @docs/spec.md\n- @assets/mock.png\n\nreview these",
    );
    expect(
      container.querySelector('button[aria-label="Remove attachment spec.md"]'),
    ).toBeNull();
  });

  it("reflects chat send progress in the owning session status", async () => {
    let resolveSend!: (state: ChatSessionState) => void;
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));
    mocks.sendChatMessage.mockReturnValueOnce(
      new Promise<ChatSessionState>((resolve) => {
        resolveSend = resolve;
      }),
    );
    useAppStore.setState({ sessions: [session()] });

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const form = container.querySelector("form");
    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-chat-scroll-region]",
    );
    expect(textarea).toBeTruthy();
    expect(form).toBeTruthy();
    expect(scrollRegion).toBeTruthy();
    const scroll = mockScrollRegion(scrollRegion!, {
      clientHeight: 100,
      scrollHeight: 420,
      scrollTop: 0,
    });

    await act(async () => {
      changeTextareaValue(textarea!, "hello");
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    await nextAnimationFrame();

    expect(textarea!.value).toBe("");
    expect(scroll.scrollTop).toBe(320);
    expect(useAppStore.getState().sessions[0]?.status).toBe("running");

    await act(async () => {
      resolveSend(
        chatState(
          "s1",
          [
            {
              id: "u1",
              role: "user",
              content: "hello",
              created_at: "2026-01-01T00:00:00Z",
              status: "complete",
              metadata: null,
            },
            {
              id: "a1",
              role: "assistant",
              content: "done",
              created_at: "2026-01-01T00:00:01Z",
              status: "complete",
              metadata: null,
            },
          ],
          "claude",
        ),
      );
      await Promise.resolve();
    });
    await settle();

    expect(useAppStore.getState().sessions[0]?.status).toBe("needs_input");
  });

  it("shows a scroll-to-bottom button when the chat is scrolled up", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "older question",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "older answer",
          created_at: "2026-01-01T00:00:01Z",
          status: "complete",
          metadata: null,
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-chat-scroll-region]",
    );
    expect(scrollRegion).toBeTruthy();
    const scroll = mockScrollRegion(scrollRegion!, {
      clientHeight: 100,
      scrollHeight: 420,
      scrollTop: 0,
    });

    await act(async () => {
      scrollRegion!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Scroll chat to bottom"]',
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.click();
    });

    expect(scroll.scrollTop).toBe(320);
  });

  it("focuses the message input when Enter is pressed in the active chat pane", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));

    await act(async () => {
      root.render(<ChatPane sessionId="s1" isActive />);
    });
    await settle();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const provider = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat provider"]',
    );
    expect(textarea).toBeTruthy();
    expect(provider).toBeTruthy();
    expect(document.activeElement).not.toBe(textarea);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(document.activeElement).toBe(textarea);

    textarea!.blur();
    provider!.focus();
    await act(async () => {
      provider!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(document.activeElement).toBe(provider);
  });

  it("does not focus the message input when the chat pane is inactive", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));

    await act(async () => {
      root.render(<ChatPane sessionId="s1" isActive={false} />);
    });
    await settle();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    expect(textarea).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(document.activeElement).not.toBe(textarea);
  });

  it("refreshes when the backend emits a chat state update", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "hello",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          created_at: "2026-01-01T00:00:00Z",
          status: "pending",
          metadata: null,
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    expect(container.textContent).toContain("Running Claude");

    await act(async () => {
      emitChatState(
        chatState("s1", [
          {
            id: "u1",
            role: "user",
            content: "hello",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "response after tab switch",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
        ]),
      );
    });

    expect(container.textContent).toContain("response after tab switch");
  });

  it("ignores stale pending chat state updates after a completed response", async () => {
    const completed = chatState(
      "s1",
      [
        {
          id: "u1",
          role: "user",
          content: "hello",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "complete response",
          created_at: "2026-01-01T00:00:02Z",
          status: "complete",
          metadata: { provider: "claude" },
        },
      ],
      "claude",
    );
    completed.updated_at = "2026-01-01T00:00:02Z";
    completed.session.updated_at = completed.updated_at;
    const stalePending = chatState(
      "s1",
      [
        {
          id: "u1",
          role: "user",
          content: "hello",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          created_at: "2026-01-01T00:00:00Z",
          status: "pending",
          metadata: { provider: "claude" },
        },
      ],
      "claude",
    );
    stalePending.updated_at = "2026-01-01T00:00:01Z";
    stalePending.session.updated_at = stalePending.updated_at;
    mocks.loadChatSessionState.mockResolvedValueOnce(completed);

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    expect(container.textContent).toContain("complete response");

    await act(async () => {
      emitChatState(stalePending);
    });

    expect(container.textContent).toContain("complete response");
    expect(container.textContent).not.toContain("Running Claude");
  });

  it("shows elapsed response time while an assistant message is running", async () => {
    const startedAt = new Date(Date.now() - 125_000).toISOString();
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "long running question",
          created_at: startedAt,
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          created_at: startedAt,
          status: "pending",
          metadata: { provider: "claude" },
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    expect(container.textContent).toContain("Running Claude");
    const runningDuration = container.querySelector(
      "[data-chat-running-duration]",
    );
    expect(runningDuration?.textContent).toBe("2m 5s");
  });

  it("updates elapsed response time while an assistant message is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "long running question",
          created_at: "2026-01-01T00:00:00.000Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          created_at: "2026-01-01T00:00:00.000Z",
          status: "pending",
          metadata: { provider: "claude" },
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
      await Promise.resolve();
    });

    const runningDuration = container.querySelector(
      "[data-chat-running-duration]",
    );
    expect(runningDuration?.textContent).toBe("<1s");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(runningDuration?.textContent).toBe("1.0s");
  });

  it("centers the composer until the first message appears", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const form = container.querySelector("form");
    expect(form?.getAttribute("data-chat-composer")).toBe("centered");

    await act(async () => {
      emitChatState(
        chatState("s1", [
          {
            id: "u1",
            role: "user",
            content: "hello",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
        ]),
      );
    });

    expect(form?.getAttribute("data-chat-composer")).toBe("bottom");
  });

  it("copies user and assistant message contents", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "copy my message",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "copy agent message",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const copyUser = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy user message"]',
    );
    const copyAssistant = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy Assistant message"]',
    );
    expect(copyUser).toBeTruthy();
    expect(copyAssistant).toBeTruthy();

    await act(async () => {
      copyUser!.click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "copy my message",
    );

    await act(async () => {
      copyAssistant!.click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "copy agent message",
    );
  });

  it("does not show fork actions on user messages", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "first user message",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "assistant answer",
          created_at: "2026-01-01T00:00:01Z",
          status: "complete",
          metadata: { provider: "claude" },
        },
        {
          id: "u2",
          role: "user",
          content: "second user message",
          created_at: "2026-01-01T00:00:02Z",
          status: "complete",
          metadata: null,
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" repoPath="/tmp/acorn" />);
    });
    await settle();

    expect(
      container.querySelector('button[aria-label="Fork before user message"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Fork before Claude message"]'),
    ).toBeTruthy();
  });

  it("forks a new chat session with the source chat title and disables auto rename", async () => {
    const before = session({
      id: "before",
      name: "Before",
    });
    const current = session({
      id: "s1",
      name: "Exploring chat runtime",
    });
    const after = session({
      id: "after",
      name: "After",
    });
    const created = session({
      id: "fork1",
      name: "Exploring chat runtime",
    });
    const renamed = session({
      id: "fork1",
      name: "Exploring chat runtime",
      title_source: "manual",
    });
    const rootPane = {
      id: "root",
      tabIds: ["before", "s1", "after"],
      activeTabId: "s1",
      activationHistory: ["before", "after", "s1"],
    };
    useAppStore.setState({
      sessions: [before, current, after],
      projects: [
        {
          repo_path: "/tmp/acorn",
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ],
      activeProject: "/tmp/acorn",
      activeSessionId: "s1",
      activeTabId: "s1",
      workspaces: {
        "/tmp/acorn": {
          layout: { kind: "pane", id: "root" },
          panes: { root: rootPane },
          focusedPaneId: "root",
        },
      },
      layout: { kind: "pane", id: "root" },
      panes: { root: rootPane },
      focusedPaneId: "root",
    });
    const sourceState = chatState(
      "s1",
      [
        {
          id: "u1",
          role: "user",
          content: "original prompt",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "answer to branch away from",
          created_at: "2026-01-01T00:00:01Z",
          status: "complete",
          metadata: { provider: "claude" },
        },
      ],
      "claude",
    );
    sourceState.session.title = "Exploring chat runtime";
    mocks.loadChatSessionState.mockResolvedValueOnce(sourceState);
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.renameSession.mockResolvedValueOnce(renamed);
    mocks.saveChatSessionState.mockImplementationOnce(async (state) => state);
    mocks.listSessions
      .mockResolvedValueOnce([before, current, after, created])
      .mockResolvedValueOnce([before, current, after, renamed]);
    mocks.listProjects.mockResolvedValue([
      {
        repo_path: "/tmp/acorn",
        name: "acorn",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);

    await act(async () => {
      root.render(<ChatPane sessionId="s1" repoPath="/tmp/acorn" />);
    });
    await settle();

    const fork = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork before Claude message"]',
    );
    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy Claude message"]',
    );
    expect(fork).toBeTruthy();
    expect(copy).toBeTruthy();
    expect(
      copy!.compareDocumentPosition(fork!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await act(async () => {
      fork!.click();
      await Promise.resolve();
    });
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    const sameDirectory = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork in same directory"]',
    );
    expect(sameDirectory).toBeTruthy();

    await act(async () => {
      sameDirectory!.click();
      await Promise.resolve();
    });
    await settle();

    expect(mocks.createSession).toHaveBeenCalledWith(
      "Exploring chat runtime",
      "/tmp/acorn",
      false,
      "regular",
      "claude",
      true,
      "chat",
    );
    expect(mocks.renameSession).toHaveBeenCalledWith(
      "fork1",
      "Exploring chat runtime",
    );
    const saved = mocks.saveChatSessionState.mock.calls[0]?.[0] as
      | ChatSessionState
      | undefined;
    expect(saved?.session_id).toBe("fork1");
    expect(saved?.session.title).toBe("Exploring chat runtime");
    expect(saved?.provider).toBe("claude");
    expect(saved?.messages).toHaveLength(1);
    expect(saved?.messages[0]?.content).toBe("original prompt");
    expect(saved?.messages[0]?.session_id).toBe("fork1");
    expect(saved?.messages[0]?.turn_id).toBeNull();
    expect(saved?.turns).toHaveLength(0);
    expect(saved?.provider_threads).toHaveLength(0);
    expect(saved?.context_snapshots).toHaveLength(0);
    expect(useAppStore.getState().activeSessionId).toBe("fork1");
    expect(useAppStore.getState().panes.root.tabIds).toEqual([
      "before",
      "s1",
      "fork1",
      "after",
    ]);
  });

  it("lets a chat fork start in a new worktree", async () => {
    const created = session({
      id: "fork-new",
      name: "Branch me",
      isolated: true,
      worktree_path: "/tmp/acorn/.acorn/worktrees/branch-me",
      in_worktree: true,
    });
    const renamed = session({
      id: "fork-new",
      name: "Branch me",
      isolated: true,
      worktree_path: "/tmp/acorn/.acorn/worktrees/branch-me",
      title_source: "manual",
      in_worktree: true,
    });
    const sourceState = chatState(
      "s1",
      [
        {
          id: "u1",
          role: "user",
          content: "original prompt",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "answer",
          created_at: "2026-01-01T00:00:01Z",
          status: "complete",
          metadata: { provider: "claude" },
        },
      ],
      "claude",
    );
    sourceState.session.title = "Branch me";
    mocks.loadChatSessionState.mockResolvedValueOnce(sourceState);
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.renameSession.mockResolvedValueOnce(renamed);
    mocks.saveChatSessionState.mockImplementationOnce(async (state) => state);
    mocks.listSessions.mockResolvedValue([created, renamed]);

    await act(async () => {
      root.render(
        <ChatPane
          sessionId="s1"
          repoPath="/tmp/acorn"
          session={session()}
        />,
      );
    });
    await settle();

    const fork = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork before Claude message"]',
    );
    expect(fork).toBeTruthy();

    await act(async () => {
      fork!.click();
      await Promise.resolve();
    });
    await settle();

    const newWorktree = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork in new worktree"]',
    );
    expect(newWorktree).toBeTruthy();

    await act(async () => {
      newWorktree!.click();
      await Promise.resolve();
    });
    await settle();

    expect(mocks.createSession).toHaveBeenCalledWith(
      "Branch me",
      "/tmp/acorn",
      true,
      "regular",
      "claude",
      true,
      "chat",
    );
    expect(mocks.updateSessionWorktree).not.toHaveBeenCalled();
    const saved = mocks.saveChatSessionState.mock.calls[0]?.[0] as
      | ChatSessionState
      | undefined;
    expect(saved?.session_id).toBe("fork-new");
    expect(saved?.messages).toHaveLength(1);
  });

  it("keeps a chat fork in the source worktree when same directory is chosen", async () => {
    const sourceSession = session({
      id: "s1",
      name: "Worktree chat",
      worktree_path: "/tmp/acorn/.acorn/worktrees/source-chat",
      isolated: true,
      in_worktree: true,
    });
    const created = session({
      id: "fork-same",
      name: "Worktree chat",
    });
    const adopted = session({
      id: "fork-same",
      name: "Worktree chat",
      worktree_path: "/tmp/acorn/.acorn/worktrees/source-chat",
      isolated: true,
      in_worktree: true,
    });
    const renamed = session({
      ...adopted,
      title_source: "manual",
    });
    const sourceState = chatState(
      "s1",
      [
        {
          id: "u1",
          role: "user",
          content: "original prompt",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
        {
          id: "a1",
          role: "assistant",
          content: "answer",
          created_at: "2026-01-01T00:00:01Z",
          status: "complete",
          metadata: { provider: "claude" },
        },
      ],
      "claude",
    );
    sourceState.session.title = "Worktree chat";
    mocks.loadChatSessionState.mockResolvedValueOnce(sourceState);
    mocks.createSession.mockResolvedValueOnce(created);
    mocks.updateSessionWorktree.mockResolvedValueOnce(adopted);
    mocks.renameSession.mockResolvedValueOnce(renamed);
    mocks.saveChatSessionState.mockImplementationOnce(async (state) => state);
    mocks.listSessions.mockResolvedValue([created, adopted, renamed]);

    await act(async () => {
      root.render(
        <ChatPane
          sessionId="s1"
          repoPath="/tmp/acorn/.acorn/worktrees/source-chat"
          session={sourceSession}
        />,
      );
    });
    await settle();

    const fork = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork before Claude message"]',
    );
    expect(fork).toBeTruthy();

    await act(async () => {
      fork!.click();
      await Promise.resolve();
    });
    await settle();

    const sameDirectory = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork in same directory"]',
    );
    expect(sameDirectory).toBeTruthy();
    const currentDirectory = document.querySelector<HTMLElement>(
      "[data-chat-fork-current-directory]",
    );
    expect(currentDirectory?.getAttribute("aria-label")).toBe(
      "/tmp/acorn/.acorn/worktrees/source-chat",
    );
    expect(currentDirectory?.className).toContain("truncate");

    await act(async () => {
      sameDirectory!.click();
      await Promise.resolve();
    });
    await settle();

    expect(mocks.createSession).toHaveBeenCalledWith(
      "Worktree chat",
      "/tmp/acorn",
      false,
      "regular",
      "claude",
      true,
      "chat",
    );
    expect(mocks.updateSessionWorktree).toHaveBeenCalledWith(
      "fork-same",
      "/tmp/acorn/.acorn/worktrees/source-chat",
    );
    const saved = mocks.saveChatSessionState.mock.calls[0]?.[0] as
      | ChatSessionState
      | undefined;
    expect(saved?.session_id).toBe("fork-same");
    expect(saved?.session.workspace_path).toBe(
      "/tmp/acorn/.acorn/worktrees/source-chat",
    );
  });

  it("hides the user label and shows the responding agent with duration", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "question",
            created_at: "2026-01-01T00:00:00.000Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "answer",
            created_at: "2026-01-01T00:00:02.500Z",
            status: "complete",
            metadata: { provider: "antigravity" },
          },
        ],
        "claude",
      ),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    expect(container.textContent).not.toContain("You");
    expect(container.textContent).toContain("Antigravity");
    expect(container.textContent).toContain("2.5s");
    const timestamps = Array.from(
      container.querySelectorAll("time[data-chat-message-timestamp]"),
    );
    expect(timestamps).toHaveLength(2);
    expect(timestamps[0]?.getAttribute("dateTime")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(timestamps[0]?.getAttribute("title")).toBeNull();
    expect(timestamps[1]?.getAttribute("dateTime")).toBe(
      "2026-01-01T00:00:02.500Z",
    );
    expect(timestamps[1]?.getAttribute("title")).toBeNull();
    expect(
      container.querySelectorAll("[data-chat-timestamp-separator]"),
    ).toHaveLength(2);
    const duration = container.querySelector("[data-chat-response-duration]");
    expect(duration).toBeTruthy();
    expect(
      timestamps[1]!.compareDocumentPosition(duration!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container.querySelector("[data-chat-duration-separator]"),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-chat-message-header] [role="img"][aria-label="Antigravity"]',
      ),
    ).toBeTruthy();
  });

  it("keeps existing agent labels stable when the selected provider changes", async () => {
    const oldCodexMessage: ChatMessage = {
      id: "a1",
      role: "assistant",
      content: "codex answer",
      created_at: "2026-01-01T00:00:01Z",
      status: "complete",
      metadata: { provider: "codex" },
    };
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "first",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          oldCodexMessage,
        ],
        "codex",
      ),
    );
    mocks.sendChatMessage.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "first",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          oldCodexMessage,
          {
            id: "u2",
            role: "user",
            content: "second",
            created_at: "2026-01-01T00:00:02Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a2",
            role: "assistant",
            content: "claude answer",
            created_at: "2026-01-01T00:00:03Z",
            status: "complete",
            metadata: { provider: "claude" },
          },
        ],
        "claude",
      ),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    expect(
      Array.from(container.querySelectorAll("[data-chat-message-header]")).map(
        (header) => header.textContent,
      ),
    ).toEqual(["Codex"]);

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat provider"]',
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const form = container.querySelector("form");

    await act(async () => {
      select!.value = "claude";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      changeTextareaValue(textarea!, "second");
    });
    await settle();

    await act(async () => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(
      Array.from(container.querySelectorAll("[data-chat-message-header]")).map(
        (header) => header.textContent,
      ),
    ).toEqual(["Codex", "Claude"]);
  });

  it("can send a chat message through Antigravity", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(chatState("s1"));
    mocks.sendChatMessage.mockResolvedValueOnce(
      chatState(
        "s1",
        [
          {
            id: "u1",
            role: "user",
            content: "hello agy",
            created_at: "2026-01-01T00:00:00Z",
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            role: "assistant",
            content: "hi from antigravity",
            created_at: "2026-01-01T00:00:01Z",
            status: "complete",
            metadata: { provider: "antigravity" },
          },
        ],
        "antigravity",
      ),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat provider"]',
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat message"]',
    );
    const form = container.querySelector("form");
    expect(select?.textContent).toContain("Antigravity");

    await act(async () => {
      select!.value = "antigravity";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      changeTextareaValue(textarea!, "hello agy");
    });
    await settle();

    await act(async () => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ provider: "antigravity" }),
      "hello agy",
    );
    expect(container.textContent).toContain("hi from antigravity");
  });

  it("marks rendered message text as selectable", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "drag-select this message",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    const selectable = container.querySelector(".acorn-selectable");
    expect(selectable?.textContent).toContain("drag-select this message");
  });

  it("applies the message entrance animation class", async () => {
    mocks.loadChatSessionState.mockResolvedValueOnce(
      chatState("s1", [
        {
          id: "u1",
          role: "user",
          content: "animated message",
          created_at: "2026-01-01T00:00:00Z",
          status: "complete",
          metadata: null,
        },
      ]),
    );

    await act(async () => {
      root.render(<ChatPane sessionId="s1" />);
    });
    await settle();

    expect(container.querySelector(".acorn-chat-message-enter")).toBeTruthy();
  });
});
