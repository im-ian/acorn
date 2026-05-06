import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { api } from "../lib/api";
import type { MemoryProcess } from "../lib/types";
import { useAppStore } from "../store";
import { MemoryBreakdownModal } from "./MemoryBreakdownModal";

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

function useMemoryUsage(intervalMs: number): MemorySnapshot | null {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);

  useEffect(() => {
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
  }, [intervalMs]);

  return snapshot;
}

export function StatusBar() {
  const { sessions, activeSessionId, error, loading } = useAppStore();
  const active = sessions.find((s) => s.id === activeSessionId);
  const memory = useMemoryUsage(MEMORY_POLL_MS);
  const home = useHomeDir();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const displayPath = active ? tildify(active.worktree_path, home) : null;

  return (
    <>
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg-sidebar px-3 font-mono text-xs text-fg-muted">
        <span>sessions: {sessions.length}</span>
        {active ? (
          <>
            <span className="text-fg-muted/50">|</span>
            <span>branch: {active.branch}</span>
            <span className="text-fg-muted/50">|</span>
            <span>status: {active.status}</span>
          </>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-3">
          {loading ? <span>working...</span> : null}
          {error ? (
            <span className="truncate text-danger" title={error}>
              error: {error}
            </span>
          ) : null}
          {active && displayPath ? (
            <span
              className="truncate text-right text-fg-muted"
              title={active.worktree_path}
            >
              {displayPath}
            </span>
          ) : null}
          <span className="text-fg-muted/50">|</span>
          <button
            type="button"
            disabled={!memory}
            onClick={() => setBreakdownOpen(true)}
            title="Click to view per-process breakdown"
            className="rounded px-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
          >
            mem: {memory ? formatBytes(memory.bytes) : "–"}
          </button>
        </span>
      </footer>

      <MemoryBreakdownModal
        open={breakdownOpen && memory !== null}
        totalBytes={memory?.bytes ?? 0}
        processes={memory?.processes ?? []}
        onClose={() => setBreakdownOpen(false)}
      />
    </>
  );
}
