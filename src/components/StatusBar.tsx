import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { api } from "../lib/api";
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
  const prAccountByRepo = useAppStore((s) => s.prAccountByRepo);
  const active = sessions.find((s) => s.id === activeSessionId);
  const memory = useMemoryUsage(MEMORY_POLL_MS);
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
            <Tooltip label={error} side="top" multiline>
              <span className="truncate text-danger">error: {error}</span>
            </Tooltip>
          ) : null}
          {prAccount ? (
            <Tooltip label={`PRs listed via gh account ${prAccount}`} side="top">
              <span className="flex shrink-0 items-center gap-1 rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] text-fg-muted">
                <GitHubMark />
                {prAccount}
              </span>
            </Tooltip>
          ) : null}
          {active && displayPath ? (
            <Tooltip label={active.worktree_path} side="top" multiline>
              <span className="truncate text-right text-fg-muted">
                {displayPath}
              </span>
            </Tooltip>
          ) : null}
          <span className="text-fg-muted/50">|</span>
          <Tooltip label="Click to view per-process breakdown" side="top">
            <button
              type="button"
              disabled={!memory}
              onClick={() => setBreakdownOpen(true)}
              className="rounded px-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              mem: {memory ? formatBytes(memory.bytes) : "–"}
            </button>
          </Tooltip>
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
