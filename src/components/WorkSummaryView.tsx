import {
  AlertTriangle,
  Clock,
  Copy,
  FileText,
  Files,
  Hash,
  MessageSquareText,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CHAT_SESSION_STATE_CHANGED_EVENT,
  FS_CHANGED_EVENT,
  api,
  type ChatSessionStateChangedPayload,
  type FsChangePayload,
  type FsGitDiffStatsRequest,
  type FsGitStatus,
} from "../lib/api";
import { cn } from "../lib/cn";
import type { TranslationKey, Translator } from "../lib/i18n";
import { fsChangeTouchesRoot } from "../lib/workSummaryInvalidation";
import type { Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import {
  buildWorkSummary,
  summarizeChatSession,
  summarizeTokenUsage,
  type WorkSummary,
  type WorkSummaryChatMetrics,
  type WorkSummaryTokenUsage,
} from "../lib/workSummary";
import type { WorkSummaryWorkspaceTab } from "../lib/workspaceTabs";
import type { AgentTranscriptSummary } from "../lib/types";
import { Notice } from "./ui/Notice";
import { RefreshButton } from "./ui/RefreshButton";
import {
  FileStatusChart,
  TokenUsageChart,
} from "./work-summary/WorkSummaryCharts";
import {
  ChangedFilesSkeleton,
  ChartSkeleton,
  ConversationSkeleton,
  MetricValueSkeleton,
  TokenUsageSkeleton,
} from "./work-summary/WorkSummarySkeletons";
import { Tooltip } from "./Tooltip";

const GIT_STATUS_FILE_LIMIT = 500;
const SUMMARY_REFRESH_DEBOUNCE_MS = 500;
const TRANSCRIPT_POLL_INTERVAL_MS = 15_000;

const STATUS_CLASS: Record<FsGitStatus, string> = {
  added: "bg-emerald-500/10 text-emerald-300",
  clean: "bg-bg-elevated text-fg-muted",
  conflicted: "bg-danger/10 text-danger",
  deleted: "bg-rose-500/10 text-rose-300",
  modified: "bg-amber-500/10 text-amber-300",
  renamed: "bg-sky-500/10 text-sky-300",
};

type WorkSummaryTranslationKey = Extract<
  TranslationKey,
  `workSummary.${string}`
>;

function wt(t: Translator, key: WorkSummaryTranslationKey): string {
  return t(key);
}

function wtf(
  t: Translator,
  key: WorkSummaryTranslationKey,
  values: Record<string, string | number>,
): string {
  return wt(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

interface WorkSummaryViewProps {
  tab: WorkSummaryWorkspaceTab;
  session?: Session | null;
  isActive: boolean;
  onOpenFile?: (path: string) => void;
}

interface WorkSummarySnapshot {
  summary: WorkSummary;
}

interface WorkSummaryConversationSnapshot {
  chat: WorkSummaryChatMetrics | null;
  tokens: WorkSummaryTokenUsage | null;
  messages: AgentTranscriptSummary["recent_messages"];
}

interface AgentTranscriptLocation {
  provider: AgentTranscriptSummary["provider"];
  id: string;
  transcriptPath: string;
}

interface MetadataRow {
  key: string;
  label: string;
  value: string | null | undefined;
  copyValue?: string;
  copyLabel?: string;
}

export function WorkSummaryView({
  tab,
  session,
  isActive,
  onOpenFile,
}: WorkSummaryViewProps) {
  const t = useTranslation();
  const [summary, setSummary] = useState<WorkSummary | null>(null);
  const [chat, setChat] = useState<WorkSummaryChatMetrics | null>(null);
  const [tokens, setTokens] = useState<WorkSummaryTokenUsage | null>(null);
  const [messages, setMessages] = useState<AgentTranscriptSummary["recent_messages"]>(
    [],
  );
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptLocationRef = useRef<AgentTranscriptLocation | null>(null);
  const summaryInFlightRef = useRef<{
    identity: string;
    promise: Promise<WorkSummarySnapshot>;
  } | null>(null);
  const conversationInFlightRef = useRef<{
    identity: string;
    promise: Promise<WorkSummaryConversationSnapshot>;
  } | null>(null);
  const loading = summaryLoading || conversationLoading;
  const conversationIdentity = [
    tab.repoPath,
    session?.id ?? "",
    session?.mode ?? "",
    session?.agent_transcript_provider ?? "",
    session?.agent_transcript_id ?? "",
    session?.agent_transcript_path ?? "",
  ].join("\u0000");
  const summaryIdentity = [tab.cwdPath, session?.branch ?? ""].join("\u0000");

  const fetchSummary = useCallback(async (): Promise<WorkSummarySnapshot> => {
    const status = await api.fsGitStatus(tab.cwdPath, GIT_STATUS_FILE_LIMIT);
    const entries: FsGitDiffStatsRequest[] = Object.entries(status.statuses)
      .filter(([, entry]) => entry.kind !== "clean")
      .map(([path, entry]) => ({ path, kind: entry.kind }));
    const diffStats =
      entries.length > 0 ? await api.fsGitDiffStats(tab.cwdPath, entries) : {};
    const summary = buildWorkSummary(tab.cwdPath, status, diffStats);
    return { summary };
  }, [tab.cwdPath]);

  const fetchSummaryCoalesced = useCallback(() => {
    const existing = summaryInFlightRef.current;
    if (existing?.identity === summaryIdentity) return existing.promise;

    const promise = fetchSummary().finally(() => {
      if (summaryInFlightRef.current?.promise === promise) {
        summaryInFlightRef.current = null;
      }
    });
    summaryInFlightRef.current = { identity: summaryIdentity, promise };
    return promise;
  }, [fetchSummary, summaryIdentity]);

  const fetchConversation = useCallback(async (): Promise<WorkSummaryConversationSnapshot> => {
    if (!session) {
      return { chat: null, tokens: null, messages: [] };
    }

    if (session.mode === "chat") {
      const chatState = await api.loadChatSessionState(session.id);
      return {
        chat: summarizeChatSession(chatState),
        tokens: summarizeTokenUsage(chatState),
        messages: [],
      };
    }

    const transcriptId = session.agent_transcript_id;
    if (transcriptId) {
      const pairedLocation =
        session.agent_transcript_provider && session.agent_transcript_path
          ? {
              provider: session.agent_transcript_provider,
              id: transcriptId,
              transcriptPath: session.agent_transcript_path,
            }
          : null;
      const transcript = await fetchAgentTranscriptSummary(
        tab.repoPath,
        transcriptId,
        transcriptLocationRef,
        pairedLocation,
      );
      return {
        chat: transcript ? chatMetricsFromTranscript(transcript) : null,
        tokens: transcript ? tokenUsageFromTranscript(transcript) : null,
        messages: transcript?.recent_messages ?? [],
      };
    }

    return { chat: null, tokens: null, messages: [] };
  }, [
    session?.agent_transcript_path,
    session?.agent_transcript_provider,
    session?.agent_transcript_id,
    session?.id,
    session?.mode,
    tab.repoPath,
  ]);

  const fetchConversationCoalesced = useCallback(() => {
    const existing = conversationInFlightRef.current;
    if (existing?.identity === conversationIdentity) return existing.promise;

    const promise = fetchConversation().finally(() => {
      if (conversationInFlightRef.current?.promise === promise) {
        conversationInFlightRef.current = null;
      }
    });
    conversationInFlightRef.current = {
      identity: conversationIdentity,
      promise,
    };
    return promise;
  }, [conversationIdentity, fetchConversation]);

  const applySnapshot = useCallback((snapshot: WorkSummarySnapshot) => {
    setSummary(snapshot.summary);
  }, []);

  const applyConversationSnapshot = useCallback(
    (snapshot: WorkSummaryConversationSnapshot) => {
      setChat(snapshot.chat);
      setTokens(snapshot.tokens);
      setMessages(snapshot.messages);
    },
    [],
  );

  useEffect(() => {
    transcriptLocationRef.current = null;
    setChat(null);
    setTokens(null);
    setMessages([]);
  }, [conversationIdentity]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn("[WorkSummaryView] clipboard write failed", err);
    }
  }, []);

  const load = useCallback(async () => {
    setSummaryLoading(true);
    setConversationLoading(true);
    setError(null);
    const summaryTask = fetchSummaryCoalesced()
      .then(applySnapshot)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSummaryLoading(false));
    const conversationTask = fetchConversationCoalesced()
      .then(applyConversationSnapshot)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setConversationLoading(false));
    await Promise.allSettled([summaryTask, conversationTask]);
  }, [
    applyConversationSnapshot,
    applySnapshot,
    fetchConversationCoalesced,
    fetchSummaryCoalesced,
  ]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setSummaryLoading(true);
    setConversationLoading(true);
    setError(null);

    async function runSummary() {
      try {
        const snapshot = await fetchSummaryCoalesced();
        if (!cancelled) applySnapshot(snapshot);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    }

    async function runConversation() {
      try {
        const snapshot = await fetchConversationCoalesced();
        if (!cancelled) applyConversationSnapshot(snapshot);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setConversationLoading(false);
      }
    }

    void runSummary();
    void runConversation();
    return () => {
      cancelled = true;
    };
  }, [
    applyConversationSnapshot,
    applySnapshot,
    fetchConversationCoalesced,
    fetchSummaryCoalesced,
    isActive,
  ]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let fsUnlisten: UnlistenFn | null = null;
    let chatUnlisten: UnlistenFn | null = null;
    let refreshTimer: number | null = null;
    let transcriptPollTimer: number | null = null;

    async function refreshSummarySilently() {
      try {
        const snapshot = await fetchSummaryCoalesced();
        if (!cancelled) applySnapshot(snapshot);
      } catch (err) {
        void err;
      }
    }

    async function refreshConversationSilently() {
      try {
        const snapshot = await fetchConversationCoalesced();
        if (!cancelled) applyConversationSnapshot(snapshot);
      } catch (err) {
        void err;
      }
    }

    function scheduleRefresh() {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshSummarySilently();
      }, SUMMARY_REFRESH_DEBOUNCE_MS);
    }

    void listen<FsChangePayload>(FS_CHANGED_EVENT, (event) => {
      if (cancelled || !fsChangeTouchesRoot(event.payload, tab.cwdPath)) return;
      scheduleRefresh();
    }).then((dispose) => {
      if (cancelled) dispose();
      else fsUnlisten = dispose;
    });

    if (session?.mode === "chat") {
      void listen<ChatSessionStateChangedPayload>(
        CHAT_SESSION_STATE_CHANGED_EVENT,
        (event) => {
          if (cancelled || event.payload.session_id !== session.id) return;
          setError(null);
          setChat(summarizeChatSession(event.payload.state));
          setTokens(summarizeTokenUsage(event.payload.state));
        },
      ).then((dispose) => {
        if (cancelled) dispose();
        else chatUnlisten = dispose;
      });
    } else if (session?.agent_transcript_id) {
      transcriptPollTimer = window.setInterval(() => {
        void refreshConversationSilently();
      }, TRANSCRIPT_POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (transcriptPollTimer !== null) {
        window.clearInterval(transcriptPollTimer);
      }
      fsUnlisten?.();
      chatUnlisten?.();
    };
  }, [
    applyConversationSnapshot,
    applySnapshot,
    fetchConversationCoalesced,
    fetchSummaryCoalesced,
    isActive,
    session?.id,
    session?.agent_transcript_id,
    session?.mode,
    tab.repoPath,
    tab.cwdPath,
  ]);

  const metadata = useMemo(() => {
    const rows: MetadataRow[] = [
      {
        key: "scope",
        label: wt(t, "workSummary.metadata.scope"),
        value: tab.cwdPath,
      },
    ];
    if (session) {
      rows.push(
        {
          key: "session",
          label: wt(t, "workSummary.metadata.session"),
          value: session.name,
        },
        {
          key: "branch",
          label: wt(t, "workSummary.metadata.branch"),
          value: session.branch,
        },
        {
          key: "status",
          label: wt(t, "workSummary.metadata.status"),
          value: session.status,
        },
        {
          key: "mode",
          label: wt(t, "workSummary.metadata.mode"),
          value: session.mode ?? "terminal",
        },
        {
          key: "transcript",
          label: wt(t, "workSummary.metadata.transcript"),
          value: session.agent_transcript_id,
        },
        {
          key: "transcriptProvider",
          label: wt(t, "workSummary.metadata.transcriptProvider"),
          value: session.agent_transcript_provider,
        },
        {
          key: "transcriptPath",
          label: wt(t, "workSummary.metadata.transcriptPath"),
          value: session.agent_transcript_path,
          copyValue: session.agent_transcript_path ?? undefined,
          copyLabel: wt(t, "workSummary.metadata.copyTranscriptPath"),
        },
        {
          key: "updated",
          label: wt(t, "workSummary.metadata.updated"),
          value: formatDateTime(session.updated_at),
        },
      );
    }
    return rows.filter((row) => row.value);
  }, [session, t, tab.cwdPath]);
  const summaryPending = summaryLoading && !summary;
  const conversationPending = conversationLoading && !chat && !tokens;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText size={16} className="shrink-0 text-accent" />
            <h2 className="truncate text-sm font-semibold">
              {wt(t, "workSummary.title")}
            </h2>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-fg-muted">
            {tab.cwdPath}
          </p>
        </div>
        <RefreshButton
          onClick={load}
          loading={loading}
          title={wt(t, "workSummary.refresh")}
          ariaLabel={wt(t, "workSummary.refresh")}
        />
      </header>

      <div
        className="min-h-0 flex-1 space-y-3 overflow-auto p-3"
        aria-busy={loading ? true : undefined}
      >
        {error ? (
          <Notice tone="danger" icon={<AlertTriangle size={14} />}>
            {error}
          </Notice>
        ) : null}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCell
            icon={<Files size={14} />}
            label={wt(t, "workSummary.metrics.files")}
            value={
              summaryPending ? (
                <MetricValueSkeleton />
              ) : summary ? (
                wtf(t, "workSummary.values.files", {
                  count: summary.totalFiles,
                })
              ) : (
                wt(t, "workSummary.notAvailable")
              )
            }
          />
          <MetricCell
            icon={<Hash size={14} />}
            label={wt(t, "workSummary.metrics.lines")}
            value={
              summaryPending ? (
                <MetricValueSkeleton />
              ) : summary ? (
                `+${summary.totalAdditions} / -${summary.totalDeletions}`
              ) : (
                wt(t, "workSummary.notAvailable")
              )
            }
          />
          <MetricCell
            icon={<MessageSquareText size={14} />}
            label={wt(t, "workSummary.metrics.messages")}
            value={
              conversationPending ? (
                <MetricValueSkeleton />
              ) : chat ? (
                wtf(t, "workSummary.values.messages", {
                  count: chat.messageCount,
                })
              ) : (
                wt(t, "workSummary.notAvailable")
              )
            }
          />
          <MetricCell
            icon={<Clock size={14} />}
            label={wt(t, "workSummary.metrics.tokens")}
            value={
              conversationPending ? (
                <MetricValueSkeleton />
              ) : tokens && tokens.totalTokens > 0 ? (
                wtf(t, "workSummary.values.tokens", {
                  count: formatNumber(tokens.totalTokens),
                })
              ) : (
                wt(t, "workSummary.notAvailable")
              )
            }
          />
        </section>

        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Card className="min-w-0">
            <SectionHeader
              title={wt(t, "workSummary.files.title")}
              detail={
                summary?.huge
                  ? wtf(t, "workSummary.files.huge", {
                      limit: summary.limit,
                    })
                : undefined
              }
            />
            {summaryPending ? (
              <ChangedFilesSkeleton />
            ) : !summary ? (
              <EmptyLine>{wt(t, "workSummary.notAvailable")}</EmptyLine>
            ) : summary.files.length === 0 ? (
              <EmptyLine>{wt(t, "workSummary.files.empty")}</EmptyLine>
            ) : (
              <div className="space-y-0.5 p-1">
                {summary.files.map((file) => (
                  <div
                    key={file.path}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-1.5 text-xs",
                      onOpenFile
                        ? "cursor-pointer hover:bg-bg-elevated focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent"
                        : null,
                    )}
                    data-work-summary-file-path={file.path}
                    role={onOpenFile ? "button" : undefined}
                    tabIndex={onOpenFile ? 0 : undefined}
                    aria-label={
                      onOpenFile
                        ? wtf(t, "workSummary.files.openFile", {
                            path: file.relativePath,
                          })
                        : undefined
                    }
                    onDoubleClick={() => onOpenFile?.(file.path)}
                    onKeyDown={(event) => {
                      if (!onOpenFile || event.key !== "Enter") return;
                      event.preventDefault();
                      onOpenFile(file.path);
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                            STATUS_CLASS[file.kind],
                          )}
                        >
                          {wt(t, `workSummary.status.${file.kind}`)}
                        </span>
                        <span className="truncate font-mono">
                          {file.relativePath}
                        </span>
                      </div>
                    </div>
                    <span className="font-mono text-[11px] tabular-nums text-fg-muted">
                      <span className="text-emerald-300">+{file.additions}</span>
                      <span className="mx-1 text-fg-muted">/</span>
                      <span className="text-rose-300">-{file.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card as="aside" className="min-w-0">
            <SectionHeader title={wt(t, "workSummary.details.title")} />
            <dl className="space-y-2 px-4 py-3">
              {metadata.map((row) => (
                <div key={row.key} data-work-summary-metadata-key={row.key}>
                  <dt className="text-[10px] uppercase text-fg-muted">
                    {row.label}
                  </dt>
                  <dd className="mt-1 flex min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate font-mono text-[11px]">
                      {row.value}
                    </span>
                    {row.copyValue && row.copyLabel ? (
                      <Tooltip label={row.copyLabel} side="left">
                        <button
                          type="button"
                          aria-label={row.copyLabel}
                          onClick={() => void copyText(row.copyValue!)}
                          className="inline-flex size-5 shrink-0 items-center justify-center rounded border border-transparent text-fg-muted hover:border-border hover:bg-bg-elevated hover:text-fg"
                        >
                          <Copy size={11} />
                        </button>
                      </Tooltip>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <Card>
            <SectionHeader title={wt(t, "workSummary.conversation.title")} />
            {conversationPending ? (
              <ConversationSkeleton />
            ) : chat ? (
              <>
                <div className="grid grid-cols-2 gap-2 p-3">
                  <ConversationStat
                    label={wt(t, "workSummary.conversation.user")}
                    value={chat.userMessages}
                  />
                  <ConversationStat
                    label={wt(t, "workSummary.conversation.assistant")}
                    value={chat.assistantMessages}
                  />
                  <ConversationStat
                    label={wt(t, "workSummary.conversation.turns")}
                    value={chat.turnCount}
                  />
                  <ConversationStat
                    label={wt(t, "workSummary.conversation.runningTurns")}
                    value={chat.runningTurns}
                  />
                </div>
                {messages.length > 0 ? (
                  <div
                    className="border-t border-border px-3 pb-3 pt-2"
                    data-testid="work-summary-recent-messages"
                  >
                    <div className="mb-2 text-[10px] font-medium uppercase text-fg-muted">
                      {wt(t, "workSummary.conversation.recentMessages")}
                    </div>
                    <div className="space-y-2">
                      {messages.map((message, index) => (
                        <TranscriptMessagePreview
                          key={`${message.role}:${index}:${message.text}`}
                          message={message}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyLine>
                {wt(t, "workSummary.conversation.terminalHint")}
              </EmptyLine>
            )}
          </Card>
          <Card>
            <SectionHeader title={wt(t, "workSummary.tokens.title")} />
            {conversationPending ? (
              <TokenUsageSkeleton />
            ) : tokens && tokens.totalTokens > 0 ? (
              <TokenUsageChart
                tokens={tokens}
                baseline={tab.tokenBaseline}
                t={t}
              />
            ) : (
              <EmptyLine>{wt(t, "workSummary.tokens.empty")}</EmptyLine>
            )}
          </Card>
        </section>

        <Card as="section">
          <SectionHeader title={wt(t, "workSummary.charts.title")} />
          {summaryPending ? (
            <ChartSkeleton />
          ) : summary && summary.totalFiles > 0 ? (
            <FileStatusChart
              counts={summary.byKind}
              total={summary.totalFiles}
              t={t}
            />
          ) : (
            <EmptyLine>{wt(t, "workSummary.files.empty")}</EmptyLine>
          )}
        </Card>
      </div>
    </div>
  );
}

function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "aside";
}) {
  return (
    <Tag
      className={cn(
        "overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/40",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

function MetricCell({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/40 px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] text-fg-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate font-mono text-lg tabular-nums">{value}</div>
    </div>
  );
}

function SectionHeader({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
      <h3 className="text-xs font-semibold">{title}</h3>
      {detail ? (
        <span className="truncate text-[11px] text-fg-muted">{detail}</span>
      ) : null}
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-xs text-fg-muted">{children}</div>;
}

function ConversationStat({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md bg-bg-sidebar/40 px-3 py-2">
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className="mt-1 font-mono text-base tabular-nums">{value}</div>
    </div>
  );
}

function TranscriptMessagePreview({
  message,
  t,
}: {
  message: AgentTranscriptSummary["recent_messages"][number];
  t: Translator;
}) {
  const label =
    message.role === "user"
      ? wt(t, "workSummary.conversation.user")
      : wt(t, "workSummary.conversation.assistant");
  return (
    <div
      className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded-md bg-bg-sidebar/40 px-3 py-2 text-xs"
      data-testid={`work-summary-recent-message-${message.role}`}
    >
      <div className="text-[10px] font-medium uppercase text-fg-muted">
        {label}
      </div>
      <div className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words text-fg">
        {message.text}
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString();
}

async function fetchAgentTranscriptSummary(
  repoPath: string,
  transcriptId: string,
  locationRef: { current: AgentTranscriptLocation | null },
  initialLocation: AgentTranscriptLocation | null = null,
): Promise<AgentTranscriptSummary | null> {
  const cached =
    initialLocation?.id === transcriptId ? initialLocation : locationRef.current;
  let transcript: AgentTranscriptSummary | null = null;

  if (cached?.id === transcriptId) {
    try {
      transcript = await api.agentTranscriptSummaryAtPath(
        repoPath,
        cached.provider,
        cached.id,
        cached.transcriptPath,
      );
    } catch {
      transcript = null;
    }
    if (!transcript) {
      locationRef.current = null;
    }
  } else if (cached) {
    locationRef.current = null;
  }

  if (!transcript) {
    transcript = await api.agentTranscriptSummary(repoPath, transcriptId);
  }
  if (transcript) {
    locationRef.current = {
      provider: transcript.provider,
      id: transcript.id,
      transcriptPath: transcript.transcript_path,
    };
  }
  return transcript;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function chatMetricsFromTranscript(
  transcript: AgentTranscriptSummary,
): WorkSummaryChatMetrics {
  return {
    messageCount: transcript.message_count,
    userMessages: transcript.user_messages,
    assistantMessages: transcript.assistant_messages,
    turnCount: transcript.turn_count,
    completeTurns: transcript.complete_turns,
    runningTurns: transcript.running_turns,
  };
}

function tokenUsageFromTranscript(
  transcript: AgentTranscriptSummary,
): WorkSummaryTokenUsage {
  return {
    inputTokens: transcript.token_usage.input_tokens,
    outputTokens: transcript.token_usage.output_tokens,
    cacheReadTokens: transcript.token_usage.cache_read_tokens,
    cacheCreationTokens: transcript.token_usage.cache_creation_tokens,
    reasoningTokens: transcript.token_usage.reasoning_tokens,
    totalTokens: transcript.token_usage.total_tokens,
    messagesWithUsage: transcript.token_usage.messages_with_usage,
  };
}
