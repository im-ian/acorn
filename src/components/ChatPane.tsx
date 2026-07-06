import {
  ArrowDownToLine,
  Check,
  Copy,
  GitFork,
  LoaderCircle,
  Paperclip,
  Pencil,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
import { pathRelativeToCwd } from "../lib/fileMention";
import { useDialogShortcuts } from "../lib/dialog";
import { useAppStore } from "../store";
import type {
  ChatMessage,
  Session,
  SessionAgentProvider,
  SessionStatus,
} from "../lib/types";
import { ChatMessageBody } from "./chat/ChatMessageBody";
import { Tooltip } from "./Tooltip";
import { Button, Modal, ModalFooter, ModalHeader, Select } from "./ui";

interface ChatPaneProps {
  sessionId: string;
  isActive?: boolean;
  repoPath?: string;
  session?: Session;
}

type ChatProvider = SessionAgentProvider;
type ChatWorktreeMode = "same" | "new";
interface ChatAttachment {
  id: string;
  path: string;
  name: string;
}

const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 48;
const STREAM_SMOOTH_BASE_CHARS = 3;
const STREAM_SMOOTH_MAX_CHARS = 48;
const FORKED_CHAT_DEFAULT_TITLE = "Forked chat";
const EMPTY_COMPOSER_TITLES = [
  "어떤 작업을 진행할까요?",
  "지금 바로 구현해보세요.",
  "아이디어를 현실로",
  "무엇부터 만들어볼까요?",
  "작게 시작해서 빠르게 확인해보세요.",
  "다음 변경을 설명해주세요.",
  "고치고 싶은 부분을 알려주세요.",
  "새로운 흐름을 설계해볼까요?",
  "오늘 만들 기능은 무엇인가요?",
  "생각한 방향을 코드로 옮겨보세요.",
];

function pickEmptyComposerTitle(): string {
  const index = Math.floor(Math.random() * EMPTY_COMPOSER_TITLES.length);
  return EMPTY_COMPOSER_TITLES[index] ?? EMPTY_COMPOSER_TITLES[0];
}

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
  if (chatStateIsRunning(state)) return "working";
  const lastMessage = state.messages[state.messages.length - 1];
  const lastTurn = state.turns[state.turns.length - 1];
  if (lastMessage?.status === "error" || lastTurn?.status === "error") {
    return "errored";
  }
  return "waiting_for_input";
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

function createLocalId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

function escapeMentionPath(path: string): string {
  return path.replace(/([\\\s])/gu, "\\$1");
}

function formatChatAttachmentMention(
  path: string,
  repoPath: string | undefined,
): string {
  const displayPath = repoPath ? pathRelativeToCwd(path, repoPath) : path;
  return `@${escapeMentionPath(displayPath)}`;
}

function normalizePickedAttachments(
  selection: string | string[] | null,
): ChatAttachment[] {
  const paths = Array.isArray(selection)
    ? selection
    : selection
      ? [selection]
      : [];
  return paths.map((path) => ({
    id: createLocalId("chat-attachment"),
    path,
    name: fileNameFromPath(path),
  }));
}

function composeChatMessageContent(
  draft: string,
  attachments: ChatAttachment[],
  repoPath: string | undefined,
): string {
  const body = draft.trim();
  if (attachments.length === 0) return body;
  const attachmentLines = attachments.map(
    (attachment) =>
      `- ${formatChatAttachmentMention(attachment.path, repoPath)}`,
  );
  const attachmentBlock = [`Attached files:`, ...attachmentLines].join("\n");
  return body ? `${attachmentBlock}\n\n${body}` : attachmentBlock;
}

function clippedSingleLine(value: string, max = 48): string {
  const compact = value.trim().replace(/\s+/g, " ");
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function forkedChatName(
  source: ChatSessionState,
  messages: ChatMessage[],
): string {
  const sourceTitle = source.session.title?.trim();
  if (sourceTitle) return sourceTitle;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const label = clippedSingleLine(message.content);
    if (label) return `Fork: ${label}`;
  }
  return FORKED_CHAT_DEFAULT_TITLE;
}

function cloneMessagesForFork(
  messages: ChatMessage[],
  sessionId: string,
): ChatMessage[] {
  return messages
    .filter((message) => {
      if (message.status === "pending" || message.status === "streaming") {
        return false;
      }
      return message.role !== "assistant" || message.content.trim().length > 0;
    })
    .map((message) => ({
      ...message,
      id: createLocalId("fork-message"),
      session_id: sessionId,
      turn_id: null,
    }));
}

function buildForkedChatState(
  source: ChatSessionState,
  session: Session,
  messages: ChatMessage[],
): ChatSessionState {
  const now = new Date().toISOString();
  return {
    schema_version: source.schema_version,
    session_id: session.id,
    session: {
      id: session.id,
      workspace_path: session.worktree_path,
      title: session.name,
      active_provider: source.provider ?? source.session.active_provider ?? null,
      active_model: source.model ?? source.session.active_model ?? null,
      created_at: now,
      updated_at: now,
    },
    provider: source.provider ?? source.session.active_provider ?? null,
    model: source.model ?? source.session.active_model ?? null,
    messages: cloneMessagesForFork(messages, session.id),
    turns: [],
    provider_threads: [],
    context_snapshots: [],
    memory: {
      session_id: session.id,
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

function shouldAdoptSourceWorktree(source: Session | undefined): boolean {
  return Boolean(
    source &&
      source.project_scoped !== false &&
      source.worktree_path &&
      source.repo_path &&
      source.worktree_path !== source.repo_path,
  );
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

function chatStateUpdatedAtMs(state: ChatSessionState): number | null {
  const candidates = [state.updated_at, state.session.updated_at];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function streamingDisplayStep(backlog: number): number {
  if (backlog <= 0) return 0;
  if (backlog > 600) {
    return Math.min(STREAM_SMOOTH_MAX_CHARS, Math.ceil(backlog / 8));
  }
  if (backlog > 160) return 18;
  if (backlog > 60) return 9;
  return STREAM_SMOOTH_BASE_CHARS;
}

function requestDisplayFrame(callback: FrameRequestCallback): number {
  if (typeof window === "undefined" || !window.requestAnimationFrame) {
    return setTimeout(() => callback(performance.now()), 16);
  }
  return window.requestAnimationFrame(callback);
}

function cancelDisplayFrame(frame: number) {
  if (typeof window === "undefined" || !window.cancelAnimationFrame) {
    clearTimeout(frame);
    return;
  }
  window.cancelAnimationFrame(frame);
}

function useSmoothedStreamingContent(
  content: string,
  isStreaming: boolean,
): string {
  const initialContent = isStreaming
    ? content.slice(0, streamingDisplayStep(content.length))
    : content;
  const [visibleContent, setVisibleContent] = useState(initialContent);
  const visibleRef = useRef(initialContent);
  const targetRef = useRef(content);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelDisplayFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    targetRef.current = content;

    const flush = (next: string) => {
      if (frameRef.current !== null) {
        cancelDisplayFrame(frameRef.current);
        frameRef.current = null;
      }
      visibleRef.current = next;
      setVisibleContent(next);
    };

    if (!isStreaming) {
      flush(content);
      return;
    }

    if (
      visibleRef.current.length > content.length ||
      !content.startsWith(visibleRef.current)
    ) {
      flush(content);
      return;
    }

    const tick = () => {
      frameRef.current = null;
      const target = targetRef.current;
      const visible = visibleRef.current;
      if (visible.length >= target.length) return;
      if (!target.startsWith(visible)) {
        flush(target);
        return;
      }
      const backlog = target.length - visible.length;
      const nextLength = visible.length + streamingDisplayStep(backlog);
      const next = target.slice(0, Math.min(target.length, nextLength));
      visibleRef.current = next;
      setVisibleContent(next);
      if (next.length < targetRef.current.length) {
        frameRef.current = requestDisplayFrame(tick);
      }
    };

    if (
      visibleRef.current.length < content.length &&
      frameRef.current === null
    ) {
      frameRef.current = requestDisplayFrame(tick);
    }
  }, [content, isStreaming]);

  return visibleContent;
}

function StreamingChatMessageBody({
  content,
  repoPath,
  isStreaming,
}: {
  content: string;
  repoPath?: string;
  isStreaming: boolean;
}) {
  const displayContent = useSmoothedStreamingContent(content, isStreaming);
  return (
    <ChatMessageBody
      content={displayContent}
      repoPath={repoPath}
      isStreaming={isStreaming}
    />
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

export function resolveMessageActionProvider({
  messages,
  message,
  stateProvider,
  fallbackProvider,
}: {
  messages: ChatMessage[];
  message: ChatMessage;
  stateProvider: string | null | undefined;
  fallbackProvider: ChatProvider;
}): ChatProvider {
  const messageProvider = providerFromString(
    providerFromMetadata(message.metadata),
  );
  if (messageProvider) return messageProvider;

  if (message.role === "user") {
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    const nextAssistant =
      index >= 0
        ? messages
            .slice(index + 1)
            .find((candidate) => candidate.role === "assistant")
        : undefined;
    const nextProvider = providerFromString(
      providerFromMetadata(nextAssistant?.metadata),
    );
    if (nextProvider) return nextProvider;
  }

  return providerFromString(stateProvider) ?? fallbackProvider;
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
  nowMs = Date.now(),
): string | null {
  const message = messages[index];
  if (!message || message.role !== "assistant") return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = messages[i];
    if (previous.role !== "user") continue;
    const started = Date.parse(previous.created_at);
    const completed =
      message.status === "pending" || message.status === "streaming"
        ? nowMs
        : Date.parse(message.created_at);
    return formatResponseDuration(completed - started);
  }
  return null;
}

export function ChatPane({
  sessionId,
  isActive = true,
  repoPath,
  session,
}: ChatPaneProps) {
  const [state, setState] = useState<ChatSessionState | null>(null);
  const latestChatStateRef = useRef<ChatSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [messageActionBusyId, setMessageActionBusyId] = useState<string | null>(
    null,
  );
  const [startupWorktreeMode, setStartupWorktreeMode] =
    useState<ChatWorktreeMode>("same");
  const [forkTargetIndex, setForkTargetIndex] = useState<number | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const [emptyComposerTitle] = useState(pickEmptyComposerTitle);
  const latestChatStateUpdatedAtRef = useRef<number | null>(null);
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
  const hasRunningMessages = messages.some(
    (message) => message.status === "pending" || message.status === "streaming",
  );
  const composerIsCentered = !loading && !error && !hasMessages;
  const showEmptyComposerTitle =
    composerIsCentered && !sending && !hasRunningMessages;
  const sourceRepoPath = session?.repo_path ?? repoPath;
  const sourceWorktreePath = session?.worktree_path ?? repoPath;
  const sourceProjectScoped = session?.project_scoped !== false;
  const canUseNewWorktree = Boolean(sourceRepoPath && sourceProjectScoped);
  const canChooseStartupWorktree =
    composerIsCentered &&
    canUseNewWorktree &&
    !(session?.isolated || session?.in_worktree);

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

  function applyChatState(loaded: ChatSessionState) {
    const loadedAt = chatStateUpdatedAtMs(loaded);
    const currentAt = latestChatStateUpdatedAtRef.current;
    if (loadedAt !== null && currentAt !== null && loadedAt < currentAt) {
      return false;
    }
    latestChatStateUpdatedAtRef.current = loadedAt ?? currentAt;
    latestChatStateRef.current = loaded;
    setState(loaded);
    setProvider(
      providerFromString(loaded.provider) ??
        defaultProvider(useSettings.getState().settings),
    );
    setSending(chatStateIsRunning(loaded));
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    latestChatStateUpdatedAtRef.current = null;

    async function loadState(showLoading: boolean) {
      if (showLoading) setLoading(true);
      if (showLoading) setDraft("");
      setError(null);
      try {
        const loaded = await api.loadChatSessionState(sessionId);
        if (!cancelled) applyChatState(loaded);
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
        applyChatState(event.payload.state);
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
    setStartupWorktreeMode("same");
    setForkTargetIndex(null);
    setEditingMessageId(null);
    setEditDraft("");
    setMessageActionBusyId(null);
  }, [sessionId]);

  useEffect(() => {
    setRelativeNow(Date.now());
    const intervalMs = hasRunningMessages ? 1_000 : 60_000;
    const timer = window.setInterval(
      () => setRelativeNow(Date.now()),
      intervalMs,
    );
    return () => window.clearInterval(timer);
  }, [hasRunningMessages]);

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

  async function prepareStartupWorktreeIfNeeded() {
    if (hasMessages || startupWorktreeMode !== "new") return;
    if (!canChooseStartupWorktree) {
      throw new Error("New worktree is only available for project chat sessions");
    }
    await api.prepareChatSessionWorktree(sessionId);
    await useAppStore.getState().refreshAll();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const submittedDraft = draft;
    const submittedAttachments = attachments;
    const content = composeChatMessageContent(
      draft,
      submittedAttachments,
      repoPath,
    );
    if (!content) return;

    const previousState =
      latestChatStateRef.current?.session_id === sessionId
        ? latestChatStateRef.current
        : state?.session_id === sessionId
          ? state
          : null;
    const baseState = previousState ?? emptyChatState(sessionId);
    const now = new Date().toISOString();
    let optimisticState: ChatSessionState | null = null;
    forceScrollToBottomRef.current = true;
    setDraft("");
    setAttachments([]);
    setSending(true);
    setError(null);

    try {
      await prepareStartupWorktreeIfNeeded();
      optimisticState = {
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
      };
      latestChatStateRef.current = optimisticState;
      setState(optimisticState);
      setLocalChatSessionStatus(sessionId, "working");
      const saved = await api.sendChatMessage(
        sessionId,
        chatAiRequest(provider, settings),
        content,
      );
      applyChatState(saved);
      setLocalChatSessionStatus(sessionId, sessionStatusFromChatState(saved));
    } catch (err) {
      const latestState = latestChatStateRef.current;
      const shouldRollback =
        optimisticState === null
          ? latestState === previousState
          : latestState === optimisticState;
      if (shouldRollback) {
        latestChatStateRef.current = previousState;
        setState(previousState);
        setDraft(submittedDraft);
        setAttachments(submittedAttachments);
        setLocalChatSessionStatus(sessionId, "errored");
      } else if (latestState?.session_id === sessionId) {
        setLocalChatSessionStatus(
          sessionId,
          sessionStatusFromChatState(latestState),
        );
      }
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  async function handlePickAttachments() {
    if (sending) return;
    setError(null);
    try {
      const selection = await open({
        directory: false,
        multiple: true,
      });
      const picked = normalizePickedAttachments(selection);
      if (picked.length === 0) return;
      setAttachments((current) => {
        const seen = new Set(current.map((attachment) => attachment.path));
        return [
          ...current,
          ...picked.filter((attachment) => !seen.has(attachment.path)),
        ];
      });
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCancelResponse() {
    if (cancelling || (!sending && !hasRunningMessages)) return;
    setCancelling(true);
    setError(null);
    try {
      const cancelled = await api.cancelChatMessage(sessionId);
      applyChatState(cancelled);
      setLocalChatSessionStatus(
        sessionId,
        sessionStatusFromChatState(cancelled),
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
      setCancelling(false);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
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

  function providerForMessage(message: ChatMessage): ChatProvider {
    return resolveMessageActionProvider({
      messages,
      message,
      stateProvider,
      fallbackProvider: provider,
    });
  }

  async function handleRetryMessage(
    message: ChatMessage,
    replacementContent?: string,
  ) {
    if (sending || hasRunningMessages || messageActionBusyId) return;
    const content =
      replacementContent === undefined ? undefined : replacementContent.trim();
    if (content !== undefined && !content) return;
    forceScrollToBottomRef.current = true;
    setMessageActionBusyId(message.id);
    setSending(true);
    setError(null);
    setLocalChatSessionStatus(sessionId, "working");
    try {
      const saved = await api.retryChatMessage(
        sessionId,
        chatAiRequest(providerForMessage(message), settings),
        message.id,
        content,
      );
      applyChatState(saved);
      setLocalChatSessionStatus(sessionId, sessionStatusFromChatState(saved));
      setEditingMessageId(null);
      setEditDraft("");
    } catch (err) {
      setError(String(err));
      setLocalChatSessionStatus(sessionId, "errored");
    } finally {
      setSending(false);
      setMessageActionBusyId(null);
    }
  }

  function beginEditingMessage(message: ChatMessage) {
    if (sending || hasRunningMessages || messageActionBusyId) return;
    setEditingMessageId(message.id);
    setEditDraft(message.content);
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setEditDraft("");
  }

  async function handleSaveEditedMessage(message: ChatMessage) {
    await handleRetryMessage(message, editDraft);
  }

  async function handleDeleteMessage(message: ChatMessage) {
    if (sending || hasRunningMessages || messageActionBusyId) return;
    setMessageActionBusyId(message.id);
    setError(null);
    try {
      const saved = await api.deleteChatMessage(sessionId, message.id);
      applyChatState(saved);
      setLocalChatSessionStatus(sessionId, sessionStatusFromChatState(saved));
      if (editingMessageId === message.id) {
        setEditingMessageId(null);
        setEditDraft("");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setMessageActionBusyId(null);
    }
  }

  function openForkDialog(index: number) {
    setForkTargetIndex(index);
  }

  function closeForkDialog() {
    if (forkBusy) return;
    setForkTargetIndex(null);
  }

  async function handleForkBeforeMessage(
    index: number,
    worktreeMode: ChatWorktreeMode,
  ) {
    if (!state || !sourceRepoPath) return;
    if (worktreeMode === "new" && !canUseNewWorktree) {
      setError("New worktree is only available for project chat sessions");
      return;
    }
    const forkMessages = state.messages.slice(0, index);
    const name = forkedChatName(state, forkMessages);
    const createPath =
      sourceProjectScoped || worktreeMode === "new"
        ? sourceRepoPath
        : (sourceWorktreePath ?? sourceRepoPath);
    const isolated = worktreeMode === "new";
    setError(null);
    setForkBusy(true);
    try {
      const store = useAppStore.getState();
      const created = await store.createSession(
        name,
        createPath,
        isolated,
        "regular",
        providerFromString(state.provider) ?? provider,
        sourceProjectScoped,
        "chat",
      );
      const createError = useAppStore.getState().consumeError();
      if (!created) {
        throw new Error(createError ?? "failed to fork chat session");
      }
      if (createError) {
        throw new Error(createError);
      }
      const adopted =
        worktreeMode === "same" && shouldAdoptSourceWorktree(session)
          ? await api.updateSessionWorktree(created.id, session!.worktree_path)
          : created;
      const renamed = await api.renameSession(adopted.id, name);
      const forkState = buildForkedChatState(state, renamed, forkMessages);
      await api.saveChatSessionState(forkState);
      await useAppStore.getState().refreshAll();
      useAppStore.getState().selectSession(renamed.id);
      setForkTargetIndex(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setForkBusy(false);
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
        {!loading && error ? (
          <div className="mx-auto mb-3 w-full max-w-4xl text-sm text-danger">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="text-sm text-fg-muted">Loading...</div>
        ) : hasMessages ? (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
            {messages.map((message, index) => {
              const isUser = message.role === "user";
              const isSystem = message.role === "system";
              const isError = message.status === "error";
              const isPending = message.status === "pending";
              const isStreaming = message.status === "streaming";
              const isRunningMessage = isPending || isStreaming;
              const isCancelled = message.status === "cancelled";
              const canForkBeforeMessage =
                !isRunningMessage &&
                !isUser &&
                index > 0 &&
                Boolean(sourceRepoPath);
              const headerLabel = messageHeaderLabel(message, stateProvider);
              const messageProvider = providerFromMetadata(message.metadata);
              const agentProvider =
                agentProviderFromMetadata(message.metadata) ??
                providerFromString(stateProvider);
              const durationLabel = responseDurationLabel(
                messages,
                index,
                relativeNow,
              );
              const timestampLabel = formatMessageTimestamp(
                message.created_at,
                relativeNow,
              );
              const timestampTitle = formatMessageTimestampTitle(
                message.created_at,
              );
              const isEditing = editingMessageId === message.id;
              const isActionBusy = messageActionBusyId === message.id;
              const isLastMessage = index === messages.length - 1;
              const actionDisabled =
                sending ||
                cancelling ||
                hasRunningMessages ||
                messageActionBusyId !== null;
              const canEditMessage =
                isUser && !isRunningMessage && isLastMessage;
              const canRegenerateMessage =
                message.role === "assistant" &&
                !isRunningMessage &&
                isLastMessage;
              const canDeleteMessage =
                !isSystem && !isRunningMessage && isLastMessage;
              const showMessageMeta =
                !isSystem &&
                ((isRunningMessage && Boolean(durationLabel)) ||
                  (!isRunningMessage && message.content.trim().length > 0));
              const actionLabel = headerLabel ?? message.role;
              const bubbleClass = isUser
                ? "bg-accent/18 text-fg ring-accent/35"
                : isError
                  ? "bg-danger/10 text-danger ring-danger/35"
                  : isCancelled
                    ? "bg-bg-sidebar/70 text-fg-muted ring-border/70"
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
                          {isStreaming ? " - streaming" : ""}
                          {isError ? " - error" : ""}
                          {isCancelled ? " - cancelled" : ""}
                        </span>
                        {isStreaming ? (
                          <LoaderCircle
                            size={11}
                            className="animate-spin text-fg-muted/75"
                            data-chat-streaming-spinner
                          />
                        ) : null}
                      </div>
                    ) : null}
                    <div
                      className={`rounded-lg px-3 py-2 text-sm leading-6 shadow-sm ring-1 ring-inset ${bubbleClass} ${
                        isSystem
                          ? "max-w-xl bg-bg-sidebar/70 text-xs text-fg-muted"
                          : ""
                      }`}
                    >
                      {isPending || (isStreaming && !message.content) ? (
                        <div className="flex items-center text-fg-muted">
                          <span
                            className="animate-pulse"
                            data-chat-running-label
                          >
                            Running {providerLabel(
                              messageProvider ?? stateProvider ?? provider,
                            )}
                          </span>
                        </div>
                      ) : isEditing ? (
                        <div className="flex min-w-0 flex-col gap-2">
                          <textarea
                            aria-label="Edit user message content"
                            className="min-h-24 w-full min-w-[18rem] resize-y rounded border border-input-border bg-input px-2 py-1.5 text-sm leading-5 text-fg outline-none focus:border-accent/70 focus:bg-input-hover disabled:opacity-60"
                            disabled={isActionBusy}
                            value={editDraft}
                            onChange={(event) => setEditDraft(event.target.value)}
                          />
                          <div className="flex justify-end gap-1">
                            <Tooltip label="Cancel edit" side="bottom">
                              <button
                                aria-label="Cancel edited user message"
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={isActionBusy}
                                type="button"
                                onClick={cancelEditingMessage}
                              >
                                <X size={13} />
                              </button>
                            </Tooltip>
                            <Tooltip
                              label="Save edit and regenerate"
                              side="bottom"
                            >
                              <button
                                aria-label="Save edited user message"
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-accent transition hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={isActionBusy || !editDraft.trim()}
                                type="button"
                                onClick={() =>
                                  void handleSaveEditedMessage(message)
                                }
                              >
                                {isActionBusy ? (
                                  <LoaderCircle
                                    size={13}
                                    className="animate-spin"
                                  />
                                ) : (
                                  <Check size={13} />
                                )}
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      ) : (
                        <StreamingChatMessageBody
                          content={message.content}
                          repoPath={repoPath}
                          isStreaming={isStreaming}
                        />
                      )}
                    </div>
                    {showMessageMeta ? (
                      <div
                        data-chat-message-meta
                        className={`mt-1 flex px-1 ${
                          isUser ? "justify-end" : "justify-start"
                        }`}
                      >
                        {isRunningMessage && durationLabel ? (
                          <span
                            className="self-center font-mono text-[11px] text-fg-muted/75"
                            data-chat-running-duration
                          >
                            {durationLabel}
                          </span>
                        ) : null}
                        {!isRunningMessage && timestampLabel ? (
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
                        {!isRunningMessage && durationLabel ? (
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
                        {!isRunningMessage ? (
                          <>
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
                            {canRegenerateMessage ? (
                              <Tooltip label="Regenerate response" side="bottom">
                                <button
                                  aria-label={`Regenerate ${actionLabel} message`}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={actionDisabled}
                                  type="button"
                                  onClick={() => void handleRetryMessage(message)}
                                >
                                  {isActionBusy ? (
                                    <LoaderCircle
                                      size={12}
                                      className="animate-spin"
                                    />
                                  ) : (
                                    <RotateCcw size={12} />
                                  )}
                                </button>
                              </Tooltip>
                            ) : null}
                          </>
                        ) : null}
                        {canEditMessage ? (
                          <Tooltip label="Edit message" side="bottom">
                            <button
                              aria-label={`Edit ${actionLabel} message`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={actionDisabled}
                              type="button"
                              onClick={() => beginEditingMessage(message)}
                            >
                              <Pencil size={12} />
                            </button>
                          </Tooltip>
                        ) : null}
                        {canDeleteMessage ? (
                          <Tooltip label="Delete from here" side="bottom">
                            <button
                              aria-label={`Delete ${actionLabel} message`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={actionDisabled}
                              type="button"
                              onClick={() => void handleDeleteMessage(message)}
                            >
                              {isActionBusy ? (
                                <LoaderCircle
                                  size={12}
                                  className="animate-spin"
                                />
                              ) : (
                                <Trash2 size={12} />
                              )}
                            </button>
                          </Tooltip>
                        ) : null}
                        {canForkBeforeMessage ? (
                          <Tooltip
                            label="Fork chat before this message"
                            side="bottom"
                          >
                            <button
                              aria-label={`Fork before ${
                                headerLabel ?? message.role
                              } message`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                              type="button"
                              onClick={() => openForkDialog(index)}
                            >
                              <GitFork size={12} />
                            </button>
                          </Tooltip>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                </div>
              );
            })}
          </div>
        ) : !error ? (
          <div aria-hidden="true" className="h-full" />
        ) : null}
      </div>
      {hasMessages && isScrolledBack ? (
        <Tooltip label="Scroll chat to bottom" side="top" delay={150}>
          <button
            type="button"
            aria-label="Scroll chat to bottom"
            onClick={() => scrollToBottom()}
            className="absolute bottom-36 right-4 z-20 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-elevated/95 text-fg-muted shadow-lg backdrop-blur-sm transition hover:bg-bg-sidebar hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent/60"
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      <form
        data-chat-composer={composerIsCentered ? "centered" : "bottom"}
        className={`relative bg-bg px-2 py-2 transition-opacity duration-200 ease-out will-change-opacity ${
          composerIsCentered
            ? "-translate-y-[max(0px,calc(50vh-120px))]"
            : "translate-y-0"
        } ${loading ? "pointer-events-none opacity-0" : "opacity-100"}`}
        onSubmit={handleSubmit}
      >
        <div
          aria-hidden={!showEmptyComposerTitle}
          className={`pointer-events-none absolute inset-x-2 bottom-full mb-4 flex justify-center transition-opacity duration-200 ease-out ${
            showEmptyComposerTitle ? "opacity-100" : "opacity-0"
          }`}
          data-chat-empty-composer-title
        >
          <p className="w-[90%] max-w-none text-center text-xl font-medium leading-8 tracking-normal text-fg">
            {emptyComposerTitle}
          </p>
        </div>
        <div
          className={`mx-auto flex flex-col gap-2 rounded-[var(--acorn-pane-radius)] border border-input-border bg-input shadow-sm transition-[width,max-width,padding,box-shadow,border-color,background-color] duration-300 ease-out focus-within:border-accent/60 focus-within:bg-input-hover ${
            composerIsCentered
              ? "w-[90%] max-w-none px-3 py-3 shadow-xl ring-1 ring-border/60"
              : "max-w-4xl px-2 py-2"
          }`}
        >
          <textarea
            ref={textareaRef}
            aria-label="Chat message"
            className={`max-h-40 w-full resize-none bg-transparent px-1 py-1.5 leading-5 text-fg outline-none placeholder:text-fg-muted/70 disabled:opacity-60 ${
              composerIsCentered
                ? "min-h-[5.5rem] text-base"
                : "min-h-16 text-sm"
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
          <div
            className="flex items-end justify-between gap-2"
            data-chat-composer-actions
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Tooltip label="Attach file" side="top">
                <button
                  aria-label="Attach file"
                  className={`inline-flex shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-bg-sidebar hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50 ${
                    composerIsCentered ? "h-9 w-9" : "h-8 w-8"
                  }`}
                  disabled={sending}
                  type="button"
                  onClick={() => void handlePickAttachments()}
                >
                  <Paperclip size={composerIsCentered ? 17 : 15} />
                </button>
              </Tooltip>
              {attachments.length > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  {attachments.map((attachment) => (
                    <Tooltip
                      key={attachment.id}
                      label={attachment.path}
                      side="top"
                      multiline
                      className="max-w-40"
                    >
                      <span className="inline-flex max-w-40 items-center gap-1 rounded border border-border bg-bg/70 px-1.5 py-1 text-xs text-fg-muted">
                        <span className="truncate">{attachment.name}</span>
                        <button
                          aria-label={`Remove attachment ${attachment.name}`}
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-bg-sidebar hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                          disabled={sending}
                          type="button"
                          onClick={() => removeAttachment(attachment.id)}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    </Tooltip>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canChooseStartupWorktree ? (
                <Select
                  aria-label="Chat worktree mode"
                  className="w-40 shrink-0"
                  disabled={sending}
                  value={startupWorktreeMode}
                  onChange={(event) =>
                    setStartupWorktreeMode(
                      event.target.value as ChatWorktreeMode,
                    )
                  }
                >
                  <option value="same">Current directory</option>
                  <option value="new">New worktree</option>
                </Select>
              ) : null}
              <Select
                aria-label="Chat provider"
                className="w-32 shrink-0"
                disabled={sending}
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as ChatProvider)
                }
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="antigravity">Antigravity</option>
              </Select>
              {sending || hasRunningMessages ? (
                <Tooltip label="Stop response" side="top">
                  <button
                    aria-label="Stop response"
                    className={`inline-flex shrink-0 items-center justify-center rounded bg-danger/15 text-danger transition hover:bg-danger/25 disabled:cursor-not-allowed disabled:opacity-50 ${
                      composerIsCentered ? "h-9 w-9" : "h-8 w-8"
                    }`}
                    disabled={cancelling}
                    type="button"
                    onClick={() => void handleCancelResponse()}
                  >
                    {cancelling ? (
                      <LoaderCircle size={16} className="animate-spin" />
                    ) : (
                      <Square size={composerIsCentered ? 16 : 14} />
                    )}
                  </button>
                </Tooltip>
              ) : (
                <button
                  aria-label="Send message"
                  className={`inline-flex shrink-0 items-center justify-center rounded bg-accent/20 text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50 ${
                    composerIsCentered ? "h-9 w-9" : "h-8 w-8"
                  }`}
                  disabled={draft.trim().length === 0 && attachments.length === 0}
                  type="submit"
                >
                  <Send size={composerIsCentered ? 18 : 16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
      <ForkWorktreeDialog
        open={forkTargetIndex !== null}
        busy={forkBusy}
        canUseNewWorktree={canUseNewWorktree}
        worktreePath={sourceWorktreePath ?? sourceRepoPath ?? null}
        onClose={closeForkDialog}
        onChoose={(mode) => {
          if (forkTargetIndex === null) return;
          void handleForkBeforeMessage(forkTargetIndex, mode);
        }}
      />
    </div>
  );
}

interface ForkWorktreeDialogProps {
  open: boolean;
  busy: boolean;
  canUseNewWorktree: boolean;
  worktreePath: string | null;
  onClose: () => void;
  onChoose: (mode: ChatWorktreeMode) => void;
}

function ForkWorktreeDialog({
  open,
  busy,
  canUseNewWorktree,
  worktreePath,
  onClose,
  onChoose,
}: ForkWorktreeDialogProps) {
  useDialogShortcuts(open, {
    onCancel: onClose,
    onConfirm: () => {
      if (!busy) onChoose("same");
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="md"
      ariaLabel="Choose chat fork worktree"
    >
      <ModalHeader
        title="Fork chat session"
        subtitle="Choose where the fork should continue."
        icon={<GitFork size={14} className="text-accent" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p className="text-fg">
          Start a new chat from the messages before this response.
        </p>
        {worktreePath ? (
          <div className="rounded border border-border bg-bg-sidebar/70 px-3 py-2">
            <div className="text-[11px] text-fg-muted">Current directory</div>
            <Tooltip
              label={worktreePath}
              side="bottom"
              multiline
              className="mt-1 flex min-w-0 max-w-full"
            >
              <span
                aria-label={worktreePath}
                className="min-w-0 max-w-full flex-1 truncate font-mono text-[11px] leading-5 text-fg"
                data-chat-fork-current-directory
                dir="ltr"
              >
                {worktreePath}
              </span>
            </Tooltip>
          </div>
        ) : null}
        {!canUseNewWorktree ? (
          <p className="rounded-md border border-border bg-bg-sidebar/60 px-3 py-2 text-[11px]">
            New worktree is only available for project chat sessions.
          </p>
        ) : null}
      </div>
      <ModalFooter variant="sidebar">
        <Button
          onClick={onClose}
          disabled={busy}
          size="md"
          surface="dialog"
        >
          Cancel
        </Button>
        <Button
          aria-label="Fork in same directory"
          onClick={() => onChoose("same")}
          disabled={busy}
          variant="outline"
          size="md"
          surface="dialog"
        >
          Same directory
        </Button>
        <Button
          aria-label="Fork in new worktree"
          onClick={() => onChoose("new")}
          disabled={busy || !canUseNewWorktree}
          variant="accentSoft"
          size="md"
          surface="dialog"
        >
          New worktree
        </Button>
      </ModalFooter>
    </Modal>
  );
}
