import {
  AlertTriangle,
  Clock,
  FileText,
  Files,
  Hash,
  MessageSquareText,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
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
import type { Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import {
  buildWorkSummary,
  summarizeChatSession,
  summarizeTokenUsage,
  tokenUsageDelta,
  type WorkSummary,
  type WorkSummaryChatMetrics,
  type WorkSummaryKindCounts,
  type WorkSummaryTokenUsage,
} from "../lib/workSummary";
import type { WorkSummaryWorkspaceTab } from "../lib/workspaceTabs";
import type { AgentTranscriptSummary } from "../lib/types";
import { RefreshButton } from "./ui/RefreshButton";

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
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = summaryLoading || conversationLoading;

  const fetchSummary = useCallback(async (): Promise<WorkSummarySnapshot> => {
    const status = await api.fsGitStatus(tab.cwdPath, 500);
    const entries: FsGitDiffStatsRequest[] = Object.entries(status.statuses)
      .filter(([, entry]) => entry.kind !== "clean")
      .map(([path, entry]) => ({ path, kind: entry.kind }));
    const diffStats =
      entries.length > 0 ? await api.fsGitDiffStats(tab.cwdPath, entries) : {};
    const summary = buildWorkSummary(tab.cwdPath, status, diffStats);
    return { summary };
  }, [tab.cwdPath]);

  const fetchConversation = useCallback(async (): Promise<WorkSummaryConversationSnapshot> => {
    if (!session) {
      return { chat: null, tokens: null };
    }

    if (session.mode === "chat") {
      const chatState = await api.loadChatSessionState(session.id);
      return {
        chat: summarizeChatSession(chatState),
        tokens: summarizeTokenUsage(chatState),
      };
    }

    if (session.agent_transcript_id) {
      const transcript = await api.agentTranscriptSummary(
        tab.repoPath,
        session.agent_transcript_id,
      );
      return {
        chat: transcript ? chatMetricsFromTranscript(transcript) : null,
        tokens: transcript ? tokenUsageFromTranscript(transcript) : null,
      };
    }

    return { chat: null, tokens: null };
  }, [
    session?.agent_transcript_id,
    session?.id,
    session?.mode,
    tab.repoPath,
  ]);

  const applySnapshot = useCallback((snapshot: WorkSummarySnapshot) => {
    setSummary(snapshot.summary);
  }, []);

  const applyConversationSnapshot = useCallback(
    (snapshot: WorkSummaryConversationSnapshot) => {
      setChat(snapshot.chat);
      setTokens(snapshot.tokens);
    },
    [],
  );

  const load = useCallback(async () => {
    setSummaryLoading(true);
    setConversationLoading(true);
    setError(null);
    const summaryTask = fetchSummary()
      .then(applySnapshot)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSummaryLoading(false));
    const conversationTask = fetchConversation()
      .then(applyConversationSnapshot)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setConversationLoading(false));
    await Promise.allSettled([summaryTask, conversationTask]);
  }, [
    applyConversationSnapshot,
    applySnapshot,
    fetchConversation,
    fetchSummary,
  ]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setSummaryLoading(true);
    setConversationLoading(true);
    setError(null);

    async function runSummary() {
      try {
        const snapshot = await fetchSummary();
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
        const snapshot = await fetchConversation();
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
    fetchConversation,
    fetchSummary,
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
        const snapshot = await fetchSummary();
        if (!cancelled) applySnapshot(snapshot);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    async function refreshConversationSilently() {
      try {
        const snapshot = await fetchConversation();
        if (!cancelled) applyConversationSnapshot(snapshot);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    function scheduleRefresh() {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshSummarySilently();
      }, 500);
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
      }, 5_000);
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
    fetchConversation,
    fetchSummary,
    isActive,
    session?.id,
    session?.agent_transcript_id,
    session?.mode,
    tab.repoPath,
    tab.cwdPath,
  ]);

  const metadata = useMemo(() => {
    const rows: Array<{ label: string; value: string | null | undefined }> = [
      { label: wt(t, "workSummary.metadata.scope"), value: tab.cwdPath },
    ];
    if (session) {
      rows.push(
        { label: wt(t, "workSummary.metadata.session"), value: session.name },
        { label: wt(t, "workSummary.metadata.branch"), value: session.branch },
        { label: wt(t, "workSummary.metadata.status"), value: session.status },
        {
          label: wt(t, "workSummary.metadata.mode"),
          value: session.mode ?? "terminal",
        },
        {
          label: wt(t, "workSummary.metadata.transcript"),
          value: session.agent_transcript_id,
        },
        {
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
        className="min-h-0 flex-1 overflow-auto"
        aria-busy={loading ? true : undefined}
      >
        {error ? (
          <div className="m-4 flex items-start gap-2 rounded border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <section className="grid grid-cols-2 border-b border-border md:grid-cols-4">
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

        <section className="grid gap-0 border-b border-border lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
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
              <div className="divide-y divide-border">
                {summary.files.map((file) => (
                  <div
                    key={file.path}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-xs",
                      onOpenFile
                        ? "cursor-default hover:bg-bg-elevated focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent"
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
          </div>

          <aside className="min-w-0">
            <SectionHeader title={wt(t, "workSummary.details.title")} />
            <dl className="divide-y divide-border">
              {metadata.map((row) => (
                <div key={row.label} className="px-4 py-2">
                  <dt className="text-[10px] uppercase text-fg-muted">
                    {row.label}
                  </dt>
                  <dd className="mt-1 truncate font-mono text-[11px]">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </aside>
        </section>

        <section>
          <div className="grid gap-0 border-b border-border lg:grid-cols-2">
            <div className="border-b border-border lg:border-b-0 lg:border-r">
              <SectionHeader title={wt(t, "workSummary.conversation.title")} />
              {conversationPending ? (
                <ConversationSkeleton />
              ) : chat ? (
                <div className="grid grid-cols-2 gap-px bg-border">
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
              ) : (
                <EmptyLine>
                  {wt(t, "workSummary.conversation.terminalHint")}
                </EmptyLine>
              )}
            </div>
            <div>
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
            </div>
          </div>
        </section>

        <section>
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
        </section>
      </div>
    </div>
  );
}

function MetricValueSkeleton() {
  return <SkeletonBlock className="h-5 w-24 bg-fg-muted/15" />;
}

function ChangedFilesSkeleton() {
  return (
    <div
      className="divide-y divide-border"
      data-work-summary-section-skeleton="files"
    >
      {[0, 1, 2, 3, 4].map((idx) => (
        <div
          key={idx}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <SkeletonBlock className="h-5 w-10 bg-fg-muted/15" />
            <SkeletonBlock
              className={cn(
                "h-3 min-w-0 bg-fg-muted/10",
                idx % 3 === 0 ? "w-52" : idx % 3 === 1 ? "w-72" : "w-40",
              )}
            />
          </div>
          <SkeletonBlock className="h-3 w-16 bg-fg-muted/10" />
        </div>
      ))}
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-px bg-border"
      data-work-summary-section-skeleton="conversation"
    >
      {Array.from({ length: 4 }).map((_, idx) => (
        <div key={idx} className="bg-bg px-4 py-3">
          <SkeletonBlock className="h-2.5 w-20 bg-fg-muted/10" />
          <SkeletonBlock className="mt-2 h-4 w-10 bg-fg-muted/15" />
        </div>
      ))}
    </div>
  );
}

function TokenUsageSkeleton() {
  return (
    <div
      className="space-y-3 px-4 py-3"
      data-work-summary-section-skeleton="tokens"
    >
      <SkeletonBlock className="h-5 w-24 bg-fg-muted/15" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((idx) => (
          <SkeletonChartRow key={idx} />
        ))}
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      className="space-y-2 px-4 py-3"
      data-work-summary-section-skeleton="charts"
    >
      {[0, 1, 2].map((idx) => (
        <SkeletonChartRow key={idx} />
      ))}
    </div>
  );
}

function SkeletonChartRow() {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-2">
      <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/10" />
      <SkeletonBlock className="h-2 w-full bg-fg-muted/10" />
      <SkeletonBlock className="h-2.5 w-10 bg-fg-muted/10" />
    </div>
  );
}

function SkeletonBlock({ className }: { className: string }) {
  return (
    <span
      className={cn("block animate-pulse rounded bg-fg-muted/10", className)}
    />
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
    <div className="min-w-0 border-r border-border px-4 py-3 last:border-r-0">
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
    <div className="bg-bg px-4 py-3">
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className="mt-1 font-mono text-base tabular-nums">{value}</div>
    </div>
  );
}

function formatDateTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString();
}

function TokenUsageChart({
  tokens,
  baseline,
  t,
}: {
  tokens: WorkSummaryTokenUsage;
  baseline?: WorkSummaryTokenUsage & { capturedAt: string };
  t: Translator;
}) {
  const delta = tokenUsageDelta(tokens, baseline);
  const rows = [
    {
      label: wt(t, "workSummary.tokens.input"),
      value: tokens.inputTokens,
      className: "bg-sky-400",
    },
    {
      label: wt(t, "workSummary.tokens.output"),
      value: tokens.outputTokens,
      className: "bg-emerald-400",
    },
    {
      label: wt(t, "workSummary.tokens.cache"),
      value: tokens.cacheReadTokens + tokens.cacheCreationTokens,
      className: "bg-amber-400",
    },
    {
      label: wt(t, "workSummary.tokens.reasoning"),
      value: tokens.reasoningTokens,
      className: "bg-violet-400",
    },
  ].filter((row) => row.value > 0);
  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-lg tabular-nums">
            {formatNumber(tokens.totalTokens)}
          </div>
          <div className="text-[11px] text-fg-muted">
            {wtf(t, "workSummary.tokens.fromMessages", {
              count: tokens.messagesWithUsage,
            })}
          </div>
        </div>
      </div>
      {baseline ? (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-border bg-border">
          <TokenBaselineCell
            label={wt(t, "workSummary.tokens.sessionUsed")}
            value={formatNumber(tokens.totalTokens)}
          />
          <TokenBaselineCell
            label={wt(t, "workSummary.tokens.summaryStart")}
            value={formatNumber(baseline.totalTokens)}
          />
          <TokenBaselineCell
            label={wt(t, "workSummary.tokens.sinceSummary")}
            value={`+${formatNumber(delta.totalTokens)}`}
          />
        </div>
      ) : null}
      <div className="space-y-2">
        {rows.map((row) => (
          <ChartRow
            key={row.label}
            label={row.label}
            value={formatNumber(row.value)}
            width={(row.value / max) * 100}
            className={row.className}
          />
        ))}
      </div>
    </div>
  );
}

function TokenBaselineCell({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 bg-bg px-2 py-2">
      <div className="truncate text-[10px] uppercase text-fg-muted">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-xs tabular-nums">
        {value}
      </div>
    </div>
  );
}

function FileStatusChart({
  counts,
  total,
  t,
}: {
  counts: WorkSummaryKindCounts;
  total: number;
  t: Translator;
}) {
  const rows = (Object.keys(counts) as Array<keyof WorkSummaryKindCounts>)
    .filter((kind) => kind !== "clean" && counts[kind] > 0)
    .map((kind) => ({
      label: wt(t, `workSummary.status.${kind}`),
      value: counts[kind],
      className:
        kind === "added"
          ? "bg-emerald-400"
          : kind === "deleted"
            ? "bg-rose-400"
            : kind === "conflicted"
              ? "bg-danger"
              : kind === "renamed"
                ? "bg-sky-400"
                : "bg-amber-400",
    }));

  return (
    <div className="space-y-2 px-4 py-3">
      {rows.map((row) => (
        <ChartRow
          key={row.label}
          label={row.label}
          value={String(row.value)}
          width={(row.value / total) * 100}
          className={row.className}
        />
      ))}
    </div>
  );
}

function ChartRow({
  label,
  value,
  width,
  className,
}: {
  label: string;
  value: string;
  width: number;
  className: string;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-[11px]">
      <span className="truncate text-fg-muted">{label}</span>
      <div className="h-2 overflow-hidden rounded bg-bg-elevated">
        <div
          className={cn("h-full rounded", className)}
          style={{ width: `${Math.max(4, Math.min(100, width))}%` }}
        />
      </div>
      <span className="text-right font-mono tabular-nums">{value}</span>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function fsChangeTouchesRoot(payload: FsChangePayload, rootPath: string): boolean {
  if (payload.overflow && payload.refresh) {
    return pathsIntersect(payload.refresh.path, rootPath);
  }
  if (payload.root && pathsIntersect(payload.root, rootPath)) {
    return true;
  }
  return payload.paths.some((path) => pathsIntersect(path, rootPath));
}

function pathsIntersect(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return left === right || pathInside(left, right) || pathInside(right, left);
}

function pathInside(path: string, root: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
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
