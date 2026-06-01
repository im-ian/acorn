import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSessionState } from "../lib/types";

const mocks = vi.hoisted(() => ({
  loadChatSessionState: vi.fn(),
  sendChatMessage: vi.fn(),
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
  api: {
    loadChatSessionState: mocks.loadChatSessionState,
    sendChatMessage: mocks.sendChatMessage,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
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
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
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
    const form = container.querySelector("form");

    expect(select).toBeTruthy();
    expect(textarea).toBeTruthy();
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
