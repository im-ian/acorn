import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { homeDir } from "@tauri-apps/api/path";
import { Activity, Loader2, Settings } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useSettings } from "../lib/settings";
import type { MemoryProcess } from "../lib/types";
import { useAppStore } from "../store";
import { MemoryBreakdownModal } from "./MemoryBreakdownModal";
import { Tooltip } from "./Tooltip";

const MEMORY_POLL_MS = 2000;

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

interface MemorySnapshot {
  bytes: number;
  processes: MemoryProcess[];
}

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
        const usage = await api.getMemoryUsage();
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
  const { sessions, activeSessionId, activeProject, error, loading } =
    useAppStore();
  const multiInputEnabled = useAppStore((s) => s.multiInputEnabled);
  const prAccountByRepo = useAppStore((s) => s.prAccountByRepo);
  const showSessionCount = useSettings(
    (s) => s.settings.statusBar.showSessionCount,
  );
  const showSessionStatus = useSettings(
    (s) => s.settings.statusBar.showSessionStatus,
  );
  const showGithubAccount = useSettings(
    (s) => s.settings.statusBar.showGithubAccount,
  );
  const showWorkingDirectory = useSettings(
    (s) => s.settings.statusBar.showWorkingDirectory,
  );
  const showMemory = useSettings((s) => s.settings.statusBar.showMemory);
  const active = sessions.find((s) => s.id === activeSessionId);
  const memory = useMemoryUsage(MEMORY_POLL_MS, showMemory);
  const home = useHomeDir();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const displayPath = active ? tildify(active.worktree_path, home) : null;
  // The PR-tab account map is keyed by the same repoPath we hand to the PRs
  // tab — prefer the active session's worktree (matches what was probed),
  // then fall back to the active project root.
  const prAccountKey = active?.worktree_path ?? activeProject ?? null;
  const prAccount = prAccountKey ? prAccountByRepo[prAccountKey] ?? null : null;

  return (
    <>
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg-sidebar px-3 font-mono text-xs text-fg-muted">
        {/* Left: aggregate counters about acorn itself — total sessions and
            the active session's lifecycle status. The IPC and daemon
            buttons sit first so the user can recover from a dead
            control-session socket or a stopped daemon without leaving
            the main view. */}
        <ServicesStatusButton />
        {showSessionCount ? (
          <span>sessions: {sessions.length}</span>
        ) : null}
        {showSessionStatus && active ? (
          <>
            {showSessionCount ? (
              <span className="text-fg-muted/50">|</span>
            ) : null}
            <span>status: {active.status}</span>
          </>
        ) : null}
        {multiInputEnabled ? (
          <>
            {showSessionCount || (showSessionStatus && active) ? (
              <span className="text-fg-muted/50">|</span>
            ) : null}
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">
              multi-input: on
            </span>
          </>
        ) : null}

        {/* Right: per-active-session context — gh account, branch, working
            directory, memory. Grouped together so the eye scans them as
            "where am I right now?". */}
        <span className="ml-auto flex min-w-0 items-center gap-3">
          {loading ? <span>working...</span> : null}
          {error ? (
            <Tooltip label={error} side="top" multiline>
              <span className="truncate text-danger">error: {error}</span>
            </Tooltip>
          ) : null}
          {showGithubAccount && prAccount ? (
            <Tooltip label={`PRs listed via gh account ${prAccount}`} side="top">
              <span className="flex shrink-0 items-center gap-1 rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] text-fg-muted">
                <GitHubMark />
                {prAccount}
              </span>
            </Tooltip>
          ) : null}
          {active ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <span>branch: {active.branch}</span>
            </>
          ) : null}
          {showWorkingDirectory && active && displayPath ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <Tooltip label={active.worktree_path} side="top" multiline>
                <span className="truncate text-right text-fg-muted">
                  {displayPath}
                </span>
              </Tooltip>
            </>
          ) : null}
          {showMemory ? (
            <>
              <span className="text-fg-muted/50">|</span>
              <Tooltip label="Click to view per-process breakdown" side="top">
                <button
                  type="button"
                  disabled={!memory}
                  onClick={() => setBreakdownOpen(true)}
                  className="rounded px-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                >
                  memory: {memory ? formatBytes(memory.bytes) : "–"}
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

function StatusDot({ state }: { state: DotState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        state === "ok"
          ? "bg-accent"
          : state === "down"
            ? "bg-danger"
            : "bg-fg-muted/60",
      )}
    />
  );
}

function ServicesStatusButton() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
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
    void refreshIpc();
    void refreshDaemon();
    // Daemon socket round-trip every 5s; IPC probe piggy-backs on
    // the same cadence so both reads share one tick budget.
    const id = window.setInterval(() => {
      void refreshIpc();
      void refreshDaemon();
    }, 5_000);
    return () => window.clearInterval(id);
  }, [refreshIpc, refreshDaemon]);

  const restartIpc = useCallback(async () => {
    if (ipc.busy) return;
    setIpc((s) => ({ ...s, busy: true, lastError: null }));
    try {
      await api.ipcRestart();
      await refreshIpc();
      setIpc((s) => ({ ...s, busy: false }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await refreshIpc();
      setIpc((s) => ({ ...s, busy: false, lastError: msg }));
    }
  }, [ipc.busy, refreshIpc]);

  const openDaemonSettings = useCallback(() => {
    // Sessions tab houses the daemon panel as a sub-section.
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

  const tooltip = (() => {
    const ipcLabel =
      ipc.running === null
        ? "ipc: loading"
        : ipc.running
          ? "ipc: on"
          : "ipc: off";
    const daemonLabel =
      daemon === null
        ? "daemon: loading"
        : !daemon.enabled
          ? "daemon: disabled"
          : daemon.running
            ? `daemon: on${daemon.sessions !== null ? ` (${daemon.sessions})` : ""}`
            : "daemon: down";
    return `${ipcLabel} · ${daemonLabel} — click for details`;
  })();

  const ipcDotState: DotState =
    ipc.running === null ? "muted" : ipc.running ? "ok" : "down";
  const daemonDotState: DotState = (() => {
    if (daemon === null) return "muted";
    if (!daemon.enabled) return "muted";
    return daemon.running ? "ok" : "down";
  })();

  return (
    <>
      <Tooltip label={tooltip} side="top" multiline>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Service status"
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
          <StatusDot state={aggregate} />
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
      ? "loading"
      : ipc.running
        ? "running"
        : "down";
  const daemonStatusText =
    daemon === null
      ? "loading"
      : !daemon.enabled
        ? "disabled"
        : daemon.running
          ? daemon.sessions !== null
            ? `running · ${daemon.sessions} session${daemon.sessions === 1 ? "" : "s"}`
            : "running"
          : "down";

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: position.left, bottom: position.bottom, zIndex: 60 }}
      className="w-64 overflow-hidden rounded-md border border-border bg-bg-elevated shadow-2xl"
    >
      <ul className="divide-y divide-border text-[11px]">
        <li>
          <ServiceRow
            label="IPC server"
            description="control-session ↔ app socket"
            dot={ipcDotState}
            statusText={ipcStatusText}
            actionLabel={ipc.busy ? "Restarting…" : "Restart"}
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
            label="acornd daemon"
            description="persistent PTY sessions"
            dot={daemonDotState}
            statusText={daemonStatusText}
            actionLabel="Settings"
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
        <StatusDot state={dot} />
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
