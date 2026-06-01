import { ArrowDownToLine, Check, Copy, LoaderCircle, Send } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  CHAT_SESSION_STATE_CHANGED_EVENT,
  type AiExecutionRequest,
  type ChatSessionState,
  type ChatSessionStateChangedPayload,
} from "../lib/api";
import {
  resolveAiExecutionRequest,
  useSettings,
  type AcornSettings,
} from "../lib/settings";
import { AgentProviderIcon } from "../lib/agentProvider";
import { useAppStore } from "../store";
import type { SessionAgentProvider, SessionStatus } from "../lib/types";
import { ChatMessageBody } from "./chat/ChatMessageBody";
import { Tooltip } from "./Tooltip";

interface ChatPaneProps {
  sessionId: string;
  isActive?: boolean;
  repoPath?: string;
}

type ChatProvider = SessionAgentProvider;
const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 48;

function providerFromString(
  value: string | null | undefined,
): ChatProvider | null {
  return value === "codex" || value === "claude" || value === "antigravity"
    ? value
    : null;
}

function defaultProvider(settings: AcornSettings): ChatProvider {
  if (settings.agents.selected === "antigravity") return "antigravity";
  return settings.agents.selected === "codex" ? "codex" : "claude";
}

function chatAiRequest(
  provider: ChatProvider,
  settings: AcornSettings,
): AiExecutionRequest {
  return {
    ...resolveAiExecutionRequest(settings),
    provider,
  };
}

function setLocalChatSessionStatus(
  sessionId: string,
  status: SessionStatus,
) {
  useAppStore.setState((state) => {
    let changed = false;
    const sessions = state.sessions.map((session) => {
      if (
        session.id !== sessionId ||
        session.mode !== "chat" ||
        session.status === status
      ) {
        return session;
      }
      changed = true;
      return { ...session, status };
    });
    return changed ? { sessions } : {};
  });
}

function sessionStatusFromChatState(state: ChatSessionState): SessionStatus {
  if (chatStateIsRunning(state)) return "running";
  const lastMessage = state.messages[state.messages.length - 1];
  const lastTurn = state.turns[state.turns.length - 1];
  if (lastMessage?.status === "error" || lastTurn?.status === "error") {
    return "failed";
  }
  return "needs_input";
}

function isChatScrolledBack(element: HTMLElement): boolean {
  const remaining =
    element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining > CHAT_SCROLL_BOTTOM_THRESHOLD_PX;
}

function scrollChatElementToBottom(
  element: HTMLElement,
  behavior: ScrollBehavior,
) {
  const top = Math.max(0, element.scrollHeight - element.clientHeight);
  try {
    element.scrollTo({ top, behavior });
  } catch {
    element.scrollTop = top;
  }
}

function emptyChatState(sessionId: string): ChatSessionState {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    session_id: sessionId,
    session: {
      id: sessionId,
      workspace_path: null,
      title: null,
      active_provider: null,
      active_model: null,
      created_at: now,
      updated_at: now,
    },
    provider: null,
    model: null,
    messages: [],
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

function chatStateIsRunning(state: ChatSessionState): boolean {
  return state.messages.some(
    (message) =>
      message.status === "pending" || message.status === "streaming",
  );
}

function providerLabel(provider: string | null | undefined): string {
  switch (provider) {
    case "antigravity":
      return "Antigravity";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "ollama":
      return "Ollama";
    case "llm":
      return "llm";
    case "custom":
      return "Custom";
    default:
      return "Assistant";
  }
}

function providerPlaceholder(provider: string | null | undefined): string {
  return `Ask ${providerLabel(provider)}`;
}

function providerFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const provider = (metadata as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.trim() ? provider : null;
}

function agentProviderFromMetadata(
  metadata: unknown,
): SessionAgentProvider | null {
  return providerFromString(providerFromMetadata(metadata));
}

function messageHeaderLabel(
  message: ChatSessionState["messages"][number],
  fallbackProvider: string | null | undefined,
): string | null {
  if (message.role === "user") return null;
  if (message.role === "assistant") {
    return providerLabel(providerFromMetadata(message.metadata) ?? fallbackProvider);
  }
  return message.role;
}

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='menuitem'], [role='option']",
    ),
  );
}

function formatResponseDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageTimestamp(value: string, nowMs = Date.now()): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - nowMs;
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absMs < 45_000) return rtf.format(0, "second");
  if (absMs < 60 * 60_000) {
    return rtf.format(Math.round(diffMs / 60_000), "minute");
  }
  if (absMs < 24 * 60 * 60_000) {
    return rtf.format(Math.round(diffMs / (60 * 60_000)), "hour");
  }
  if (absMs < 7 * 24 * 60 * 60_000) {
    return rtf.format(Math.round(diffMs / (24 * 60 * 60_000)), "day");
  }
  if (absMs < 30 * 24 * 60 * 60_000) {
    return rtf.format(Math.round(diffMs / (7 * 24 * 60 * 60_000)), "week");
  }
  if (absMs < 365 * 24 * 60 * 60_000) {
    return rtf.format(Math.round(diffMs / (30 * 24 * 60 * 60_000)), "month");
  }
  return rtf.format(Math.round(diffMs / (365 * 24 * 60 * 60_000)), "year");
}

function formatMessageTimestampTitle(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}

function responseDurationLabel(
  messages: ChatSessionState["messages"],
  index: number,
): string | null {
  const message = messages[index];
  if (!message || message.role !== "assistant") return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = messages[i];
    if (previous.role !== "user") continue;
    const started = Date.parse(previous.created_at);
    const completed = Date.parse(message.created_at);
    return formatResponseDuration(completed - started);
  }
  return null;
}

export function ChatPane({
  sessionId,
  isActive = true,
  repoPath,
}: ChatPaneProps) {
  const [state, setState] = useState<ChatSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const copyResetTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const forceScrollToBottomRef = useRef(false);
  const isScrolledBackRef = useRef(false);
  const [isScrolledBack, setIsScrolledBack] = useState(false);
  const settings = useSettings((s) => s.settings);
  const [provider, setProvider] = useState<ChatProvider>(() =>
    defaultProvider(useSettings.getState().settings),
  );
  const messages = state?.messages ?? [];
  const stateProvider = state?.provider ?? null;
  const hasMessages = messages.length > 0;
  const composerIsCentered = !loading && !error && !hasMessages;

  function syncScrollState() {
    const element = scrollRef.current;
    if (!element) return;
    const next = isChatScrolledBack(element);
    isScrolledBackRef.current = next;
    setIsScrolledBack((current) => (current === next ? current : next));
  }

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    const element = scrollRef.current;
    if (!element) return;
    scrollChatElementToBottom(element, behavior);
    isScrolledBackRef.current = false;
    setIsScrolledBack(false);
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    function applyLoadedState(loaded: ChatSessionState) {
      setState(loaded);
      setProvider(
        providerFromString(loaded.provider) ??
          defaultProvider(useSettings.getState().settings),
      );
      setSending(chatStateIsRunning(loaded));
    }

    async function loadState(showLoading: boolean) {
      if (showLoading) setLoading(true);
      if (showLoading) setDraft("");
      setError(null);
      try {
        const loaded = await api.loadChatSessionState(sessionId);
        if (!cancelled) applyLoadedState(loaded);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    }

    void loadState(true);
    void listen<ChatSessionStateChangedPayload>(
      CHAT_SESSION_STATE_CHANGED_EVENT,
      (event) => {
        if (cancelled || event.payload.session_id !== sessionId) return;
        setError(null);
        setLoading(false);
        applyLoadedState(event.payload.state);
      },
    ).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    const refreshVisibleState = () => {
      if (document.visibilityState === "hidden") return;
      void loadState(false);
    };
    window.addEventListener("focus", refreshVisibleState);
    document.addEventListener("visibilitychange", refreshVisibleState);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("focus", refreshVisibleState);
      document.removeEventListener("visibilitychange", refreshVisibleState);
    };
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isActive) return;

    function focusDraftOnEnter(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.key !== "Enter" ||
        event.repeat ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        isInteractiveKeyboardTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      textareaRef.current?.focus();
    }

    window.addEventListener("keydown", focusDraftOnEnter);
    return () => window.removeEventListener("keydown", focusDraftOnEnter);
  }, [isActive]);

  const latestMessage = messages[messages.length - 1];
  useLayoutEffect(() => {
    if (loading || !hasMessages) {
      isScrolledBackRef.current = false;
      setIsScrolledBack(false);
      return;
    }
    const shouldScroll =
      forceScrollToBottomRef.current || !isScrolledBackRef.current;
    forceScrollToBottomRef.current = false;
    if (!shouldScroll) {
      syncScrollState();
      return;
    }
    scrollToBottom("auto");
  }, [
    hasMessages,
    latestMessage?.content.length,
    latestMessage?.id,
    latestMessage?.status,
    loading,
  ]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;

    const baseState = state ?? emptyChatState(sessionId);
    const now = new Date().toISOString();
    forceScrollToBottomRef.current = true;
    setDraft("");
    setState({
      ...baseState,
      provider,
      messages: [
        ...baseState.messages,
        {
          id: `local-user-${now}`,
          session_id: sessionId,
          turn_id: `local-turn-${now}`,
          role: "user",
          content,
          created_at: now,
          status: "complete",
          metadata: null,
        },
        {
          id: `local-assistant-${now}`,
          session_id: sessionId,
          turn_id: `local-turn-${now}`,
          role: "assistant",
          content: "",
          created_at: now,
          status: "pending",
          metadata: { provider },
        },
      ],
      updated_at: now,
    });
    setSending(true);
    setError(null);
    setLocalChatSessionStatus(sessionId, "running");

    try {
      const saved = await api.sendChatMessage(
        sessionId,
        chatAiRequest(provider, settings),
        content,
      );
      setState(saved);
      setProvider(providerFromString(saved.provider) ?? provider);
      setLocalChatSessionStatus(sessionId, sessionStatusFromChatState(saved));
    } catch (err) {
      setError(String(err));
      setLocalChatSessionStatus(sessionId, "failed");
    } finally {
      setSending(false);
    }
  }

  async function handleCopyMessage(messageId: string, content: string) {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
      copyResetTimer.current = window.setTimeout(() => {
        setCopiedMessageId(null);
        copyResetTimer.current = null;
      }, 1400);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-bg text-fg">
      <div
        ref={scrollRef}
        data-chat-scroll-region
        onScroll={syncScrollState}
        className={`min-h-0 flex-1 overflow-auto px-4 py-3 transition-opacity duration-300 ease-out ${
          composerIsCentered ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        {loading ? (
          <div className="text-sm text-fg-muted">Loading...</div>
        ) : error ? (
          <div className="text-sm text-danger">{error}</div>
        ) : hasMessages ? (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
            {messages.map((message, index) => {
              const isUser = message.role === "user";
              const isSystem = message.role === "system";
              const isError = message.status === "error";
              const isPending = message.status === "pending";
              const headerLabel = messageHeaderLabel(message, stateProvider);
              const messageProvider = providerFromMetadata(message.metadata);
              const agentProvider =
                agentProviderFromMetadata(message.metadata) ??
                providerFromString(stateProvider);
              const durationLabel = responseDurationLabel(
                messages,
                index,
              );
              const timestampLabel = formatMessageTimestamp(
                message.created_at,
                relativeNow,
              );
              const timestampTitle = formatMessageTimestampTitle(
                message.created_at,
              );
              const bubbleClass = isUser
                ? "bg-accent/18 text-fg ring-accent/35"
                : isError
                  ? "bg-danger/10 text-danger ring-danger/35"
                  : "bg-bg-elevated/85 text-fg ring-border/80";

              return (
                <div
                  key={message.id}
                  className={`acorn-chat-message-enter flex ${
                    isSystem
                      ? "justify-center"
                      : isUser
                        ? "justify-end"
                        : "justify-start"
                  }`}
                >
                  <article
                    className={`flex max-w-[min(42rem,82%)] flex-col ${
                      isUser ? "items-end" : "items-start"
                    }`}
                  >
                    {headerLabel ? (
                      <div
                        data-chat-message-header
                        className={`mb-1 flex items-center gap-1 px-1 text-xs tracking-normal text-fg-muted ${
                          isUser ? "justify-end" : "justify-start"
                        }`}
                      >
                        {message.role === "assistant" && agentProvider ? (
                          <AgentProviderIcon
                            provider={agentProvider}
                            className="size-3"
                          />
                        ) : null}
                        <span>
                          {headerLabel}
                          {isPending ? " - pending" : ""}
                          {isError ? " - error" : ""}
                        </span>
                      </div>
                    ) : null}
                    <div
                      className={`rounded-lg px-3 py-2 text-sm leading-6 shadow-sm ring-1 ring-inset ${bubbleClass} ${
                        isSystem
                          ? "max-w-xl bg-bg-sidebar/70 text-xs text-fg-muted"
                          : ""
                      }`}
                    >
                      {isPending ? (
                        <div className="flex items-center gap-2 text-fg-muted">
                          <LoaderCircle size={14} className="animate-spin" />
                          Running {providerLabel(
                            messageProvider ?? stateProvider ?? provider,
                          )}
                        </div>
                      ) : (
                        <ChatMessageBody
                          content={message.content}
                          repoPath={repoPath}
                          isStreaming={message.status === "streaming"}
                        />
                      )}
                    </div>
                    {!isSystem && !isPending && message.content.trim() ? (
                      <div
                        className={`mt-1 flex px-1 ${
                          isUser ? "justify-end" : "justify-start"
                        }`}
                      >
                        {timestampLabel ? (
                          <>
                            <Tooltip
                              label={timestampTitle ?? timestampLabel}
                              side="bottom"
                            >
                              <time
                                className="self-center font-mono text-[11px] text-fg-muted/75"
                                dateTime={message.created_at}
                                data-chat-message-timestamp
                              >
                                {timestampLabel}
                              </time>
                            </Tooltip>
                            <span
                              aria-hidden="true"
                              className="mx-1 h-1 w-1 self-center rounded-full bg-fg-muted/40"
                              data-chat-timestamp-separator
                            />
                          </>
                        ) : null}
                        {durationLabel ? (
                          <>
                            <span
                              className="self-center font-mono text-[11px] text-fg-muted/75"
                              data-chat-response-duration
                            >
                              {durationLabel}
                            </span>
                            <span
                              aria-hidden="true"
                              className="mx-1 h-1 w-1 self-center rounded-full bg-fg-muted/40"
                              data-chat-duration-separator
                            />
                          </>
                        ) : null}
                        <Tooltip label="Copy message" side="bottom">
                          <button
                            aria-label={`Copy ${
                              headerLabel ?? message.role
                            } message`}
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                            type="button"
                            onClick={() =>
                              void handleCopyMessage(
                                message.id,
                                message.content,
                              )
                            }
                          >
                            {copiedMessageId === message.id ? (
                              <Check size={12} />
                            ) : (
                              <Copy size={12} />
                            )}
                          </button>
                        </Tooltip>
                      </div>
                    ) : null}
                  </article>
                </div>
              );
            })}
          </div>
        ) : (
          <div aria-hidden="true" className="h-full" />
        )}
      </div>
      {hasMessages && isScrolledBack ? (
        <Tooltip label="Scroll chat to bottom" side="top" delay={150}>
          <button
            type="button"
            aria-label="Scroll chat to bottom"
            onClick={() => scrollToBottom()}
            className="absolute bottom-24 right-4 z-20 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-elevated/95 text-fg-muted shadow-lg backdrop-blur-sm transition hover:bg-bg-sidebar hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent/60"
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      <form
        data-chat-composer={composerIsCentered ? "centered" : "bottom"}
        className={`bg-bg px-3 py-2 transition-transform duration-300 ease-out will-change-transform ${
          composerIsCentered
            ? "-translate-y-[max(0px,calc(50vh-120px))]"
            : "translate-y-0"
        }`}
        onSubmit={handleSubmit}
      >
        <div
          className={`mx-auto flex items-start gap-2 rounded-lg border border-border bg-bg-elevated/65 shadow-sm transition-[max-width,padding,box-shadow,border-color] duration-300 ease-out ${
            composerIsCentered
              ? "max-w-3xl px-3 py-3 shadow-xl ring-1 ring-border/60"
              : "max-w-4xl px-2 py-2"
          }`}
        >
          <select
            aria-label="Chat provider"
            className={`shrink-0 rounded bg-transparent px-2 text-xs text-fg outline-none transition focus:bg-bg disabled:opacity-60 ${
              composerIsCentered ? "h-10" : "h-8"
            }`}
            disabled={sending}
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as ChatProvider)
            }
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="antigravity">Antigravity</option>
          </select>
          <textarea
            ref={textareaRef}
            aria-label="Chat message"
            className={`max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 leading-5 text-fg outline-none placeholder:text-fg-muted/70 disabled:opacity-60 ${
              composerIsCentered ? "min-h-[4.75rem] text-base" : "min-h-16 text-sm"
            }`}
            disabled={sending}
            placeholder={providerPlaceholder(provider)}
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              ) {
                return;
              }
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          <button
            aria-label="Send message"
            className={`inline-flex shrink-0 items-center justify-center rounded bg-accent/20 text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50 ${
              composerIsCentered ? "h-10 w-10" : "h-8 w-8"
            }`}
            disabled={sending || draft.trim().length === 0}
            type="submit"
          >
            {sending ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <Send size={composerIsCentered ? 18 : 16} />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
