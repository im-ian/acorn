import { Power, RefreshCcw, Loader2, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, type DaemonSessionSummary, type DaemonStatus } from "../lib/api";
import { cn } from "../lib/cn";
import { CheckboxRow, Field } from "./ui";

/**
 * Settings tab content for the `acornd` daemon — live status, killswitch
 * toggle, restart / quit affordances, and a listing of every PTY the
 * daemon currently tracks.
 *
 * Persisted state:
 * * Killswitch lives in `localStorage` under `acorn:daemon-enabled` (the
 *   convention for UI state per CLAUDE.md). Backend reflects the
 *   runtime-active value via `api.daemonSetEnabled`.
 * * Tab UI does not re-fetch on every render — a 3-second polling
 *   interval keeps the indicator honest without flooding the daemon.
 */
export function BackgroundSessionsSettings() {
  const [enabled, setEnabledLocal] = useState<boolean>(() => readKillswitch());
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [sessions, setSessions] = useState<DaemonSessionSummary[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const snap = await api.daemonStatus();
      setStatus(snap);
      setStatusError(null);
      if (snap.running) {
        try {
          const list = await api.daemonListSessions();
          setSessions(list);
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
      } catch (err) {
        setStatusError(err instanceof Error ? err.message : String(err));
      }
      void refresh();
    },
    [refresh],
  );

  const handleRestart = useCallback(async () => {
    setBusy("restart");
    setStatusError(null);
    try {
      await api.daemonRestart();
      await refresh();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleShutdown = useCallback(async () => {
    setBusy("shutdown");
    setStatusError(null);
    try {
      await api.daemonShutdown();
      setConfirmShutdown(false);
      await refresh();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const running = status?.running ?? false;
  const indicator = !enabled
    ? { label: "Disabled", className: "text-fg-muted" }
    : running
      ? { label: "Running", className: "text-accent" }
      : { label: "Down", className: "text-danger" };

  return (
    <section className="space-y-4">
      <Field
        label="Daemon"
        hint="The acornd daemon owns long-running terminal sessions. With the daemon on, Acorn can quit and reopen without losing your PTYs. Off falls back to the legacy in-process path — sessions die with the app."
      >
        <CheckboxRow
          checked={enabled}
          onChange={(v) => void handleToggle(v)}
          label="Enable background sessions (acornd)"
          description={
            enabled
              ? "Sessions persist across Acorn restarts until you explicitly quit them."
              : "Sessions are bound to this Acorn process — closing the app kills them."
          }
        />
      </Field>

      <Field
        label="Status"
        hint="Live state of the running daemon. Updates every 3 seconds while this panel is open."
      >
        <div className="rounded border border-border bg-bg-elevated p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className={cn("font-medium", indicator.className)}>
              ● {indicator.label}
            </span>
            {status?.daemon_version ? (
              <span className="text-fg-muted">v{status.daemon_version}</span>
            ) : null}
            {status?.uptime_seconds !== null && status?.uptime_seconds !== undefined ? (
              <span className="text-fg-muted">
                · up {formatDuration(status.uptime_seconds)}
              </span>
            ) : null}
            {status?.session_count_total !== null &&
            status?.session_count_total !== undefined ? (
              <span className="text-fg-muted">
                · sessions {status.session_count_alive ?? 0}/
                {status.session_count_total}
              </span>
            ) : null}
          </div>
          {status?.log_path ? (
            <div className="mt-2 text-fg-muted">
              Log: <code className="font-mono">{status.log_path}</code>
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

      <Field label="Controls" hint="Restart reconnects the bridge — useful after killing the daemon from a terminal. Quit kills every running PTY and exits the daemon.">
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
            <span>Restart daemon</span>
          </button>
          {confirmShutdown ? (
            <div className="flex items-center gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">
              <span>Kill every PTY?</span>
              <button
                type="button"
                onClick={() => void handleShutdown()}
                disabled={busy !== null}
                className="rounded bg-danger px-2 py-0.5 font-medium text-bg disabled:opacity-50"
              >
                {busy === "shutdown" ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  "Confirm"
                )}
              </button>
              <button
                type="button"
                onClick={() => setConfirmShutdown(false)}
                disabled={busy !== null}
                className="px-2 py-0.5 hover:text-fg"
              >
                Cancel
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
              <span>Quit daemon</span>
            </button>
          )}
        </div>
      </Field>

      <Field
        label="Sessions"
        hint="Every PTY the daemon currently tracks. Dead rows can be forgotten from the daemon side; their app metadata stays so you can resume from disk if the agent supports it."
      >
        <SessionsList sessions={sessions} enabled={enabled} running={running} />
      </Field>
    </section>
  );
}

function SessionsList({
  sessions,
  enabled,
  running,
}: {
  sessions: DaemonSessionSummary[] | null;
  enabled: boolean;
  running: boolean;
}) {
  if (!enabled) {
    return (
      <p className="text-xs text-fg-muted">
        Daemon disabled — sessions are managed by the legacy in-process path.
      </p>
    );
  }
  if (!running) {
    return <p className="text-xs text-fg-muted">Daemon is not running.</p>;
  }
  if (sessions === null) {
    return <p className="text-xs text-fg-muted">Loading…</p>;
  }
  if (sessions.length === 0) {
    return <p className="text-xs text-fg-muted">No sessions tracked.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded border border-border bg-bg-elevated text-xs">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
          <span
            className={cn(
              "font-mono text-[10px]",
              s.alive ? "text-accent" : "text-fg-muted",
            )}
          >
            {s.alive ? "●" : "○"}
          </span>
          <span className="flex-1 truncate font-mono">{s.name}</span>
          <span className="text-fg-muted">{s.kind}</span>
          {s.agent_kind ? (
            <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-fg-muted">
              {s.agent_kind}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
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
