import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  FileDiff,
  GitCommit,
  GitPullRequest,
  Globe,
  ListTodo,
  Maximize2,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Panel, PanelGroup } from "react-resizable-panels";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openFileInEditor } from "../lib/editor";
import { joinPath } from "../lib/paths";
import { useAppStore } from "../store";
import type {
  AccountSummary,
  CommitInfo,
  DiffPayload,
  PrStateFilter,
  PullRequestChecksSummary,
  PullRequestInfo,
  PullRequestListing,
  StagedFile,
  TodoItem,
} from "../lib/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffView } from "./DiffView";
import { DiffViewerModal } from "./DiffViewerModal";
import { PullRequestDetailModal } from "./PullRequestDetailModal";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";
import { RefreshButton } from "./ui";

interface ExpandedDiff {
  payload: DiffPayload;
  title: string;
  subtitle?: string;
}

const COMMITS_PAGE_SIZE = 50;
const COMMIT_ROW_HEIGHT = 48;

export function RightPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeProject = useAppStore((s) => s.activeProject);
  const rightTab = useAppStore((s) => s.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const active = sessions.find((s) => s.id === activeSessionId);
  // The session's recorded worktree path is what we set at spawn time. The
  // PTY child (or any descendant) may have chdir'd since — most notably via
  // `claude --worktree`, which silently moves the running session into a
  // freshly created worktree. `useLiveRepoPath` asks the backend on demand
  // and falls back to the recorded path when there's no live PTY.
  const fallbackPath = active?.worktree_path ?? activeProject ?? null;
  const repoPath = useLiveRepoPath(active?.id ?? null, fallbackPath, rightTab);
  const [expanded, setExpanded] = useState<ExpandedDiff | null>(null);
  const [prDetail, setPrDetail] = useState<{
    repoPath: string;
    number: number;
  } | null>(null);
  // Bumped from the PR detail modal after a merge/close so the PRs tab
  // refetches without waiting for the next polling tick.
  const [prListVersion, setPrListVersion] = useState(0);

  // Polling lives at the panel level (not inside TodosTab) so we can hide the
  // Todos tab when the active session has none — without requiring the tab to
  // be mounted first to discover that.
  const todosState = useSessionTodos(
    active?.id ?? null,
    active?.worktree_path ?? null,
  );
  const showTodos = todosState.todos.length > 0;

  // If the user is sitting on Todos but the underlying list emptied (e.g.
  // session ended, switched to a session with no todos), fall back rather
  // than render an empty hidden tab.
  useEffect(() => {
    if (rightTab === "todos" && !showTodos && todosState.loaded) {
      setRightTab("commits");
    }
  }, [rightTab, showTodos, todosState.loaded, setRightTab]);

  return (
    <aside className="flex h-full w-full flex-col bg-bg-sidebar">
      <nav
        className={cn(
          "flex shrink-0 overflow-x-auto whitespace-nowrap border-b border-border",
          "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {showTodos ? (
          <TabButton
            icon={<ListTodo size={14} />}
            label="Todos"
            badge={todosState.todos.length}
            active={rightTab === "todos"}
            onClick={() => setRightTab("todos")}
          />
        ) : null}
        <TabButton
          icon={<GitCommit size={14} />}
          label="Commits"
          active={rightTab === "commits"}
          onClick={() => setRightTab("commits")}
        />
        <TabButton
          icon={<FileDiff size={14} />}
          label="Staged"
          active={rightTab === "staged"}
          onClick={() => setRightTab("staged")}
        />
        <TabButton
          icon={<GitPullRequest size={14} />}
          label="PRs"
          active={rightTab === "prs"}
          onClick={() => setRightTab("prs")}
        />
      </nav>
      <div className="flex-1 overflow-hidden">
        {rightTab === "todos" ? (
          active && showTodos ? (
            <TodosTab todos={todosState.todos} />
          ) : (
            <Empty msg="No todos in this session" />
          )
        ) : rightTab === "commits" ? (
          repoPath ? (
            <CommitsTab repoPath={repoPath} onExpand={setExpanded} />
          ) : (
            <Empty msg="No project selected" />
          )
        ) : rightTab === "staged" ? (
          repoPath ? (
            <StagedTab repoPath={repoPath} onExpand={setExpanded} />
          ) : (
            <Empty msg="No project selected" />
          )
        ) : repoPath ? (
          <PullRequestsTab
            repoPath={repoPath}
            onOpenDetail={(number) => setPrDetail({ repoPath, number })}
            refreshKey={prListVersion}
          />
        ) : (
          <Empty msg="No project selected" />
        )}
      </div>
      <DiffViewerModal
        payload={expanded?.payload ?? null}
        title={expanded?.title ?? ""}
        subtitle={expanded?.subtitle}
        cwd={repoPath ?? undefined}
        onClose={() => setExpanded(null)}
      />
      <PullRequestDetailModal
        open={prDetail}
        cwd={repoPath ?? undefined}
        onClose={() => setPrDetail(null)}
        onMutated={() => setPrListVersion((v) => v + 1)}
      />
    </aside>
  );
}

interface TabButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}

function TabButton({ icon, label, active, onClick, badge }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex shrink-0 items-center justify-center gap-1.5 px-3 py-2 text-xs transition",
        active
          ? "text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent/30"
          : "text-fg-muted hover:text-fg",
      )}
    >
      {icon}
      {label}
      {typeof badge === "number" && badge > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[9px] font-medium tabular-nums",
            active
              ? "bg-accent/20 text-fg"
              : "bg-fg-muted/15 text-fg-muted",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-fg-muted">
      {msg}
    </div>
  );
}

/**
 * Shimmer placeholder row used while a tab's initial fetch is in flight.
 * Switching projects clears and refetches all the right-panel tabs at once;
 * without these the panel goes briefly blank and the click feels janky.
 */
function SkeletonRow({ pulseDelayMs = 0 }: { pulseDelayMs?: number }) {
  return (
    <div
      className="flex items-center gap-2 border-b border-border/40 px-3 py-2"
      style={{ animationDelay: `${pulseDelayMs}ms` }}
    >
      <span className="h-3 w-12 shrink-0 animate-pulse rounded bg-fg-muted/15" />
      <span className="h-3 w-full max-w-[60%] animate-pulse rounded bg-fg-muted/10" />
      <span className="h-3 w-10 shrink-0 animate-pulse rounded bg-fg-muted/10 ml-auto" />
    </div>
  );
}

function SkeletonList({ count = 6 }: { count?: number }) {
  return (
    <div className="text-xs">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} pulseDelayMs={i * 80} />
      ))}
    </div>
  );
}

/**
 * Shaped placeholder for the Pull Requests tab. Mirrors the real PR row
 * layout — two lines, with `#number`, state badge, title on top and
 * author · branches · time underneath — so the panel doesn't reflow when
 * data arrives. Bar widths are randomized per row (deterministically) so
 * the placeholder reads as multiple distinct items rather than a stripe.
 */
function PrSkeletonRow({ index }: { index: number }) {
  // Cycle through a handful of width pairs so the skeleton looks like a
  // varied list instead of identical bars stacked vertically.
  const titleWidths = ["55%", "72%", "40%", "65%", "48%", "60%"];
  const branchWidths = ["38%", "52%", "30%", "44%"];
  const titleW = titleWidths[index % titleWidths.length];
  const branchW = branchWidths[index % branchWidths.length];
  return (
    <div className="flex flex-col gap-1.5 border-b border-border/40 px-3 py-2">
      <div className="flex w-full items-center gap-2">
        <span className="h-3 w-8 shrink-0 animate-pulse rounded bg-fg-muted/15" />
        <span className="h-4 w-12 shrink-0 animate-pulse rounded-full bg-fg-muted/15" />
        <span
          className="h-3 min-w-0 flex-1 animate-pulse rounded bg-fg-muted/10"
          style={{ width: titleW }}
        />
      </div>
      <div className="flex w-full items-center gap-2">
        <span className="h-2.5 w-16 shrink-0 animate-pulse rounded bg-fg-muted/10" />
        <span className="text-[10px] text-fg-muted/40">·</span>
        <span
          className="h-2.5 animate-pulse rounded bg-fg-muted/10"
          style={{ width: branchW }}
        />
        <span className="text-[10px] text-fg-muted/40">·</span>
        <span className="h-2.5 w-10 shrink-0 animate-pulse rounded bg-fg-muted/10" />
      </div>
    </div>
  );
}

function PrSkeletonList({ count = 6 }: { count?: number }) {
  return (
    <div className="text-xs">
      {Array.from({ length: count }).map((_, i) => (
        <PrSkeletonRow key={i} index={i} />
      ))}
    </div>
  );
}

const TODOS_POLL_INTERVAL_MS = 1500;

interface SessionTodosState {
  todos: TodoItem[];
  loaded: boolean;
  error: string | null;
}

/**
 * Resolve the live working directory of a session's PTY tree, with the
 * recorded `fallback` path as the immediate (and final) fallback. Re-resolves
 * lazily — only on session change, tab change, and window refocus. Cost per
 * resolve is one Tauri command + a single sysinfo refresh on the backend, so
 * a few invocations per minute is essentially free; we deliberately do *not*
 * poll on a timer.
 */
function useLiveRepoPath(
  sessionId: string | null,
  fallback: string | null,
  rightTab: string,
): string | null {
  const [liveCwd, setLiveCwd] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setLiveCwd(null);
      return;
    }
    let cancelled = false;
    api
      .ptyCwd(sessionId)
      .then((cwd) => {
        if (!cancelled) setLiveCwd(cwd);
      })
      .catch((err: unknown) => {
        // Don't blow away a previously resolved path on a transient backend
        // error — the static fallback will kick in only if liveCwd was never
        // set in the first place. Logging stays at debug to avoid noise.
        console.debug("[RightPanel] ptyCwd resolve failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, rightTab, tick]);

  // Refocusing the app is a strong signal the user is about to look at the
  // panel — re-resolve so a `claude --worktree` that happened while we were
  // backgrounded is reflected immediately.
  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return liveCwd ?? fallback;
}

function useSessionTodos(
  sessionId: string | null,
  cwd: string | null,
): SessionTodosState {
  const [state, setState] = useState<SessionTodosState>({
    todos: [],
    loaded: false,
    error: null,
  });

  useEffect(() => {
    if (!sessionId || !cwd) {
      setState({ todos: [], loaded: true, error: null });
      return;
    }
    let cancelled = false;
    setState({ todos: [], loaded: false, error: null });

    const poll = async () => {
      try {
        const result = await api.readSessionTodos(sessionId, cwd);
        if (cancelled) return;
        // Defensive: the Rust contract returns Vec<TodoItem> (→ []), but a
        // serialization edge or future error path that produces null would
        // crash on the `todos.length` access elsewhere in this panel.
        setState({
          todos: Array.isArray(result) ? result : [],
          loaded: true,
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, loaded: true, error: String(e) }));
      }
    };

    void poll();
    const handle = setInterval(poll, TODOS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [sessionId, cwd]);

  return state;
}

function TodosTab({ todos }: { todos: TodoItem[] }) {
  const counts = countByStatus(todos);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wide text-fg-muted">
        <span className="mr-3">{counts.completed}/{todos.length} done</span>
        {counts.in_progress > 0 ? (
          <span className="text-accent">{counts.in_progress} in progress</span>
        ) : null}
      </div>
      <ul className="flex-1 overflow-y-auto p-2 text-xs">
        {todos.map((t, i) => (
          <TodoRow key={`${i}-${t.content}`} todo={t} />
        ))}
      </ul>
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const status = todo.status as string;
  const display =
    status === "in_progress" && todo.activeForm
      ? todo.activeForm
      : todo.content;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded px-2 py-1.5",
        status === "in_progress" && "bg-bg-elevated/40",
      )}
    >
      <span className="mt-0.5 shrink-0">{statusGlyph(status)}</span>
      <span
        className={cn(
          "min-w-0 flex-1",
          status === "completed" && "text-fg-muted line-through opacity-70",
          status === "in_progress" && "text-fg",
          status === "pending" && "text-fg",
        )}
      >
        {display}
      </span>
    </li>
  );
}

function statusGlyph(status: string): ReactNodeLike {
  if (status === "completed") {
    return <span className="text-accent">✓</span>;
  }
  if (status === "in_progress") {
    return <span className="text-accent animate-pulse">▸</span>;
  }
  return <span className="text-fg-muted">○</span>;
}

type ReactNodeLike = React.ReactNode;

function countByStatus(todos: TodoItem[]) {
  let pending = 0;
  let in_progress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === "completed") completed++;
    else if (t.status === "in_progress") in_progress++;
    else pending++;
  }
  return { pending, in_progress, completed };
}

function CommitsTab({
  repoPath,
  onExpand,
}: {
  repoPath: string;
  onExpand: (e: ExpandedDiff) => void;
}) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Tracks the very first fetch for the current `repoPath` so we can show
  // skeleton rows instead of a blank panel on project switch.
  const [loadingFirst, setLoadingFirst] = useState(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    commit: CommitInfo;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSelected(null);
    setDiff(null);
    setHasMore(true);
    setLoadingMore(false);
    setLoadingFirst(true);
    setCommits([]);
    api
      .listCommits(repoPath, 0, COMMITS_PAGE_SIZE)
      .then((page) => {
        if (cancelled) return;
        setCommits(page);
        setHasMore(page.length === COMMITS_PAGE_SIZE);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingFirst(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const page = await api.listCommits(repoPath, 0, COMMITS_PAGE_SIZE);
        if (cancelled) return;
        setCommits((prev) => {
          if (prev.length === 0) {
            return page;
          }
          // The fetched page is authoritative for the top of history. Splice it
          // over the equivalent prefix of `prev` so abandoned commits (e.g.
          // after `git reset` / amend) get evicted instead of lingering in the
          // middle of the list.
          return [...page, ...prev.slice(page.length)];
        });
      } catch {
        // silent — next tick retries
      }
    };
    const handle = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [repoPath]);

  const loadMore = useCallback(() => {
    setLoadingMore((cur) => {
      if (cur) return cur;
      const offset = commits.length;
      api
        .listCommits(repoPath, offset, COMMITS_PAGE_SIZE)
        .then((page) => {
          setCommits((prev) => [...prev, ...page]);
          setHasMore(page.length === COMMITS_PAGE_SIZE);
          setLoadingMore(false);
        })
        .catch((e) => {
          setError(String(e));
          setLoadingMore(false);
        });
      return true;
    });
  }, [repoPath, commits.length]);

  function selectCommit(sha: string) {
    setSelected(sha);
    setDiff(null);
    api
      .commitDiff(repoPath, sha)
      .then(setDiff)
      .catch((e) => setError(String(e)));
  }

  async function expandCommit(c: CommitInfo) {
    try {
      const payload = await api.commitDiff(repoPath, c.sha);
      onExpand({
        payload,
        title: c.summary,
        subtitle: `${c.short_sha} · ${c.author}`,
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openOnGitHub(c: CommitInfo) {
    try {
      const url = await api.commitWebUrl(repoPath, c.sha);
      if (!url) {
        setError("This repo's origin is not a GitHub remote.");
        return;
      }
      await openUrl(url);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  const rowCount = commits.length + (hasMore ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    overscan: 8,
  });

  const items = virtualizer.getVirtualItems();
  const lastItem = items[items.length - 1];
  useEffect(() => {
    if (!lastItem) return;
    if (hasMore && !loadingMore && lastItem.index >= commits.length - 1) {
      loadMore();
    }
  }, [lastItem, hasMore, loadingMore, commits.length, loadMore]);

  if (error) return <div className="p-3 text-xs text-danger">{error}</div>;
  if (loadingFirst && commits.length === 0) {
    return (
      <PanelGroup direction="vertical" autoSaveId="acorn:layout:commits">
        <Panel id="commits-list" order={1} defaultSize={50} minSize={20}>
          <div className="h-full overflow-y-auto">
            <SkeletonList count={8} />
          </div>
        </Panel>
        <ResizeHandle direction="vertical" />
        <Panel id="commits-diff" order={2} defaultSize={50} minSize={15}>
          <div className="h-full overflow-y-auto p-3">
            <div className="h-3 w-1/2 animate-pulse rounded bg-fg-muted/15" />
            <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-fg-muted/10" />
            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-fg-muted/10" />
          </div>
        </Panel>
      </PanelGroup>
    );
  }

  return (
    <PanelGroup direction="vertical" autoSaveId="acorn:layout:commits">
      <Panel id="commits-list" order={1} defaultSize={50} minSize={20}>
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
        >
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((vi) => {
            const isSentinel = vi.index >= commits.length;
            const c = commits[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {isSentinel ? (
                  <div className="px-3 py-3 text-center text-[10px] text-fg-muted">
                    {loadingMore ? "loading more..." : "—"}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => selectCommit(c.sha)}
                    onDoubleClick={() => {
                      void expandCommit(c);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, commit: c });
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-3 py-2 text-left text-xs transition",
                      selected === c.sha
                        ? "bg-bg-elevated"
                        : "hover:bg-bg-elevated/50",
                    )}
                    style={{ height: COMMIT_ROW_HEIGHT }}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <Tooltip
                        label={c.pushed ? "Pushed" : "Not pushed"}
                        side="top"
                      >
                        <span
                          className={cn(
                            "shrink-0 font-mono",
                            c.pushed ? "text-accent" : "text-fg-muted",
                          )}
                        >
                          {c.short_sha}
                        </span>
                      </Tooltip>
                      <Tooltip label={c.summary} side="top" multiline>
                        <span className="truncate text-fg">{c.summary}</span>
                      </Tooltip>
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-2 text-[10px] text-fg-muted">
                      <span className="truncate">{c.author}</span>
                      <span className="opacity-50">·</span>
                      <Tooltip label={absoluteTime(c.timestamp)} side="top">
                        <span className="font-mono">
                          {relativeTime(c.timestamp)}
                        </span>
                      </Tooltip>
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        </div>
      </Panel>
      <ResizeHandle direction="vertical" />
      <Panel id="commits-diff" order={2} defaultSize={50} minSize={15}>
        <div className="h-full overflow-y-auto">
          {selected && diff ? (
            <DiffView
              payload={diff}
              onExpand={() => {
                const c = commits.find((x) => x.sha === selected);
                onExpand({
                  payload: diff,
                  title: c?.summary ?? selected.slice(0, 12),
                  subtitle: `${c?.short_sha ?? selected.slice(0, 7)} · ${c?.author ?? ""}`,
                });
              }}
            />
          ) : selected ? (
            <Empty msg="loading diff..." />
          ) : (
            <Empty msg="Select a commit to see diff" />
          )}
        </div>
      </Panel>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={
          menu
            ? ([
                {
                  label: "Expand diff",
                  icon: <Maximize2 size={12} />,
                  onClick: () => {
                    void expandCommit(menu.commit);
                  },
                },
                {
                  label: "View on GitHub",
                  icon: <Globe size={12} />,
                  onClick: () => {
                    void openOnGitHub(menu.commit);
                  },
                },
                {
                  label: `Copy SHA (${menu.commit.short_sha})`,
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyToClipboard(menu.commit.sha);
                  },
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
    </PanelGroup>
  );
}

function relativeTime(unixSeconds: number): string {
  const diffSec = Math.round(Date.now() / 1000) - unixSeconds;
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(diffSec / 3600);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(diffSec / 86400);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(diffSec / (86400 * 30));
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(diffSec / (86400 * 365));
  return `${yr}y ago`;
}

function absoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function StagedTab({
  repoPath,
  onExpand,
}: {
  repoPath: string;
  onExpand: (e: ExpandedDiff) => void;
}) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFirst, setLoadingFirst] = useState(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: StagedFile;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [f, d] = await Promise.all([
          api.listStaged(repoPath),
          api.stagedDiff(repoPath),
        ]);
        if (cancelled) return;
        setFiles(f);
        setDiff(d);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
      } finally {
        if (!cancelled) setLoadingFirst(false);
      }
    };

    setError(null);
    setLoadingFirst(true);
    setFiles([]);
    setDiff(null);
    void refresh();
    const handle = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [repoPath]);

  function isDeleted(file: StagedFile): boolean {
    return file.status.toLowerCase().includes("delete");
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openInEditor(file: StagedFile) {
    if (isDeleted(file)) {
      setError("File was deleted; nothing to open.");
      return;
    }
    try {
      await openFileInEditor(joinPath(repoPath, file.path));
    } catch (e) {
      setError(String(e));
    }
  }

  async function openWithDefaultApp(file: StagedFile) {
    if (isDeleted(file)) {
      setError("File was deleted; nothing to open.");
      return;
    }
    try {
      await openPath(joinPath(repoPath, file.path));
    } catch (e) {
      setError(String(e));
    }
  }

  if (error) return <div className="p-3 text-xs text-danger">{error}</div>;
  if (files.length === 0) {
    if (loadingFirst) return <SkeletonList count={6} />;
    return <Empty msg="No staged or modified files" />;
  }

  return (
    <PanelGroup direction="vertical" autoSaveId="acorn:layout:staged">
      <Panel id="staged-list" order={1} defaultSize={35} minSize={15}>
        <ul className="h-full overflow-y-auto">
          {files.map((f) => (
            <li
              key={f.path}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, file: f });
              }}
              onDoubleClick={() => {
                if (isDeleted(f)) return;
                void openWithDefaultApp(f);
              }}
              className="flex cursor-default items-center gap-2 px-3 py-1.5 font-mono text-xs hover:bg-bg-elevated/40"
            >
              <span className="w-24 shrink-0 truncate text-fg-muted">
                {f.status}
              </span>
              <Tooltip label={f.path} side="top" multiline>
                <span className="truncate text-fg">{f.path}</span>
              </Tooltip>
            </li>
          ))}
        </ul>
      </Panel>
      <ResizeHandle direction="vertical" />
      <Panel id="staged-diff" order={2} defaultSize={65} minSize={15}>
        <div className="h-full overflow-y-auto">
          {diff ? (
            <DiffView
              payload={diff}
              onExpand={() =>
                onExpand({
                  payload: diff,
                  title: "Working tree changes",
                  subtitle: repoPath,
                })
              }
            />
          ) : (
            <Empty msg="No diff" />
          )}
        </div>
      </Panel>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={
          menu
            ? ([
                {
                  label: "Open in editor",
                  icon: <ExternalLink size={12} />,
                  disabled: isDeleted(menu.file),
                  onClick: () => {
                    void openInEditor(menu.file);
                  },
                },
                { type: "separator" },
                {
                  label: "Copy relative path",
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyText(menu.file.path);
                  },
                },
                {
                  label: "Copy absolute path",
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyText(joinPath(repoPath, menu.file.path));
                  },
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
    </PanelGroup>
  );
}

const PR_STATE_OPTIONS: { value: PrStateFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

const PR_REFRESH_INTERVAL_MS = 60_000;

function PullRequestsTab({
  repoPath,
  onOpenDetail,
  refreshKey,
}: {
  repoPath: string;
  onOpenDetail: (number: number) => void;
  /** Bumped by the parent to force an out-of-band refetch (e.g. after a PR is merged via the modal). */
  refreshKey: number;
}) {
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("open");
  const [listing, setListing] = useState<PullRequestListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    pr: PullRequestInfo;
  } | null>(null);
  const setPrAccountForRepo = useAppStore((s) => s.setPrAccountForRepo);

  const fetchPrs = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setLoading(true);
      try {
        const result = await api.listPullRequests(repoPath, stateFilter);
        if (signal?.cancelled) return;
        setListing(result);
        setError(null);
        setPrAccountForRepo(
          repoPath,
          result.kind === "ok" ? result.account : null,
        );
      } catch (e) {
        if (signal?.cancelled) return;
        setError(String(e));
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    },
    [repoPath, stateFilter, setPrAccountForRepo],
  );

  useEffect(() => {
    // Drop the prior project's listing so the panel renders skeletons during
    // the next fetch instead of flashing stale PR rows for the old repo.
    setListing(null);
    setError(null);
    const signal = { cancelled: false };
    void fetchPrs(signal);
    const handle = setInterval(() => {
      void fetchPrs(signal);
    }, PR_REFRESH_INTERVAL_MS);
    return () => {
      signal.cancelled = true;
      clearInterval(handle);
    };
  }, [fetchPrs]);

  // Out-of-band refresh when the parent bumps `refreshKey` (e.g. PR merged via
  // the detail modal). Skip the very first render since the effect above
  // already kicks off the initial fetch.
  const firstRefreshKeyRender = useRef(true);
  useEffect(() => {
    if (firstRefreshKeyRender.current) {
      firstRefreshKeyRender.current = false;
      return;
    }
    const signal = { cancelled: false };
    void fetchPrs(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [refreshKey, fetchPrs]);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openPrInBrowser(pr: PullRequestInfo) {
    try {
      await openUrl(pr.url);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {PR_STATE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStateFilter(opt.value)}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] transition",
              stateFilter === opt.value
                ? "bg-bg-elevated text-fg"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {opt.label}
          </button>
        ))}
        <RefreshButton
          onClick={() => void fetchPrs()}
          loading={loading}
          size={12}
          className="ml-auto"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="p-3 text-xs text-danger">{error}</div>
        ) : !listing ? (
          <PrSkeletonList count={10} />
        ) : listing.kind === "not_github" ? (
          <Empty msg="Origin remote is not a GitHub repository." />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner slug={listing.slug} accounts={listing.accounts} />
        ) : listing.items.length === 0 ? (
          <Empty msg={`No ${stateFilter} pull requests.`} />
        ) : (
          <ul className="text-xs">
            {listing.items.map((pr) => (
              <li
                key={pr.number}
                role="button"
                tabIndex={0}
                onDoubleClick={() => onOpenDetail(pr.number)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, pr });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onOpenDetail(pr.number);
                  }
                }}
                className="flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-3 py-2 text-left transition hover:bg-bg-elevated/50 focus-visible:outline-none focus-visible:bg-bg-elevated/60"
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-fg-muted">
                    #{pr.number}
                  </span>
                  <PrStateBadge state={pr.state} isDraft={pr.is_draft} />
                  <Tooltip label={pr.title} side="top" multiline>
                    <span className="truncate text-fg">{pr.title}</span>
                  </Tooltip>
                </span>
                <span className="flex w-full min-w-0 items-center gap-2 text-[10px] text-fg-muted">
                  <span className="truncate">{pr.author}</span>
                  <span className="opacity-50">·</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <Tooltip
                      label={`${pr.head_branch} → ${pr.base_branch}`}
                      side="top"
                      multiline
                      className="min-w-0"
                    >
                      <span className="flex min-w-0 items-center gap-1 font-mono">
                        <span className="truncate">{pr.head_branch}</span>
                        <span className="shrink-0">→</span>
                        <span className="truncate">{pr.base_branch}</span>
                      </span>
                    </Tooltip>
                    <PrChecksBadge checks={pr.checks} />
                  </span>
                  <span className="shrink-0 opacity-50">·</span>
                  <Tooltip
                    label={absoluteTime(toUnixSeconds(pr.updated_at))}
                    side="top"
                    className="shrink-0"
                  >
                    <span className="whitespace-nowrap font-mono">
                      {relativeTime(toUnixSeconds(pr.updated_at))}
                    </span>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={
          menu
            ? ([
                {
                  label: "Open detail",
                  icon: <Maximize2 size={12} />,
                  onClick: () => {
                    onOpenDetail(menu.pr.number);
                  },
                },
                {
                  label: "Open in browser",
                  icon: <ExternalLink size={12} />,
                  onClick: () => {
                    void openPrInBrowser(menu.pr);
                  },
                },
                {
                  label: "Copy URL",
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyText(menu.pr.url);
                  },
                },
                {
                  label: `Copy branch (${menu.pr.head_branch})`,
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyText(menu.pr.head_branch);
                  },
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

function NoAccessBanner({
  slug,
  accounts,
}: {
  slug: string;
  accounts: AccountSummary[];
}) {
  const tried = accounts.map((a) => `@${a.login}`).join(", ");
  return (
    <div className="space-y-2 p-3 text-xs text-fg-muted">
      <p className="text-fg">
        No logged-in <code className="font-mono">gh</code> account can access{" "}
        <span className="font-mono text-fg">{slug}</span>.
      </p>
      {accounts.length > 0 ? (
        <p>
          <span className="opacity-70">Tried:</span> {tried}
        </p>
      ) : (
        <p>No accounts authenticated against github.com.</p>
      )}
      <p className="opacity-70">
        Run <code className="font-mono">gh auth login</code> with an account
        that has access, or accept the invitation on github.com.
      </p>
    </div>
  );
}

function PrChecksBadge({
  checks,
}: {
  checks: PullRequestChecksSummary | null;
}) {
  if (!checks) return null;
  // Effective total mirrors the PR detail modal: NEUTRAL/SKIPPED/CANCELLED
  // are already excluded by the backend, so passed+failed+pending is what
  // actually carries pass/fail signal.
  const effective = checks.passed + checks.failed + checks.pending;
  if (effective === 0) return null;

  const allPassed = checks.passed === effective;
  const allFailed = checks.failed === effective;

  if (allPassed) {
    return (
      <Tooltip
        label={`All ${effective} check${effective === 1 ? "" : "s"} passed`}
        side="top"
      >
        <Check
          size={10}
          strokeWidth={3}
          className="shrink-0 text-emerald-400"
        />
      </Tooltip>
    );
  }
  if (allFailed) {
    return (
      <Tooltip
        label={`All ${effective} check${effective === 1 ? "" : "s"} failed`}
        side="top"
      >
        <X size={10} strokeWidth={3} className="shrink-0 text-rose-400" />
      </Tooltip>
    );
  }
  // Partial: tiny inline `passed/total` next to the branch name, no pill.
  return (
    <Tooltip
      label={`${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending`}
      side="top"
    >
      <span className="shrink-0 font-mono tabular-nums opacity-80">
        {checks.passed}/{effective}
      </span>
    </Tooltip>
  );
}

function PrStateBadge({ state, isDraft }: { state: string; isDraft: boolean }) {
  const upper = state.toUpperCase();
  const showDraft = isDraft && upper === "OPEN";
  const label = showDraft ? "DRAFT" : upper;
  const tone = showDraft
    ? "bg-fg-muted/15 text-fg-muted"
    : upper === "OPEN"
      ? "bg-emerald-500/15 text-emerald-400"
      : upper === "MERGED"
        ? "bg-purple-500/15 text-purple-400"
        : "bg-rose-500/15 text-rose-400";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  );
}

function toUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}
