import {
  Power,
  RefreshCcw,
  Loader2,
  AlertTriangle,
  Bot,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type DaemonSessionSummary, type DaemonStatus } from "../lib/api";
import { cn } from "../lib/cn";
import type { Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import type { Session } from "../lib/types";
import { useToasts } from "../lib/toasts";
import { Tooltip } from "./Tooltip";
import { CheckboxRow, Field } from "./ui";

type BackgroundSessionsTranslator = Translator;

/**
 * Settings panel for the `acornd` daemon — live status, killswitch
 * toggle, restart / quit affordances, and the daemon's tracked PTY
 * list. The killswitch is persisted in `localStorage` under
 * `acorn:daemon-enabled` (UI-state convention per CLAUDE.md);
 * `api.daemonSetEnabled` mirrors the runtime-active value into the
 * backend.
 */
export function BackgroundSessionsSettings() {
  const t = useTranslation();
  const [enabled, setEnabledLocal] = useState<boolean>(() => readKillswitch());
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [sessions, setSessions] = useState<DaemonSessionSummary[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const appSessions = useAppStore((s) => s.sessions);
  const showToast = useToasts((s) => s.show);

  const refresh = useCallback(async () => {
    try {
      const snap = await api.daemonStatus();
      setStatus(snap);
      setStatusError(null);
      if (snap.running) {
        try {
          const list = await api.daemonListSessions();
          setSessions(list.filter((session) => session.alive));
        } catch (err) {
          // List failure is non-fatal — keep showing the status panel.
          // eslint-disable-next-line no-console
          console.warn("[bg-sessions] list failed", err);
        }
      } else {
        setSessions(null);
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setEnabledLocal(next);
      writeKillswitch(next);
      try {
        await api.daemonSetEnabled(next);
        showToast(
          next
            ? t("backgroundSessions.toasts.enabled")
            : t("backgroundSessions.toasts.disabled"),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatusError(message);
        showToast(`${t("backgroundSessions.toasts.toggleFailed")} ${message}`);
      }
      void refresh();
    },
    [refresh, showToast, t],
  );

  const handleRestart = useCallback(async () => {
    setBusy("restart");
    setStatusError(null);
    try {
      await api.daemonRestart();
      await refresh();
      showToast(t("backgroundSessions.toasts.restarted"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message);
      showToast(`${t("backgroundSessions.toasts.restartFailed")} ${message}`);
    } finally {
      setBusy(null);
    }
  }, [refresh, showToast, t]);

  const handleShutdown = useCallback(async () => {
    setBusy("shutdown");
    setStatusError(null);
    try {
      await api.daemonShutdown();
      setConfirmShutdown(false);
      await refresh();
      showToast(t("backgroundSessions.toasts.shutdown"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message);
      showToast(`${t("backgroundSessions.toasts.shutdownFailed")} ${message}`);
    } finally {
      setBusy(null);
    }
  }, [refresh, showToast, t]);

  const handleForgetInactiveSessions = useCallback(async () => {
    setBusy("forget-inactive");
    setStatusError(null);
    try {
      const count = await api.daemonForgetInactiveSessions();
      await refresh();
      showToast(
        count > 0
          ? t("backgroundSessions.toasts.inactiveCleared")
          : t("backgroundSessions.toasts.inactiveNone"),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message);
      showToast(
        `${t("backgroundSessions.toasts.inactiveClearFailed")} ${message}`,
      );
    } finally {
      setBusy(null);
    }
  }, [refresh, showToast, t]);

  const running = status?.running ?? false;
  const inactiveSessionCount =
    typeof status?.session_count_total === "number" &&
    typeof status?.session_count_alive === "number"
      ? Math.max(0, status.session_count_total - status.session_count_alive)
      : 0;
  const indicator = !enabled
    ? {
        label: t("backgroundSessions.status.disabled"),
        className: "text-fg-muted",
      }
    : running
      ? {
          label: t("backgroundSessions.status.running"),
          className: "text-accent",
        }
      : {
          label: t("backgroundSessions.status.down"),
          className: "text-danger",
        };

  return (
    <section className="space-y-4">
      <Field
        label={t("backgroundSessions.daemon.label")}
        hint={t("backgroundSessions.daemon.hint")}
      >
        <CheckboxRow
          checked={enabled}
          onChange={(v) => void handleToggle(v)}
          label={t("backgroundSessions.daemon.enableLabel")}
          description={
            enabled
              ? t("backgroundSessions.daemon.enabledDescription")
              : t("backgroundSessions.daemon.disabledDescription")
          }
        />
      </Field>

      <Field
        label={t("backgroundSessions.status.label")}
        hint={t("backgroundSessions.status.hint")}
      >
        <div className="rounded border border-border bg-bg-elevated p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className={cn("font-medium", indicator.className)}>
              ● {indicator.label}
            </span>
            {status?.daemon_version ? (
              <span className="text-fg-muted">v{status.daemon_version}</span>
            ) : null}
            {status?.uptime_seconds !== null &&
            status?.uptime_seconds !== undefined ? (
              <span className="text-fg-muted">
                · {t("backgroundSessions.status.up")}{" "}
                {formatDuration(status.uptime_seconds)}
              </span>
            ) : null}
            {status?.session_count_total !== null &&
            status?.session_count_total !== undefined ? (
              <span className="text-fg-muted">
                · {t("backgroundSessions.status.sessions")}{" "}
                {status.session_count_alive ?? 0}/{status.session_count_total}
              </span>
            ) : null}
          </div>
          {status?.log_path ? (
            <div className="mt-2 text-fg-muted">
              {t("backgroundSessions.status.log")}:{" "}
              <code className="font-mono">{status.log_path}</code>
            </div>
          ) : null}
          {statusError ? (
            <div className="mt-2 flex items-start gap-1 text-danger">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="font-mono">{statusError}</span>
            </div>
          ) : null}
        </div>
      </Field>

      <Field
        label={t("backgroundSessions.controls.label")}
        hint={t("backgroundSessions.controls.hint")}
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleRestart()}
            disabled={!enabled || busy !== null}
            className={cn(
              "flex items-center gap-1 rounded border border-border bg-bg-elevated px-2.5 py-1 text-xs transition",
              "hover:bg-bg-elevated/70 disabled:cursor-default disabled:opacity-50",
            )}
          >
            {busy === "restart" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCcw size={12} />
            )}
            <span>{t("backgroundSessions.controls.restart")}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleForgetInactiveSessions()}
            disabled={
              !enabled || !running || inactiveSessionCount === 0 || busy !== null
            }
            title={t("backgroundSessions.controls.clearInactiveTooltip")}
            className={cn(
              "flex items-center gap-1 rounded border border-border bg-bg-elevated px-2.5 py-1 text-xs transition",
              "hover:bg-bg-elevated/70 disabled:cursor-default disabled:opacity-50",
            )}
          >
            {busy === "forget-inactive" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
            <span>{t("backgroundSessions.controls.clearInactive")}</span>
          </button>
          {confirmShutdown ? (
            <div className="flex items-center gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">
              <span>
                {t("backgroundSessions.controls.confirmShutdownPrompt")}
              </span>
              <button
                type="button"
                onClick={() => void handleShutdown()}
                disabled={busy !== null}
                className="rounded bg-danger px-2 py-0.5 font-medium text-bg disabled:opacity-50"
              >
                {busy === "shutdown" ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  t("backgroundSessions.controls.confirm")
                )}
              </button>
              <button
                type="button"
                onClick={() => setConfirmShutdown(false)}
                disabled={busy !== null}
                className="px-2 py-0.5 hover:text-fg"
              >
                {t("backgroundSessions.controls.cancel")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmShutdown(true)}
              disabled={!enabled || !running || busy !== null}
              className={cn(
                "flex items-center gap-1 rounded border border-border bg-bg-elevated px-2.5 py-1 text-xs text-danger transition",
                "hover:bg-bg-elevated/70 disabled:cursor-default disabled:opacity-50",
              )}
            >
              <Power size={12} />
              <span>{t("backgroundSessions.controls.quit")}</span>
            </button>
          )}
        </div>
      </Field>

      <Field
        label={t("backgroundSessions.sessions.label")}
        hint={t("backgroundSessions.sessions.hint")}
      >
        <SessionsList
          sessions={sessions}
          enabled={enabled}
          running={running}
          onRefresh={refresh}
          appSessions={appSessions}
          t={t}
        />
      </Field>
    </section>
  );
}

function SessionsList({
  sessions,
  enabled,
  running,
  onRefresh,
  appSessions,
  t,
}: {
  sessions: DaemonSessionSummary[] | null;
  enabled: boolean;
  running: boolean;
  onRefresh: () => Promise<void>;
  appSessions: Session[];
  t: BackgroundSessionsTranslator;
}) {
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const showToast = useToasts((s) => s.show);
  const refreshAll = useAppStore((s) => s.refreshAll);
  const selectSession = useAppStore((s) => s.selectSession);
  const appById = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of appSessions) m.set(s.id, s);
    return m;
  }, [appSessions]);

  const runRowAction = useCallback(
    async (id: string, fn: () => Promise<void>, successMessage: string) => {
      setRowBusy(id);
      setRowError(null);
      try {
        await fn();
        await onRefresh();
        showToast(successMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRowError(message);
        showToast(
          `${t("backgroundSessions.toasts.sessionActionFailed")} ${message}`,
        );
      } finally {
        setRowBusy(null);
      }
    },
    [onRefresh, showToast, t],
  );

  const restoreSessionToTab = useCallback(
    async (daemonSession: DaemonSessionSummary) => {
      const appSession = appById.get(daemonSession.id);
      setRowBusy(daemonSession.id);
      setRowError(null);
      try {
        if (!appSession) {
          await api.daemonAdoptSession(daemonSession.id);
        }
        await refreshAll();
        selectSession(daemonSession.id);
        if (typeof window !== "undefined") {
          requestAnimationFrame(() => {
            window.dispatchEvent(
              new CustomEvent("acorn:focus-session", {
                detail: { sessionId: daemonSession.id },
              }),
            );
          });
        }
        await onRefresh();
        showToast(t("backgroundSessions.toasts.sessionRestored"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRowError(message);
        showToast(
          `${t("backgroundSessions.toasts.sessionActionFailed")} ${message}`,
        );
      } finally {
        setRowBusy(null);
      }
    },
    [appById, onRefresh, refreshAll, selectSession, showToast, t],
  );

  if (!enabled) {
    return (
      <p className="text-xs text-fg-muted">
        {t("backgroundSessions.sessions.disabled")}
      </p>
    );
  }
  if (!running) {
    return (
      <p className="text-xs text-fg-muted">
        {t("backgroundSessions.sessions.notRunning")}
      </p>
    );
  }
  if (sessions === null) {
    return (
      <p className="text-xs text-fg-muted">
        {t("backgroundSessions.sessions.loading")}
      </p>
    );
  }
  if (sessions.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        {t("backgroundSessions.sessions.empty")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded border border-border bg-bg-elevated text-xs">
        {sessions.map((s) => {
          const busy = rowBusy === s.id;
          const app = appById.get(s.id);
          const displayName = sessionDisplayName(app, s);
          const ts = app ? Date.parse(app.updated_at) : Number.NaN;
          return (
            <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
              <span
                className={cn(
                  "font-mono text-[10px]",
                  s.alive ? "text-accent" : "text-fg-muted",
                )}
              >
                {s.alive ? "●" : "○"}
              </span>
              <span className="flex flex-1 items-center gap-1.5 truncate">
                <Tooltip
                  label={renderAppMetaTooltip(app, s, t)}
                  side="top"
                  multiline
                >
                  <span className="truncate cursor-help">{displayName}</span>
                </Tooltip>
                {!Number.isNaN(ts) ? (
                  <Tooltip label={new Date(ts).toLocaleString()} side="top">
                    <span className="shrink-0 cursor-help text-[10px] text-fg-muted">
                      {formatRelativeTime(
                        ts,
                        t("backgroundSessions.relativeTime.ago"),
                      )}
                    </span>
                  </Tooltip>
                ) : null}
                {s.kind === "control" ? (
                  <Tooltip
                    label={t("backgroundSessions.sessions.controlSession")}
                    side="top"
                  >
                    <Bot
                      size={12}
                      className="shrink-0 text-fg-muted"
                      aria-label={t(
                        "backgroundSessions.sessions.controlSession",
                      )}
                    />
                  </Tooltip>
                ) : null}
              </span>
              {s.agent_kind ? (
                <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-fg-muted">
                  {s.agent_kind}
                </span>
              ) : null}
              <div className="flex items-center gap-1">
                <Tooltip
                  label={
                    app
                      ? t("backgroundSessions.actions.openTooltip")
                      : t("backgroundSessions.actions.restoreTooltip")
                  }
                  side="top"
                >
                  <RowButton
                    busy={busy}
                    onClick={() => void restoreSessionToTab(s)}
                    aria-label={t("backgroundSessions.actions.restore")}
                  >
                    <Undo2 size={12} />
                  </RowButton>
                </Tooltip>
                {s.alive ? (
                  <Tooltip
                    label={t("backgroundSessions.actions.killPty")}
                    side="top"
                  >
                    <RowButton
                      busy={busy}
                      onClick={() =>
                        void runRowAction(
                          s.id,
                          () => api.daemonKillSession(s.id),
                          t("backgroundSessions.toasts.sessionKilled"),
                        )
                      }
                      tone="danger"
                      aria-label={t("backgroundSessions.actions.killPty")}
                    >
                      <Power size={12} />
                    </RowButton>
                  </Tooltip>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {rowError ? (
        <div className="flex items-start gap-1 text-xs text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="font-mono">{rowError}</span>
        </div>
      ) : null}
    </div>
  );
}

function formatRelativeTime(timestampMs: number, ago: string): string {
  const diffSec = Math.round((Date.now() - timestampMs) / 1000);
  if (diffSec < 60) return `${Math.max(0, diffSec)}s ${ago}`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ${ago}`;
  const hr = Math.round(diffSec / 3600);
  if (hr < 24) return `${hr}h ${ago}`;
  const day = Math.round(diffSec / 86400);
  if (day < 30) return `${day}d ${ago}`;
  const mo = Math.round(diffSec / (86400 * 30));
  if (mo < 12) return `${mo}mo ${ago}`;
  const yr = Math.round(diffSec / (86400 * 365));
  return `${yr}y ${ago}`;
}

function sessionDisplayName(
  app: Session | undefined,
  daemon: DaemonSessionSummary,
): string {
  const appName = app?.name.trim();
  if (appName) return appName;

  const daemonName = daemon.name.trim();
  if (daemonName && daemonName !== daemon.id && !isUuidLike(daemonName)) {
    return daemonName;
  }

  const pathName = basenamePath(daemon.cwd ?? daemon.repo_path ?? "");
  if (pathName && daemon.branch) return `${pathName} · ${daemon.branch}`;
  if (pathName) return pathName;
  return daemonName || daemon.id;
}

function basenamePath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function renderAppMetaTooltip(
  app: Session | undefined,
  daemon: DaemonSessionSummary,
  t: BackgroundSessionsTranslator,
) {
  const rows: { label: string; value: string }[] = [];
  if (app) {
    rows.push({ label: t("backgroundSessions.metadata.tab"), value: app.name });
    if (app.branch) {
      rows.push({
        label: t("backgroundSessions.metadata.branch"),
        value: app.branch,
      });
    }
    rows.push({
      label: t("backgroundSessions.metadata.status"),
      value: app.status,
    });
    if (app.worktree_path) {
      rows.push({
        label: t("backgroundSessions.metadata.worktree"),
        value: app.worktree_path,
      });
    }
    if (app.last_message) {
      rows.push({
        label: t("backgroundSessions.metadata.last"),
        value: app.last_message,
      });
    }
  } else {
    if (daemon.branch) {
      rows.push({
        label: t("backgroundSessions.metadata.branch"),
        value: daemon.branch,
      });
    }
    if (daemon.repo_path) {
      rows.push({
        label: t("backgroundSessions.metadata.repo"),
        value: daemon.repo_path,
      });
    }
    if (daemon.cwd) {
      rows.push({
        label: t("backgroundSessions.metadata.worktree"),
        value: daemon.cwd,
      });
    }
  }
  return (
    <div className="flex flex-col gap-0.5 text-left">
      <div className="font-mono text-[10px] text-fg-muted">{daemon.id}</div>
      {!app ? (
        <div className="text-[10px] italic text-fg-muted">
          {t("backgroundSessions.metadata.orphaned")}
        </div>
      ) : null}
      {rows.map((r) => (
        <div key={r.label} className="flex gap-1.5">
          <span className="text-fg-muted">{r.label}:</span>
          <span className="font-mono break-all">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function RowButton({
  busy,
  onClick,
  children,
  disabled,
  tone,
  "aria-label": ariaLabel,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  tone?: "danger";
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={busy || disabled}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded border border-border bg-bg transition",
        "hover:bg-bg-elevated/70 disabled:cursor-default disabled:opacity-40",
        tone === "danger" ? "text-danger" : "text-fg",
      )}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : children}
    </button>
  );
}

const KILLSWITCH_KEY = "acorn:daemon-enabled";

function readKillswitch(): boolean {
  try {
    const raw = window.localStorage.getItem(KILLSWITCH_KEY);
    if (raw === null) {
      // Default ON so new installs land on the persistent path.
      return true;
    }
    return raw === "true";
  } catch {
    return true;
  }
}

function writeKillswitch(value: boolean): void {
  try {
    window.localStorage.setItem(KILLSWITCH_KEY, String(value));
  } catch {
    // localStorage blocked (private mode / quota) — silently degrade.
    // The runtime-active value is still set on the backend, so the
    // current session reflects the user's choice; only the persistence
    // across restarts is lost.
  }
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}
