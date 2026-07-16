import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { homeDir } from "@tauri-apps/api/path";
import {
  Activity,
  AlertCircle,
  Bell,
  CheckCheck,
  Clock,
  Columns3,
  Gauge,
  Kanban,
  Loader2,
  Scan,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import {
  AgentProviderIcon,
  providerSupportsTokenUsage,
  resolveSessionAgentProvider,
} from "../lib/agentProvider";
import { cn } from "../lib/cn";
import { createInFlightCoalescer } from "../lib/inFlightCoalescer";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useToasts } from "../lib/toasts";
import type {
  AgentStatusSource,
  MemoryProcess,
  SessionNotification,
  SessionNotificationKind,
  SessionStatus,
  SessionStatusReason,
  AgentTokenProvider,
  AgentTokenUsageMetric,
  AgentTokenUsageSnapshot,
  AgentTokenWindow,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore, type WorkspaceViewMode } from "../store";
import { MemoryBreakdownModal } from "./MemoryBreakdownModal";
import { Tooltip } from "./Tooltip";
import { Select, StatusDot, type SelectOption, type StatusTone } from "./ui";

const MEMORY_POLL_MS = 2000;
const TOKEN_USAGE_POLL_MS = 60_000;

type StatusBarTranslationKey = Extract<TranslationKey, `statusBar.${string}`>;

const SESSION_STATUS_KEYS: Record<SessionStatus, StatusBarTranslationKey> = {
  ready: "statusBar.sessionStatus.ready",
  working: "statusBar.sessionStatus.working",
  waiting_for_input: "statusBar.sessionStatus.waitingForInput",
  errored: "statusBar.sessionStatus.errored",
};

function sessionStatusReasonLabel(
  t: Translator,
  reason: SessionStatusReason | null | undefined,
): string | null {
  switch (reason) {
    case "turn_complete":
      return statusBarText(t, "statusBar.sessionStatusReason.turn_complete");
    case "shell_prompt":
      return statusBarText(t, "statusBar.sessionStatusReason.shell_prompt");
    default:
      return null;
  }
}

function agentStatusSourceLabel(
  t: Translator,
  source: AgentStatusSource | null | undefined,
): string | null {
  switch (source) {
    case "hook":
      return statusBarText(t, "statusBar.agentStatusSource.hook");
    case "transcript_fallback":
      return statusBarText(
        t,
        "statusBar.agentStatusSource.transcript_fallback",
      );
    case "process_fallback":
      return statusBarText(t, "statusBar.agentStatusSource.process_fallback");
    default:
      return null;
  }
}

function sessionStatusDetailLabel(
  t: Translator,
  status: SessionStatus,
  reason: SessionStatusReason | null | undefined,
  source: AgentStatusSource | null | undefined,
): string {
  const label = statusBarText(t, SESSION_STATUS_KEYS[status]);
  const details = [
    sessionStatusReasonLabel(t, reason),
    agentStatusSourceLabel(t, source),
  ].filter((detail): detail is string => detail !== null);
  return [label, ...details].join(" · ");
}

function statusBarText(t: Translator, key: StatusBarTranslationKey): string {
  return t(key);
}

function statusBarFormat(
  t: Translator,
  key: StatusBarTranslationKey,
  values: Record<string, string | number>,
): string {
  return statusBarText(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

function workspaceViewLabel(t: Translator, mode: WorkspaceViewMode): string {
  if (mode === "kanban") return t("workspace.mode.kanban");
  if (mode === "canvas") return t("workspace.mode.canvas");
  return t("workspace.mode.panes");
}

function isWorkspaceViewMode(value: string): value is WorkspaceViewMode {
  return value === "panes" || value === "kanban" || value === "canvas";
}

function useHomeDir(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((h) => {
        if (!cancelled) setHome(h.replace(/\/+$/, ""));
      })
      .catch(() => {
        if (!cancelled) setHome(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return home;
}

function tildify(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function toAgentTokenProvider(
  provider: ReturnType<typeof resolveSessionAgentProvider>,
): AgentTokenProvider | null {
  return providerSupportsTokenUsage(provider) ? provider : null;
}

interface MemorySnapshot {
  bytes: number;
  processes: MemoryProcess[];
}

const getCoalescedMemoryUsage = createInFlightCoalescer(() =>
  api.getMemoryUsage(),
);
const getCoalescedAgentTokenUsage = createInFlightCoalescer(() =>
  api.getAgentTokenUsage(),
);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  const fixed = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[i]}`;
}

function useMemoryUsage(
  intervalMs: number,
  enabled: boolean,
): MemorySnapshot | null {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Drop any stale reading when the user hides the memory readout so
      // the breakdown modal cannot reopen with an outdated process list.
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const usage = await getCoalescedMemoryUsage();
        if (!cancelled) {
          setSnapshot({ bytes: usage.bytes, processes: usage.processes });
        }
      } catch {
        if (!cancelled) setSnapshot(null);
      }
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs, enabled]);

  return snapshot;
}

function useAgentTokenUsage(
  intervalMs: number,
  enabled: boolean,
): AgentTokenUsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<AgentTokenUsageSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const usage = await getCoalescedAgentTokenUsage();
        if (!cancelled) setSnapshot(usage);
      } catch {
        if (!cancelled) setSnapshot(null);
      }
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs, enabled]);

  return snapshot;
}

// GitHub octocat mark — lucide-react has no brand glyphs, so inline the
// official Mark path. `currentColor` lets the surrounding text style it.
function GitHubMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={11}
      height={11}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function StatusBar() {
  const t = useTranslation();
  const {
    sessions,
    activeSessionId,
    activeProject,
    error,
    loading,
    workspaceViewMode,
  } = useAppStore();
  const setWorkspaceViewMode = useAppStore((s) => s.setWorkspaceViewMode);
  const multiInputEnabled = useAppStore((s) => s.multiInputEnabled);
  const prAccountByRepo = useAppStore((s) => s.prAccountByRepo);
  const showSessionCount = useSettings(
    (s) => s.settings.statusBar.showSessionCount,
  );
  const showSessionStatus = useSettings(
    (s) => s.settings.statusBar.showSessionStatus,
  );
  const showSessionActivity = useSettings(
    (s) => s.settings.statusBar.showSessionActivity !== false,
  );
  const showGithubAccount = useSettings(
    (s) => s.settings.statusBar.showGithubAccount,
  );
  const showWorkingDirectory = useSettings(
    (s) => s.settings.statusBar.showWorkingDirectory,
  );
  const showAgentTokenUsage = useSettings(
    (s) => s.settings.statusBar.showAgentTokenUsage,
  );
  const showMemory = useSettings((s) => s.settings.statusBar.showMemory);
  const active = sessions.find((s) => s.id === activeSessionId);
  const activeTokenProvider: AgentTokenProvider | null = active
    ? toAgentTokenProvider(resolveSessionAgentProvider(active))
    : null;
  const showActiveAgentTokenUsage =
    showAgentTokenUsage && activeTokenProvider !== null;
  const memory = useMemoryUsage(MEMORY_POLL_MS, showMemory);
  const tokenUsage = useAgentTokenUsage(
    TOKEN_USAGE_POLL_MS,
    showActiveAgentTokenUsage,
  );
  const home = useHomeDir();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const displayPath = active ? tildify(active.worktree_path, home) : null;
  // The PR-tab account map is keyed by the same repoPath we hand to the PRs
  // tab — prefer the active session's worktree (matches what was probed),
  // then fall back to the active project root.
  const prAccountKey = active?.worktree_path ?? activeProject ?? null;
  const prAccount = prAccountKey ? prAccountByRepo[prAccountKey] ?? null : null;
  const workspaceModeText = workspaceViewLabel(t, workspaceViewMode);
  const workspaceViewOptions: SelectOption[] = [
    {
      value: "panes",
      label: workspaceViewLabel(t, "panes"),
      icon: <Columns3 size={12} />,
    },
    {
      value: "kanban",
      label: workspaceViewLabel(t, "kanban"),
      icon: <Kanban size={12} />,
    },
    {
      value: "canvas",
      label: workspaceViewLabel(t, "canvas"),
      icon: <Scan size={12} />,
    },
  ];

  return (
    <>
      {/* `overflow-hidden` + `whitespace-nowrap` on inline children keeps
          the bar at the configured status-bar height even at narrow widths.
          Without it, the branch text wraps inside its span, the row grows
          to two lines, and Terminal's ResizeObserver fires SIGWINCH
          mid-claude-launch — which leaves cursor/cells offset until a
          tab-switch refit. */}
      <footer className="flex h-[var(--acorn-status-bar-height)] shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-bg-sidebar px-3 font-mono text-xs text-fg-muted">
        {/* Left: aggregate counters about acorn itself — total sessions and
            the active session's lifecycle status. The IPC and daemon
            buttons sit first so the user can recover from a dead
            control-session socket or a stopped daemon without leaving
            the main view. */}
        <ServicesStatusButton />
        {showSessionActivity ? <SessionNotificationsButton /> : null}
        {showSessionCount ? (
          <span className="whitespace-nowrap">
            {statusBarFormat(t, "statusBar.sessionCount", {
              count: sessions.length,
            })}
          </span>
        ) : null}
        {showSessionStatus && active ? (
          <>
            {showSessionCount ? (
              <span className="text-fg-muted/50">|</span>
            ) : null}
            <span
              className="whitespace-nowrap"
              title={sessionStatusDetailLabel(
                t,
                active.status,
                active.status_reason,
                active.agent_status_source,
              )}
            >
              {statusBarFormat(t, "statusBar.status", {
                status: statusBarText(t, SESSION_STATUS_KEYS[active.status]),
              })}
            </span>
          </>
        ) : null}
        {multiInputEnabled ? (
          <>
            {showSessionCount || (showSessionStatus && active) ? (
              <span className="text-fg-muted/50">|</span>
            ) : null}
            <span className="whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 text-accent">
              {statusBarText(t, "statusBar.multiInputOn")}
            </span>
          </>
        ) : null}

        {/* Right: per-active-session context — gh account, branch, working
            directory, memory. Grouped together so the eye scans them as
            "where am I right now?". `min-w-0` lets the truncatable
            children (branch, path) shrink instead of forcing the row
            wider than the footer. */}
        <span className="ml-auto flex min-w-0 items-center gap-3">
          <Select
            data-testid="workspace-view-status"
            value={workspaceViewMode}
            options={workspaceViewOptions}
            placement="top"
            aria-label={statusBarFormat(t, "statusBar.workspaceView", {
              mode: workspaceModeText,
            })}
            onValueChange={(value) => {
              if (isWorkspaceViewMode(value)) setWorkspaceViewMode(value);
            }}
            className={cn(
              "w-[6.25rem] shrink-0",
              "[&>button]:h-5 [&>button]:rounded [&>button]:border-transparent [&>button]:bg-transparent",
              "[&>button]:font-mono [&>button]:text-xs [&>button]:text-fg-muted",
              "[&>button]:hover:bg-bg-elevated [&>button]:hover:text-fg",
              "[&>button]:focus-visible:ring-1 [&>button]:focus-visible:ring-accent/40",
              "[&_[data-select-trigger-icon]]:ml-1 [&_[data-select-trigger-label]]:px-1 [&>button>svg]:mr-1 [&>button>svg]:size-3",
            )}
          />
          {loading ? (
            <span className="whitespace-nowrap">
              {statusBarText(t, "statusBar.working")}
            </span>
          ) : null}
          {error ? (
            <Tooltip label={error} side="top" multiline>
              <span className="truncate whitespace-nowrap text-danger">
                {statusBarFormat(t, "statusBar.error", { error })}
              </span>
            </Tooltip>
          ) : null}
          {showGithubAccount && prAccount ? (
            <Tooltip
              label={statusBarFormat(t, "statusBar.githubAccountTooltip", {
                account: prAccount,
              })}
              side="top"
            >
              <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] text-fg-muted">
                <GitHubMark />
                {prAccount}
              </span>
            </Tooltip>
          ) : null}
          {active ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <span className="min-w-0 truncate whitespace-nowrap">
                {statusBarFormat(t, "statusBar.branch", {
                  branch: active.branch,
                })}
              </span>
            </>
          ) : null}
          {showWorkingDirectory && active && displayPath ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <Tooltip label={active.worktree_path} side="top" multiline>
                <span className="min-w-0 truncate whitespace-nowrap text-right text-fg-muted">
                  {displayPath}
                </span>
              </Tooltip>
            </>
          ) : null}
          {showActiveAgentTokenUsage ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <AgentTokenUsageBadge
                provider={activeTokenProvider}
                snapshot={tokenUsage}
              />
            </>
          ) : null}
          {showMemory ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <Tooltip
                label={statusBarText(t, "statusBar.memoryTooltip")}
                side="top"
              >
                <button
                  type="button"
                  disabled={!memory}
                  onClick={() => setBreakdownOpen(true)}
                  className="whitespace-nowrap rounded px-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                >
                  {statusBarFormat(t, "statusBar.memory", {
                    memory: memory ? formatBytes(memory.bytes) : "-",
                  })}
                </button>
              </Tooltip>
            </>
          ) : null}
        </span>
      </footer>

      <MemoryBreakdownModal
        open={showMemory && breakdownOpen && memory !== null}
        totalBytes={memory?.bytes ?? 0}
        processes={memory?.processes ?? []}
        onClose={() => setBreakdownOpen(false)}
      />
    </>
  );
}

const TOKEN_WINDOWS: AgentTokenWindow[] = ["five_hour", "weekly"];

function AgentTokenUsageBadge({
  provider,
  snapshot,
}: {
  provider: AgentTokenProvider;
  snapshot: AgentTokenUsageSnapshot | null;
}) {
  const t = useTranslation();
  const summary = renderAgentTokenSummary(snapshot, provider, t);
  const tooltip = renderAgentTokenTooltip(snapshot, provider, t);

  return (
    <Tooltip label={tooltip} side="top" multiline>
      <span
        data-testid="agent-token-usage"
        className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 text-fg-muted"
      >
        <AgentProviderIcon provider={provider} />
        {summary}
      </span>
    </Tooltip>
  );
}

function renderAgentTokenSummary(
  snapshot: AgentTokenUsageSnapshot | null,
  provider: AgentTokenProvider,
  t: Translator,
): ReactNode {
  if (!snapshot) {
    return statusBarFormat(t, "statusBar.agentTokens", {
      summary: statusBarText(t, "statusBar.agentTokensUnavailable"),
    });
  }

  const fiveHour = tokenMetric(snapshot, provider, "five_hour");
  const weekly = tokenMetric(snapshot, provider, "weekly");
  const fiveHourText = formatRemainingPercent(fiveHour);
  const weeklyText = formatRemainingPercent(weekly);
  if (!fiveHourText && !weeklyText) {
    return statusBarFormat(t, "statusBar.agentTokens", {
      summary: statusBarText(t, "statusBar.agentTokensNoData"),
    });
  }
  return (
    <>
      <span>{agentTokensPrefix(t)}</span>
      <span className="inline-flex items-center gap-2">
        <TokenWindowReadout label="5h" value={fiveHourText ?? "-"} />
        <TokenWindowReadout label="w" value={weeklyText ?? "-"} />
      </span>
    </>
  );
}

function agentTokensPrefix(t: Translator): string {
  const template = statusBarText(t, "statusBar.agentTokens");
  const prefix = template.replace(/\s*\{summary\}\s*/g, "").trim();
  return prefix || "tokens:";
}

function TokenWindowReadout({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="rounded border border-fg-muted/25 bg-fg-muted/10 px-1 py-px text-[9px] font-semibold leading-none text-fg-muted">
        {label}
      </span>
      <span>{value}</span>
    </span>
  );
}

function renderAgentTokenTooltip(
  snapshot: AgentTokenUsageSnapshot | null,
  provider: AgentTokenProvider,
  t: Translator,
): ReactNode {
  if (!snapshot) {
    return (
      <span className="flex min-w-40 items-center gap-2">
        <Loader2
          size={12}
          aria-hidden="true"
          className="shrink-0 animate-spin text-fg-muted"
        />
        <span>{statusBarText(t, "statusBar.agentTokensUnavailable")}</span>
      </span>
    );
  }

  return (
    <span className="flex w-64 max-w-full flex-col gap-2">
      {TOKEN_WINDOWS.map((window) => {
        const metric = tokenMetric(snapshot, provider, window);
        return (
          <AgentTokenTooltipWindow
            key={window}
            metric={metric}
            observedAt={snapshot.updated_at}
            windowName={windowDisplayName(window, t)}
            t={t}
          />
        );
      })}
      <span className="flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-[10px] leading-none text-fg-muted">
        <Clock size={11} aria-hidden="true" className="shrink-0" />
        <span>
          {statusBarFormat(t, "statusBar.agentTokensUpdated", {
            time: formatUnixTime(snapshot.updated_at),
          })}
        </span>
      </span>
    </span>
  );
}

function AgentTokenTooltipWindow({
  metric,
  observedAt,
  windowName,
  t,
}: {
  metric: AgentTokenUsageMetric | null;
  observedAt: number;
  windowName: string;
  t: Translator;
}) {
  const error =
    metric?.error ??
    (!metric ? statusBarText(t, "statusBar.agentTokensUnavailable") : null);
  const remaining = metric ? (formatRemainingPercent(metric) ?? "-") : "-";
  const reset = metric
    ? formatResetRemaining(metric.reset_at, observedAt, t)
    : statusBarText(t, "statusBar.agentTokensResetUnknown");

  return (
    <span className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border/70 bg-bg/60",
          error ? "text-danger" : "text-fg-muted",
        )}
      >
        {error ? <AlertCircle size={12} /> : <Gauge size={12} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="mb-1 inline-flex rounded border border-fg-muted/25 bg-fg-muted/10 px-1 py-px text-[9px] font-semibold leading-none text-fg-muted">
          {windowName}
        </span>
        {error ? (
          <span className="block break-words text-[11px] leading-snug text-danger">
            {error}
          </span>
        ) : (
          <span className="flex flex-col gap-0.5 text-[11px] leading-snug">
            <span className="font-medium text-fg">
              {statusBarFormat(t, "statusBar.agentTokensRemaining", {
                remaining,
              })}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1 text-fg-muted">
              <Clock size={10} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">
                {statusBarFormat(t, "statusBar.agentTokensResetIn", {
                  reset,
                })}
              </span>
            </span>
          </span>
        )}
      </span>
    </span>
  );
}

function tokenMetric(
  snapshot: AgentTokenUsageSnapshot,
  provider: AgentTokenProvider,
  window: AgentTokenWindow,
): AgentTokenUsageMetric | null {
  return (
    snapshot.metrics.find(
      (metric) => metric.provider === provider && metric.window === window,
    ) ?? null
  );
}

function windowDisplayName(window: AgentTokenWindow, t: Translator): string {
  return window === "five_hour"
    ? statusBarText(t, "statusBar.agentTokensWindowFiveHour")
    : statusBarText(t, "statusBar.agentTokensWindowWeekly");
}

function formatRemainingPercent(metric: AgentTokenUsageMetric | null): string | null {
  return metric?.remaining_percent === null || metric?.remaining_percent === undefined
    ? null
    : formatPercentValue(metric.remaining_percent);
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const clamped = Math.max(0, Math.min(100, value));
  return Number.isInteger(clamped) ? `${clamped}%` : `${clamped.toFixed(1)}%`;
}

function formatResetRemaining(
  resetAt: number | null,
  observedAt: number,
  t: Translator,
): string {
  if (
    !resetAt ||
    !Number.isFinite(resetAt) ||
    !Number.isFinite(observedAt)
  ) {
    return statusBarText(t, "statusBar.agentTokensResetUnknown");
  }
  const remainingSeconds = Math.max(0, resetAt - observedAt);
  return formatDuration(remainingSeconds);
}

function formatDuration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 0) return "0m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatUnixTime(value: number): string {
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return date.toLocaleString([], {
    month: sameDay ? undefined : "numeric",
    day: sameDay ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Combined indicator for the in-process IPC server + the out-of-process
// `acornd` daemon. Both signals collapse into a single status-bar slot
// (the dot's color = worst-of-two) and expand into a dropdown on click
// so the user can read each service's state and act on it. Inline
// restart for IPC stays; daemon restart still routes through Settings
// (one click in the dropdown jumps there) because killing the daemon
// drops every persisted PTY.
interface IpcSnapshot {
  running: boolean | null;
  busy: boolean;
  lastError: string | null;
}

interface DaemonSnapshot {
  running: boolean;
  enabled: boolean;
  sessions: number | null;
}

type DotState = "ok" | "down" | "muted";

const NOTIFICATION_KIND_KEYS: Record<
  SessionNotificationKind,
  StatusBarTranslationKey
> = {
  waiting_for_input: "statusBar.notifications.kind.waitingForInput",
  errored: "statusBar.notifications.kind.errored",
};

function SessionNotificationsButton() {
  const t = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const notifications = useAppStore((s) => s.sessionNotifications);
  const unreadCount = notifications.filter((notification) => !notification.readAt)
    .length;
  const tooltip =
    unreadCount > 0
      ? statusBarFormat(t, "statusBar.notifications.tooltipWithCount", {
          count: unreadCount,
        })
      : statusBarText(t, "statusBar.notifications.tooltipEmpty");

  return (
    <>
      <Tooltip label={tooltip} side="top">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={statusBarText(t, "statusBar.notifications.ariaLabel")}
          className={cn(
            "relative flex h-5 items-center gap-1.5 rounded px-1.5 transition",
            "hover:bg-bg-elevated",
            unreadCount > 0 ? "text-warning" : "text-fg-muted",
          )}
        >
          <Bell size={12} />
          {unreadCount > 0 ? (
            <span className="min-w-3 rounded-full bg-warning px-1 text-center text-[9px] leading-3 text-bg-sidebar">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </button>
      </Tooltip>
      {open ? (
        <SessionNotificationsDropdown
          anchor={triggerRef.current}
          onClose={() => setOpen(false)}
          notifications={notifications}
        />
      ) : null}
    </>
  );
}

interface SessionNotificationsDropdownProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  notifications: SessionNotification[];
}

function SessionNotificationsDropdown({
  anchor,
  onClose,
  notifications,
}: SessionNotificationsDropdownProps) {
  const t = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const unreadCount = notifications.filter((notification) => !notification.readAt)
    .length;
  const markAllRead = useAppStore((s) => s.markAllSessionNotificationsRead);
  const clearRead = useAppStore((s) => s.clearReadSessionNotifications);

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      left: rect.left,
      bottom: Math.max(8, window.innerHeight - rect.top + 6),
    });
  }, [anchor]);

  useLayoutEffect(() => {
    if (!ref.current || !position) return;
    const rect = ref.current.getBoundingClientRect();
    const overflowRight = position.left + rect.width - (window.innerWidth - 8);
    if (overflowRight > 0) {
      setPosition((p) => (p ? { ...p, left: Math.max(8, p.left - overflowRight) } : p));
    }
  }, [position]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      if (anchor && anchor.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  if (!position) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: position.left,
        bottom: position.bottom,
        zIndex: 60,
      }}
      className="flex max-h-[420px] w-96 flex-col overflow-hidden rounded-md border border-border bg-bg-elevated shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="font-mono text-xs text-fg">
            {statusBarText(t, "statusBar.notifications.title")}
          </div>
          <div className="font-mono text-[10px] text-fg-muted">
            {statusBarFormat(t, "statusBar.notifications.unreadCount", {
              count: unreadCount,
            })}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip
            label={statusBarText(t, "statusBar.notifications.actions.markAllRead")}
            side="top"
          >
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="rounded p-1 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              <CheckCheck size={13} />
            </button>
          </Tooltip>
          <Tooltip
            label={statusBarText(t, "statusBar.notifications.actions.clearRead")}
            side="top"
          >
            <button
              type="button"
              onClick={clearRead}
              disabled={notifications.every((notification) => !notification.readAt)}
              className="rounded p-1 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              <Trash2 size={13} />
            </button>
          </Tooltip>
        </div>
      </div>
      {notifications.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-fg-muted">
          {statusBarText(t, "statusBar.notifications.empty")}
        </div>
      ) : (
        <ul className="min-h-0 overflow-y-auto">
          {notifications.map((notification) => (
            <li key={notification.id}>
              <NotificationRow
                notification={notification}
                onClose={onClose}
              />
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

function NotificationRow({
  notification,
  onClose,
}: {
  notification: SessionNotification;
  onClose: () => void;
}) {
  const t = useTranslation();
  const openSessionSurface = useAppStore((s) => s.openSessionSurface);
  const markRead = useAppStore((s) => s.markSessionNotificationRead);
  const dismiss = useAppStore((s) => s.dismissSessionNotification);
  const unread = !notification.readAt;

  const openSession = () => {
    markRead(notification.id);
    openSessionSurface(notification.sessionId);
    onClose();
  };

  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={openSession}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openSession();
      }}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2 border-b border-border/70 px-3 py-2 text-left transition last:border-b-0",
        "hover:bg-bg-sidebar",
        unread && "bg-warning/5",
      )}
    >
      <span
        className={cn(
          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
          notificationDotClass(notification.kind),
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate font-mono text-[11px]",
              unread ? "text-fg" : "text-fg-muted",
            )}
          >
            {statusBarText(t, NOTIFICATION_KIND_KEYS[notification.kind])}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-fg-muted/70">
            {formatNotificationTime(notification.createdAt)}
          </span>
        </span>
        <span className="block truncate text-[11px] text-fg">
          {statusBarFormat(t, "statusBar.notifications.itemTitle", {
            project: notification.projectName,
            session: notification.sessionName,
          })}
        </span>
        <span className="block truncate text-[10px] text-fg-muted">
          {notification.repoPath}
        </span>
      </span>
      <span
        role="button"
        tabIndex={0}
        aria-label={statusBarText(t, "statusBar.notifications.actions.dismiss")}
        onClick={(event) => {
          event.stopPropagation();
          dismiss(notification.id);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          dismiss(notification.id);
        }}
        className="rounded p-1 text-fg-muted opacity-0 transition hover:bg-bg-elevated hover:text-fg group-hover:opacity-100"
      >
        <X size={12} />
      </span>
    </div>
  );
}

function notificationDotClass(kind: SessionNotificationKind): string {
  if (kind === "errored") return "bg-danger";
  return "bg-warning";
}

function formatNotificationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dotStateTone(state: DotState): StatusTone {
  switch (state) {
    case "ok":
      return "accent";
    case "down":
      return "danger";
    case "muted":
      return "neutral";
  }
}

function ServicesStatusButton() {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pollInFlightRef = useRef<Promise<void> | null>(null);
  const [open, setOpen] = useState(false);

  const [ipc, setIpc] = useState<IpcSnapshot>({
    running: null,
    busy: false,
    lastError: null,
  });
  const [daemon, setDaemon] = useState<DaemonSnapshot | null>(null);

  const refreshIpc = useCallback(async () => {
    try {
      const status = await api.getAcornIpcStatus();
      setIpc((s) => ({ ...s, running: status.server_running }));
    } catch {
      setIpc((s) => ({ ...s, running: false }));
    }
  }, []);

  const refreshDaemon = useCallback(async () => {
    try {
      const snap = await api.daemonStatus();
      setDaemon({
        running: snap.running,
        enabled: snap.enabled,
        sessions: snap.session_count_alive,
      });
    } catch {
      setDaemon({ running: false, enabled: true, sessions: null });
    }
  }, []);

  useEffect(() => {
    const poll = () => {
      if (pollInFlightRef.current) return;
      const promise = Promise.all([refreshIpc(), refreshDaemon()])
        .then(() => undefined)
        .finally(() => {
          if (pollInFlightRef.current === promise) {
            pollInFlightRef.current = null;
          }
        });
      pollInFlightRef.current = promise;
    };

    poll();
    // Daemon socket round-trip every 5s; IPC probe piggy-backs on
    // the same cadence so both reads share one tick budget.
    const id = window.setInterval(poll, 5_000);
    return () => window.clearInterval(id);
  }, [refreshIpc, refreshDaemon]);

  const restartIpc = useCallback(async () => {
    if (ipc.busy) return;
    setIpc((s) => ({ ...s, busy: true, lastError: null }));
    try {
      await api.ipcRestart();
      await refreshIpc();
      setIpc((s) => ({ ...s, busy: false }));
      showToast(t("toasts.ipc.restarted"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await refreshIpc();
      setIpc((s) => ({ ...s, busy: false, lastError: msg }));
      showToast(`${t("toasts.ipc.restartFailed")} ${msg}`);
    }
  }, [ipc.busy, refreshIpc, showToast, t]);

  const openDaemonSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("acorn:open-settings", { detail: { tab: "sessions" } }),
    );
    setOpen(false);
  }, []);

  // Worst-of-two for the trigger dot — any down service paints red so
  // the user notices something needs attention without expanding.
  const aggregate: DotState = (() => {
    const ipcDown = ipc.running === false;
    const daemonDown = daemon !== null && daemon.enabled && !daemon.running;
    if (ipcDown || daemonDown) return "down";
    if (ipc.running === null || daemon === null) return "muted";
    return "ok";
  })();

  const ipcDotState: DotState =
    ipc.running === null ? "muted" : ipc.running ? "ok" : "down";
  const daemonDotState: DotState = (() => {
    if (daemon === null) return "muted";
    if (!daemon.enabled) return "muted";
    return daemon.running ? "ok" : "down";
  })();
  const tooltip = renderServicesTooltip(
    ipc,
    daemon,
    ipcDotState,
    daemonDotState,
    t,
  );

  return (
    <>
      <Tooltip label={tooltip} side="top" multiline>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={statusBarText(t, "statusBar.services.ariaLabel")}
          className={cn(
            "flex h-5 items-center gap-1.5 rounded px-1.5 transition",
            "hover:bg-bg-elevated",
            aggregate === "ok"
              ? "text-accent"
              : aggregate === "down"
                ? "text-danger"
                : "text-fg-muted",
          )}
        >
          <Activity size={12} />
          <StatusDot tone={dotStateTone(aggregate)} size="sm" />
        </button>
      </Tooltip>
      {open ? (
        <ServicesDropdown
          anchor={triggerRef.current}
          onClose={() => setOpen(false)}
          ipc={ipc}
          ipcDotState={ipcDotState}
          daemon={daemon}
          daemonDotState={daemonDotState}
          onRestartIpc={() => void restartIpc()}
          onOpenDaemonSettings={openDaemonSettings}
        />
      ) : null}
    </>
  );
}

function renderServicesTooltip(
  ipc: IpcSnapshot,
  daemon: DaemonSnapshot | null,
  ipcDotState: DotState,
  daemonDotState: DotState,
  t: Translator,
): ReactNode {
  const ipcStatusText =
    ipc.running === null
      ? statusBarText(t, "statusBar.services.status.loading")
      : ipc.running
        ? statusBarText(t, "statusBar.services.status.running")
        : statusBarText(t, "statusBar.services.status.down");
  const daemonStatusText =
    daemon === null
      ? statusBarText(t, "statusBar.services.status.loading")
      : !daemon.enabled
        ? statusBarText(t, "statusBar.services.status.disabled")
        : daemon.running
          ? daemon.sessions !== null
            ? statusBarFormat(
                t,
                "statusBar.services.status.runningSessions",
                { count: daemon.sessions },
              )
            : statusBarText(t, "statusBar.services.status.running")
          : statusBarText(t, "statusBar.services.status.down");

  return (
    <span className="flex w-56 max-w-full flex-col gap-1.5">
      <ServiceTooltipRow
        icon={<Activity size={12} />}
        label={statusBarText(t, "statusBar.services.ipc.label")}
        value={ipcStatusText}
        dot={ipcDotState}
      />
      <ServiceTooltipRow
        icon={<Gauge size={12} />}
        label={statusBarText(t, "statusBar.services.daemon.label")}
        value={daemonStatusText}
        dot={daemonDotState}
      />
      <span className="flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-[10px] leading-none text-fg-muted">
        <Settings size={11} aria-hidden="true" className="shrink-0" />
        <span>{statusBarText(t, "statusBar.services.tooltip.detailsHint")}</span>
      </span>
    </span>
  );
}

function ServiceTooltipRow({
  icon,
  label,
  value,
  dot,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  dot: DotState;
}) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border/70 bg-bg/60",
          dot === "ok"
            ? "text-accent"
            : dot === "down"
              ? "text-danger"
              : "text-fg-muted",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] leading-3 text-fg-muted">
          {label}
        </span>
        <span className="block min-w-0 break-words text-[11px] leading-snug text-fg">
          {value}
        </span>
      </span>
    </span>
  );
}

interface ServicesDropdownProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  ipc: IpcSnapshot;
  ipcDotState: DotState;
  daemon: DaemonSnapshot | null;
  daemonDotState: DotState;
  onRestartIpc: () => void;
  onOpenDaemonSettings: () => void;
}

function ServicesDropdown({
  anchor,
  onClose,
  ipc,
  ipcDotState,
  daemon,
  daemonDotState,
  onRestartIpc,
  onOpenDaemonSettings,
}: ServicesDropdownProps) {
  const t = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Bottom-anchored: dropdown opens above the status bar trigger.
    setPosition({
      left: rect.left,
      bottom: Math.max(8, window.innerHeight - rect.top + 6),
    });
  }, [anchor]);

  useLayoutEffect(() => {
    if (!ref.current || !position) return;
    // Clamp horizontally so the menu does not run off the right edge.
    const rect = ref.current.getBoundingClientRect();
    const overflowRight = position.left + rect.width - (window.innerWidth - 8);
    if (overflowRight > 0) {
      setPosition((p) => (p ? { ...p, left: Math.max(8, p.left - overflowRight) } : p));
    }
    // intentional: this effect re-measures only when the menu first mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      if (anchor && anchor.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  if (!position) return null;

  const ipcStatusText =
    ipc.running === null
      ? statusBarText(t, "statusBar.services.status.loading")
      : ipc.running
        ? statusBarText(t, "statusBar.services.status.running")
        : statusBarText(t, "statusBar.services.status.down");
  const daemonStatusText =
    daemon === null
      ? statusBarText(t, "statusBar.services.status.loading")
      : !daemon.enabled
        ? statusBarText(t, "statusBar.services.status.disabled")
        : daemon.running
          ? daemon.sessions !== null
            ? statusBarFormat(
                t,
                "statusBar.services.status.runningSessions",
                { count: daemon.sessions },
              )
            : statusBarText(t, "statusBar.services.status.running")
          : statusBarText(t, "statusBar.services.status.down");

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: position.left, bottom: position.bottom, zIndex: 60 }}
      className="w-64 overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated shadow-2xl"
    >
      <ul className="divide-y divide-border text-[11px]">
        <li>
          <ServiceRow
            label={statusBarText(t, "statusBar.services.ipc.label")}
            description={statusBarText(
              t,
              "statusBar.services.ipc.description",
            )}
            dot={ipcDotState}
            statusText={ipcStatusText}
            actionLabel={
              ipc.busy
                ? statusBarText(t, "statusBar.services.actions.restarting")
                : statusBarText(t, "statusBar.services.actions.restart")
            }
            actionIcon={
              ipc.busy ? <Loader2 size={11} className="animate-spin" /> : null
            }
            actionDisabled={ipc.busy}
            onAction={onRestartIpc}
            error={ipc.lastError}
          />
        </li>
        <li>
          <ServiceRow
            label={statusBarText(t, "statusBar.services.daemon.label")}
            description={statusBarText(
              t,
              "statusBar.services.daemon.description",
            )}
            dot={daemonDotState}
            statusText={daemonStatusText}
            actionLabel={statusBarText(
              t,
              "statusBar.services.actions.settings",
            )}
            actionIcon={<Settings size={11} />}
            actionDisabled={false}
            onAction={onOpenDaemonSettings}
            error={null}
          />
        </li>
      </ul>
    </div>,
    document.body,
  );
}

interface ServiceRowProps {
  label: string;
  description: string;
  dot: DotState;
  statusText: string;
  actionLabel: string;
  actionIcon: React.ReactNode | null;
  actionDisabled: boolean;
  onAction: () => void;
  error: string | null;
}

function ServiceRow({
  label,
  description,
  dot,
  statusText,
  actionLabel,
  actionIcon,
  actionDisabled,
  onAction,
  error,
}: ServiceRowProps) {
  // Two stacked rows: text on top, action button right-aligned below.
  // Inline action next to the text wraps "running · N sessions" on
  // the 256px dropdown.
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <StatusDot tone={dotStateTone(dot)} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] text-fg">{label}</div>
          <div className="font-mono text-[10px] text-fg-muted">{statusText}</div>
          <div className="text-[10px] text-fg-muted/80">{description}</div>
          {error ? (
            <div className="mt-0.5 break-words text-[10px] text-danger">
              {error}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] transition",
            "hover:bg-bg-sidebar disabled:cursor-default disabled:opacity-60",
          )}
        >
          {actionIcon}
          <span>{actionLabel}</span>
        </button>
      </div>
    </div>
  );
}
