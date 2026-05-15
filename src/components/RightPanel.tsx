import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Copy,
  ExternalLink,
  FileDiff,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Globe,
  Loader2,
  ListTodo,
  Maximize2,
  MinusCircle,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Panel, PanelGroup } from "react-resizable-panels";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openFileInEditor } from "../lib/editor";
import { joinPath } from "../lib/paths";
import { useSettings } from "../lib/settings";
import { useAppStore } from "../store";
import type {
  AccountSummary,
  CommitInfo,
  DiffPayload,
  PrStateFilter,
  PullRequestChecksSummary,
  PullRequestDetail,
  PullRequestInfo,
  PullRequestListing,
  StagedFile,
  TodoItem,
  WorkflowJob,
  WorkflowJobStep,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunDetailListing,
  WorkflowRunsListing,
} from "../lib/types";
import { AuthorAvatar } from "./AuthorAvatar";
import { loginFromEmail } from "./AuthorTag";
import { ClosePullRequestDialog } from "./ClosePullRequestDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffView } from "./DiffView";
import { DiffViewerModal } from "./DiffViewerModal";
import { MergePullRequestDialog } from "./MergePullRequestDialog";
import { PullRequestDetailModal } from "./PullRequestDetailModal";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";
import {
  CommandHint,
  Modal,
  ModalHeader,
  RefreshButton,
  Select,
  TextInput,
} from "./ui";
import { useDialogShortcuts } from "../lib/dialog";

interface ExpandedDiff {
  payload: DiffPayload;
  title: string;
  /** Rich React subtitle — avatar + author + sha line for commit expansion. */
  subtitle?: ReactNode;
  /** Right-side header buttons (Copy SHA / Open on GitHub for commits). */
  headerActions?: ReactNode;
  /**
   * Commit message body to show above the diff. Populated when expanding a
   * commit; omitted for staged-diff expansion (no commit context).
   */
  body?: string;
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
  // Open state for the PR search modal. Carries `repoPath` so the modal can
  // run its own search fetches scoped to whichever repo was active when
  // search was triggered.
  const [prSearch, setPrSearch] = useState<{ repoPath: string } | null>(null);
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
        <TabButton
          icon={<Activity size={14} />}
          label="Actions"
          active={rightTab === "actions"}
          onClick={() => setRightTab("actions")}
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
            // `key` forces a full remount on project switch so any in-flight
            // git request from the previous repo cannot land its `setState`
            // into the new repo's component (cross-project data leak).
            <CommitsTab
              key={repoPath}
              repoPath={repoPath}
              onExpand={setExpanded}
            />
          ) : (
            <Empty msg="No project selected" />
          )
        ) : rightTab === "staged" ? (
          repoPath ? (
            <StagedTab
              key={repoPath}
              repoPath={repoPath}
              onExpand={setExpanded}
            />
          ) : (
            <Empty msg="No project selected" />
          )
        ) : rightTab === "prs" ? (
          repoPath ? (
            <PullRequestsTab
              key={repoPath}
              repoPath={repoPath}
              onOpenDetail={(number) => setPrDetail({ repoPath, number })}
              onOpenSearch={() => setPrSearch({ repoPath })}
              refreshKey={prListVersion}
            />
          ) : (
            <Empty msg="No project selected" />
          )
        ) : repoPath ? (
          <ActionsTab key={repoPath} repoPath={repoPath} />
        ) : (
          <Empty msg="No project selected" />
        )}
      </div>
      <DiffViewerModal
        payload={expanded?.payload ?? null}
        title={expanded?.title ?? ""}
        subtitle={expanded?.subtitle}
        headerActions={expanded?.headerActions}
        body={expanded?.body}
        cwd={repoPath ?? undefined}
        onClose={() => setExpanded(null)}
      />
      <PullRequestSearchModal
        open={prSearch}
        detailOpen={prDetail !== null}
        onClose={() => setPrSearch(null)}
        onOpenDetail={(number) => {
          if (!prSearch) return;
          setPrDetail({ repoPath: prSearch.repoPath, number });
        }}
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

interface LiveRepoCache {
  sessionId: string;
  fallbackPath: string | null;
  repoPath: string | null;
}

/**
 * Resolve the live working directory of a session's PTY tree to the git
 * repo it sits inside, with the recorded `fallback` path as the immediate
 * (and final) fallback. Backed by `pty_repo_root`, which does the
 * `Repository::discover` walk server-side and returns `null` when the cwd
 * lies outside any git repo — so a user `cd`-ing into e.g. a Cargo registry
 * dir doesn't push a non-repo path into git commands and produce a
 * persistent "could not find git repository from '<…>'" banner. Re-resolves
 * lazily on session change, tab change, and window refocus; deliberately
 * not polled on a timer.
 */
function useLiveRepoPath(
  sessionId: string | null,
  fallbackPath: string | null,
  rightTab: string,
): string | null {
  const [liveRepo, setLiveRepo] = useState<LiveRepoCache | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setLiveRepo(null);
      return;
    }
    let cancelled = false;
    api
      .ptyRepoRoot(sessionId)
      .then((repoPath) => {
        if (!cancelled) setLiveRepo({ sessionId, fallbackPath, repoPath });
      })
      .catch((err: unknown) => {
        // Don't blow away a previously resolved path on a transient backend
        // error — the static fallback will kick in only if liveRepo was never
        // set in the first place. Logging stays at debug to avoid noise.
        console.debug("[RightPanel] ptyRepoRoot resolve failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, fallbackPath, rightTab, tick]);

  // Refocusing the app is a strong signal the user is about to look at the
  // panel — re-resolve so a `claude --worktree` that happened while we were
  // backgrounded is reflected immediately.
  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (
    liveRepo?.sessionId === sessionId &&
    liveRepo.fallbackPath === fallbackPath
  ) {
    return liveRepo.repoPath ?? fallbackPath;
  }
  return fallbackPath;
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
  const [commitLogins, setCommitLogins] = useState<
    Record<string, string | null>
  >({});
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
    setCommitLogins({});
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

  // Resolve commit author logins via GitHub GraphQL for any sha we don't
  // already have. The backend caches by (slug, sha) so re-fetches across
  // pagination / project re-entry are free.
  useEffect(() => {
    if (commits.length === 0) return;
    const missing = commits
      .map((c) => c.sha)
      .filter((sha) => !(sha in commitLogins));
    if (missing.length === 0) return;
    let cancelled = false;
    // Mark every attempted sha in `commitLogins` (resolved or not) so this
    // effect doesn't re-fire forever for unknown authors. Without this, the
    // `missing` filter keeps matching the same shas — backend returns only
    // the subset with a known login, and `setCommitLogins` always produces
    // a fresh object reference, which retriggers the effect via the
    // `commitLogins` dep.
    const settle = (map: Record<string, string | null>) => {
      setCommitLogins((prev) => {
        const next: Record<string, string | null> = { ...prev };
        for (const sha of missing) {
          if (!(sha in next)) next[sha] = null;
        }
        for (const [sha, login] of Object.entries(map)) {
          next[sha] = login;
        }
        return next;
      });
    };
    api
      .resolveCommitLogins(repoPath, missing)
      .then((map) => {
        if (cancelled) return;
        settle(map);
      })
      .catch(() => {
        // No gh access / network failure — record null entries so we don't
        // retry the same shas every render.
        if (cancelled) return;
        settle({});
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, commits, commitLogins]);

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

  function buildSubtitle(c: CommitInfo): ReactNode {
    const login = commitLogins[c.sha] ?? loginFromEmail(c.author_email);
    return (
      <span className="flex items-center gap-2 text-[11px] text-fg-muted">
        <span className="flex items-center gap-1.5">
          <AuthorAvatar login={login} size={16} />
          <span>{c.author}</span>
        </span>
        <span className="opacity-50">·</span>
        <Tooltip label={absoluteTime(c.timestamp)} side="bottom">
          <span className="font-mono">{relativeTime(c.timestamp)}</span>
        </Tooltip>
      </span>
    );
  }

  function buildHeaderActions(c: CommitInfo, webUrl: string | null): ReactNode {
    return (
      <>
        <Tooltip label="Copy SHA" side="bottom">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(c.sha)}
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            {c.short_sha}
          </button>
        </Tooltip>
        {webUrl ? (
          <Tooltip label="Open on GitHub" side="bottom">
            <button
              type="button"
              onClick={() => void openUrl(webUrl)}
              className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <ExternalLink size={12} />
            </button>
          </Tooltip>
        ) : null}
      </>
    );
  }

  async function expandCommit(c: CommitInfo) {
    try {
      const [payload, webUrl] = await Promise.all([
        api.commitDiff(repoPath, c.sha),
        api.commitWebUrl(repoPath, c.sha).catch(() => null),
      ]);
      onExpand({
        payload,
        title: c.summary,
        subtitle: buildSubtitle(c),
        headerActions: buildHeaderActions(c, webUrl),
        body: c.body,
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
          className="h-full overflow-x-hidden overflow-y-auto"
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
                      <Tooltip label={c.summary} side="top" multiline className="flex! min-w-0 flex-1">
                        <span className="min-w-0 flex-1 truncate text-fg">{c.summary}</span>
                      </Tooltip>
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-fg-muted">
                      <span className="flex min-w-0 shrink items-center gap-1.5">
                        <AuthorAvatar
                          login={
                            commitLogins[c.sha] ?? loginFromEmail(c.author_email)
                          }
                          size={14}
                        />
                        <span className="truncate">{c.author}</span>
                      </span>
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
                if (c) {
                  void expandCommit(c);
                } else {
                  onExpand({
                    payload: diff,
                    title: selected.slice(0, 12),
                    subtitle: selected.slice(0, 7),
                  });
                }
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
                { type: "separator" },
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
        <ul className="h-full overflow-x-hidden overflow-y-auto">
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
              <Tooltip label={f.path} side="top" multiline className="flex! min-w-0 flex-1">
                <span className="min-w-0 flex-1 truncate text-fg">{f.path}</span>
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
                  subtitle: <span className="font-mono">{repoPath}</span>,
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

/** Initial page size and per-scroll growth increment for PR list pagination. */
const PR_PAGE_SIZE = 50;
/** Backend clamps to 1000; mirror that here so the UI stops growing the limit. */
const PR_PAGE_MAX = 1000;

/**
 * Shared PR row actions: context menu, copy/open helpers, and the
 * merge/close dialog overlays. Lets the PRs tab and the search modal
 * render the same right-click menu without duplicating handlers or state.
 *
 * `onMutated` fires after a merge or close so callers can refetch their
 * own listing.
 */
function usePrRowActions(
  repoPath: string,
  onOpenDetail: (number: number) => void,
  onMutated?: () => void,
) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    pr: PullRequestInfo;
  } | null>(null);
  const [mergeFor, setMergeFor] = useState<{
    number: number;
    detail: PullRequestDetail;
  } | null>(null);
  const [closeFor, setCloseFor] = useState<{
    number: number;
    detail: PullRequestDetail;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every detail fetch / dialog dismiss so stale getPullRequestDetail
  // responses can't open a dialog after the user moved on.
  const dialogEpochRef = useRef(0);

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

  async function loadDetailFor(
    pr: PullRequestInfo,
  ): Promise<PullRequestDetail | null> {
    const epoch = ++dialogEpochRef.current;
    try {
      const listing = await api.getPullRequestDetail(repoPath, pr.number);
      if (epoch !== dialogEpochRef.current) return null;
      if (listing.kind !== "ok") {
        setError(
          listing.kind === "not_github"
            ? "Origin remote is not a GitHub repository."
            : `No access to ${listing.slug}.`,
        );
        return null;
      }
      return listing.detail;
    } catch (e) {
      if (epoch === dialogEpochRef.current) setError(String(e));
      return null;
    }
  }

  async function openMergeFor(pr: PullRequestInfo) {
    const detail = await loadDetailFor(pr);
    if (!detail) return;
    setMergeFor({ number: pr.number, detail });
  }

  async function openCloseFor(pr: PullRequestInfo) {
    const detail = await loadDetailFor(pr);
    if (!detail) return;
    setCloseFor({ number: pr.number, detail });
  }

  function openContextMenu(
    e: React.MouseEvent<HTMLLIElement>,
    pr: PullRequestInfo,
  ) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, pr });
  }

  const overlays = (
    <>
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
                  onClick: () => onOpenDetail(menu.pr.number),
                },
                {
                  label: "Open in browser",
                  icon: <ExternalLink size={12} />,
                  onClick: () => void openPrInBrowser(menu.pr),
                },
                { type: "separator" },
                {
                  label: "Copy PR number",
                  icon: <Copy size={12} />,
                  onClick: () => void copyText(`#${menu.pr.number}`),
                },
                {
                  label: "Copy URL",
                  icon: <Copy size={12} />,
                  onClick: () => void copyText(menu.pr.url),
                },
                {
                  label: `Copy branch (${menu.pr.head_branch})`,
                  icon: <Copy size={12} />,
                  onClick: () => void copyText(menu.pr.head_branch),
                },
                { type: "separator" },
                {
                  label: "Merge…",
                  icon: <GitMerge size={12} />,
                  disabled: menu.pr.state.toUpperCase() !== "OPEN",
                  onClick: () => void openMergeFor(menu.pr),
                },
                {
                  label: "Close…",
                  icon: <GitPullRequestClosed size={12} />,
                  disabled: menu.pr.state.toUpperCase() !== "OPEN",
                  onClick: () => void openCloseFor(menu.pr),
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
      <MergePullRequestDialog
        open={mergeFor !== null}
        repoPath={repoPath}
        detail={mergeFor?.detail ?? null}
        onClose={() => {
          dialogEpochRef.current += 1;
          setMergeFor(null);
        }}
        onMerged={() => {
          dialogEpochRef.current += 1;
          setMergeFor(null);
          onMutated?.();
        }}
      />
      <ClosePullRequestDialog
        open={closeFor !== null}
        repoPath={repoPath}
        detail={closeFor?.detail ?? null}
        onClose={() => {
          dialogEpochRef.current += 1;
          setCloseFor(null);
        }}
        onClosed={() => {
          dialogEpochRef.current += 1;
          setCloseFor(null);
          onMutated?.();
        }}
      />
    </>
  );

  return { openContextMenu, overlays, error };
}

function PullRequestsTab({
  repoPath,
  onOpenDetail,
  onOpenSearch,
  refreshKey,
}: {
  repoPath: string;
  onOpenDetail: (number: number) => void;
  onOpenSearch: () => void;
  /** Bumped by the parent to force an out-of-band refetch (e.g. after a PR is merged via the modal). */
  refreshKey: number;
}) {
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const showAvatars = useSettings((s) => s.settings.github.showAvatars);
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("open");
  const [listing, setListing] = useState<PullRequestListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Grows by PR_PAGE_SIZE each time the user scrolls to the bottom. Resets on
  // project / state-filter change so a fresh context starts at one page.
  const [limit, setLimit] = useState(PR_PAGE_SIZE);
  const setPrAccountForRepo = useAppStore((s) => s.setPrAccountForRepo);

  const fetchPrs = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setLoading(true);
      try {
        const result = await api.listPullRequests(repoPath, stateFilter, limit);
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
    [repoPath, stateFilter, limit, setPrAccountForRepo],
  );

  // Reset list state on context change (project / filter) but NOT on limit
  // growth — keeping the existing rows during a "load more" prevents the
  // skeleton from flashing while the larger page lands.
  useEffect(() => {
    setListing(null);
    setError(null);
    setLimit(PR_PAGE_SIZE);
  }, [repoPath, stateFilter]);

  useEffect(() => {
    const signal = { cancelled: false };
    void fetchPrs(signal);
    const handle = setInterval(() => {
      void fetchPrs(signal);
    }, refreshIntervalMs);
    return () => {
      signal.cancelled = true;
      clearInterval(handle);
    };
  }, [fetchPrs, refreshIntervalMs]);

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

  const rowActions = usePrRowActions(repoPath, onOpenDetail, () => {
    void fetchPrs();
  });

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (loading) return;
    if (!listing || listing.kind !== "ok") return;
    // Fewer items than the page size means gh returned everything — nothing
    // more to load. limit hitting the backend clamp is also terminal.
    if (listing.items.length < limit) return;
    if (limit >= PR_PAGE_MAX) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setLimit((prev) => Math.min(prev + PR_PAGE_SIZE, PR_PAGE_MAX));
    }
  }

  const reachedMax =
    listing?.kind === "ok" &&
    listing.items.length >= limit &&
    limit >= PR_PAGE_MAX;

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
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Search pull requests"
          title="Search pull requests"
          className="ml-auto rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          <Search size={12} />
        </button>
        <RefreshButton
          onClick={() => void fetchPrs()}
          loading={loading}
          size={12}
        />
      </div>
      <div
        className="flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={handleScroll}
      >
        {error || rowActions.error ? (
          <div className="p-3 text-xs text-danger">
            {error ?? rowActions.error}
          </div>
        ) : !listing ? (
          <PrSkeletonList count={10} />
        ) : listing.kind === "not_github" ? (
          <Empty msg="Origin remote is not a GitHub repository." />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner
            slug={listing.slug}
            accounts={listing.accounts}
            repoPath={repoPath}
          />
        ) : listing.items.length === 0 ? (
          <Empty msg={`No ${stateFilter} pull requests.`} />
        ) : (
          <ul className="text-xs">
            {listing.items.map((pr) => (
              <PrRow
                key={pr.number}
                pr={pr}
                showAvatar={showAvatars}
                onOpen={() => onOpenDetail(pr.number)}
                onContextMenu={(e) => rowActions.openContextMenu(e, pr)}
              />
            ))}
            {loading && listing.items.length >= limit ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                Loading more…
              </li>
            ) : null}
            {reachedMax ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                Showing first {PR_PAGE_MAX}. Use search to find older PRs.
              </li>
            ) : null}
          </ul>
        )}
      </div>
      {rowActions.overlays}
    </div>
  );
}

const WORKFLOW_RUNS_LIMIT = 50;
const ALL_WORKFLOWS = "__all__";

function ActionsTab({ repoPath }: { repoPath: string }) {
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const [listing, setListing] = useState<WorkflowRunsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workflowFilter, setWorkflowFilter] = useState<string>(ALL_WORKFLOWS);
  const [detailRunId, setDetailRunId] = useState<number | null>(null);

  const fetchRuns = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setLoading(true);
      try {
        const result = await api.listWorkflowRuns(repoPath, WORKFLOW_RUNS_LIMIT);
        if (signal?.cancelled) return;
        setListing(result);
        setError(null);
      } catch (e) {
        if (signal?.cancelled) return;
        setError(String(e));
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    },
    [repoPath],
  );

  useEffect(() => {
    setListing(null);
    setError(null);
    setWorkflowFilter(ALL_WORKFLOWS);
    setDetailRunId(null);
  }, [repoPath]);

  useEffect(() => {
    const signal = { cancelled: false };
    void fetchRuns(signal);
    const handle = setInterval(() => {
      void fetchRuns(signal);
    }, refreshIntervalMs);
    return () => {
      signal.cancelled = true;
      clearInterval(handle);
    };
  }, [fetchRuns, refreshIntervalMs]);

  const workflowNames =
    listing?.kind === "ok"
      ? Array.from(new Set(listing.items.map((r) => r.workflow_name))).sort()
      : [];
  const visibleItems =
    listing?.kind === "ok"
      ? workflowFilter === ALL_WORKFLOWS
        ? listing.items
        : listing.items.filter((r) => r.workflow_name === workflowFilter)
      : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Select
          value={workflowFilter}
          onChange={(e) => setWorkflowFilter(e.target.value)}
          aria-label="Filter by workflow"
          disabled={listing?.kind !== "ok" || workflowNames.length === 0}
          className="min-w-0 max-w-full flex-1 truncate"
        >
          <option value={ALL_WORKFLOWS}>All workflows</option>
          {workflowNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <RefreshButton
          onClick={() => void fetchRuns()}
          loading={loading}
          size={12}
        />
      </div>
      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        {error ? (
          <div className="p-3 text-xs text-danger">{error}</div>
        ) : !listing ? (
          <PrSkeletonList count={8} />
        ) : listing.kind === "not_github" ? (
          <Empty msg="Origin remote is not a GitHub repository." />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner
            slug={listing.slug}
            accounts={listing.accounts}
            repoPath={repoPath}
          />
        ) : visibleItems.length === 0 ? (
          <Empty
            msg={
              listing.items.length === 0
                ? "No workflow runs yet."
                : "No runs match this filter."
            }
          />
        ) : (
          <ul className="text-xs">
            {visibleItems.map((run) => (
              <WorkflowRunRow
                key={run.id}
                run={run}
                onOpenDetail={() => setDetailRunId(run.id)}
              />
            ))}
          </ul>
        )}
      </div>
      <WorkflowRunDetailModal
        open={detailRunId !== null}
        repoPath={repoPath}
        runId={detailRunId}
        onClose={() => setDetailRunId(null)}
      />
    </div>
  );
}

function WorkflowRunRow({
  run,
  onOpenDetail,
}: {
  run: WorkflowRun;
  onOpenDetail: () => void;
}) {
  const updated = toUnixSeconds(run.updated_at);
  const startedRelative = updated > 0 ? relativeTime(updated) : "";
  const startedAbsolute = updated > 0 ? absoluteTime(updated) : "";
  const title =
    run.display_title.trim().length > 0
      ? run.display_title
      : `${run.workflow_name} run`;
  const branch = run.head_branch?.trim() ?? "";

  return (
    <li>
      <button
        type="button"
        onDoubleClick={onOpenDetail}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpenDetail();
          }
        }}
        className={cn(
          "flex w-full items-start gap-2 border-b border-border/40 px-3 py-2 text-left",
          "transition hover:bg-bg-elevated/60 focus:bg-bg-elevated/60 focus:outline-none",
        )}
        title="Double-click to view details"
      >
        <span className="mt-0.5 flex shrink-0 items-center">
          <WorkflowRunStatusIcon
            status={run.status}
            conclusion={run.conclusion}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-fg">{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-muted">
            <span className="truncate">{run.workflow_name}</span>
            <span className="opacity-50">·</span>
            <span className="truncate">{run.event}</span>
            {branch ? (
              <>
                <span className="opacity-50">·</span>
                <span className="truncate font-mono">{branch}</span>
              </>
            ) : null}
            {run.attempt > 1 ? (
              <>
                <span className="opacity-50">·</span>
                <span>retry #{run.attempt}</span>
              </>
            ) : null}
          </div>
        </div>
        {startedRelative ? (
          <Tooltip label={startedAbsolute}>
            <span className="mt-0.5 shrink-0 whitespace-nowrap text-[10px] text-fg-muted">
              {startedRelative}
            </span>
          </Tooltip>
        ) : null}
      </button>
    </li>
  );
}

function WorkflowRunDetailModal({
  open,
  repoPath,
  runId,
  onClose,
}: {
  open: boolean;
  repoPath: string;
  runId: number | null;
  onClose: () => void;
}) {
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const [listing, setListing] = useState<WorkflowRunDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || runId == null) {
      setListing(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const fetchDetail = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      return api
        .getWorkflowRunDetail(repoPath, runId)
        .then((result) => {
          if (cancelled) return result;
          setListing(result);
          setError(null);
          return result;
        })
        .catch((e) => {
          if (cancelled) return null;
          setError(String(e));
          return null;
        })
        .finally(() => {
          if (!cancelled && showSpinner) setLoading(false);
        });
    };

    setListing(null);
    setError(null);
    void fetchDetail(true);

    // Poll while the run is still going. Stops automatically once a
    // completed status lands so finished runs don't keep hitting `gh`.
    const handle = window.setInterval(() => {
      setListing((current) => {
        const stillRunning =
          current?.kind !== "ok" ||
          current.detail.status.toLowerCase() !== "completed";
        if (stillRunning) void fetchDetail(false);
        return current;
      });
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [open, repoPath, runId, refreshIntervalMs]);

  useDialogShortcuts(open, { onCancel: onClose });

  const detail = listing?.kind === "ok" ? listing.detail : null;
  const title =
    detail?.display_title.trim().length
      ? detail.display_title
      : detail?.workflow_name ?? "Workflow run";
  const subtitle = detail ? (
    <span className="flex flex-wrap items-center gap-1.5">
      <span>{detail.workflow_name}</span>
      <span className="opacity-50">·</span>
      <span>{detail.event}</span>
      {detail.head_branch ? (
        <>
          <span className="opacity-50">·</span>
          <span className="font-mono">{detail.head_branch}</span>
        </>
      ) : null}
      {detail.attempt > 1 ? (
        <>
          <span className="opacity-50">·</span>
          <span>retry #{detail.attempt}</span>
        </>
      ) : null}
    </span>
  ) : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      className="flex h-[36rem] flex-col"
    >
      <ModalHeader
        title={title}
        subtitle={subtitle}
        variant="dialog"
        icon={
          <span className="mt-0.5 flex self-start">
            {detail ? (
              <WorkflowRunStatusIcon
                status={detail.status}
                conclusion={detail.conclusion}
              />
            ) : (
              <Activity size={14} className="text-fg-muted" />
            )}
          </span>
        }
        actions={
          detail?.url ? (
            <button
              type="button"
              onClick={() => void openUrl(detail.url)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
              title="Open on GitHub"
            >
              <ExternalLink size={12} />
              GitHub
            </button>
          ) : null
        }
        onClose={onClose}
      />
      <div className="flex-1 min-h-0 overflow-y-auto text-xs">
        <div className="px-4 py-3">
        {error ? (
          <div className="p-2 text-danger">{error}</div>
        ) : loading || !listing ? (
          <WorkflowRunDetailSkeleton />
        ) : listing.kind === "not_github" ? (
          <Empty msg="Origin remote is not a GitHub repository." />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner
            slug={listing.slug}
            accounts={listing.accounts}
            repoPath={repoPath}
          />
        ) : (
          <WorkflowRunDetailBody detail={listing.detail} />
        )}
        </div>
      </div>
    </Modal>
  );
}

function WorkflowRunDetailSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="contents">
            <dt>
              <span className="block h-3 w-16 rounded bg-border/60" />
            </dt>
            <dd>
              <span
                className="block h-3 rounded bg-border/40"
                style={{ width: `${40 + ((i * 37) % 50)}%` }}
              />
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <span className="mb-1.5 block h-3 w-20 rounded bg-border/60" />
        <ul className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded border border-border/60 bg-bg/40 px-2 py-2"
            >
              <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-border/60" />
              <span
                className="h-3 rounded bg-border/40"
                style={{ width: `${50 + ((i * 23) % 30)}%` }}
              />
              <span className="ml-auto h-3 w-10 rounded bg-border/40" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function WorkflowRunDetailBody({ detail }: { detail: WorkflowRunDetail }) {
  const created = toUnixSeconds(detail.created_at);
  const updated = toUnixSeconds(detail.updated_at);
  const totalDuration = formatRunDuration(
    detail.started_at ?? detail.created_at,
    detail.status,
    detail.updated_at,
  );
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-fg-muted">
        <dt className="opacity-70">Status</dt>
        <dd className="text-fg">
          {detail.status}
          {detail.conclusion ? ` · ${detail.conclusion}` : ""}
        </dd>
        {totalDuration ? (
          <>
            <dt className="opacity-70">Total duration</dt>
            <dd className="text-fg">
              {totalDuration}
              {detail.status.toLowerCase() !== "completed" ? (
                <span className="ml-1 text-fg-muted">(running)</span>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt className="opacity-70">Attempt</dt>
        <dd className="text-fg">
          #{detail.attempt}
          {detail.attempt > 1 ? (
            <span className="ml-1 text-fg-muted">(retried)</span>
          ) : null}
        </dd>
        <dt className="opacity-70">Commit</dt>
        <dd className="font-mono text-fg">{detail.head_sha.slice(0, 7)}</dd>
        {created > 0 ? (
          <>
            <dt className="opacity-70">Created</dt>
            <dd className="text-fg">{absoluteTime(created)}</dd>
          </>
        ) : null}
        {updated > 0 ? (
          <>
            <dt className="opacity-70">Updated</dt>
            <dd className="text-fg">{absoluteTime(updated)}</dd>
          </>
        ) : null}
      </dl>
      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          Jobs ({detail.jobs.length})
        </div>
        {detail.jobs.length === 0 ? (
          <div className="text-[11px] text-fg-muted">No jobs reported.</div>
        ) : (
          <ul className="rounded border border-border/60 divide-y divide-border/40">
            {detail.jobs.map((job) => (
              <WorkflowJobRow key={job.id} job={job} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WorkflowJobRow({ job }: { job: WorkflowJob }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatJobDuration(job.started_at, job.completed_at);
  return (
    <li className="bg-bg/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left transition",
          "sticky top-0 z-10 bg-bg-elevated hover:bg-bg-sidebar",
          expanded ? "border-b border-border/40" : "",
        )}
      >
        <WorkflowRunStatusIcon
          status={job.status}
          conclusion={job.conclusion}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-fg">
          {job.name}
        </span>
        {duration ? (
          <span className="shrink-0 text-[11px] text-fg-muted">{duration}</span>
        ) : null}
        {job.url ? (
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(job.url);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                void openUrl(job.url);
              }
            }}
            className="shrink-0 cursor-pointer rounded p-0.5 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
            title="Open job on GitHub"
          >
            <ExternalLink size={11} />
          </span>
        ) : null}
      </button>
      {expanded && job.steps.length > 0 ? (
        <ol className="space-y-0.5 px-2 py-1.5 text-xs">
          {job.steps.map((step) => (
            <WorkflowStepRow key={`${step.number}-${step.name}`} step={step} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function WorkflowStepRow({ step }: { step: WorkflowJobStep }) {
  return (
    <li className="flex items-center gap-2">
      <span className="w-5 shrink-0 text-right font-mono text-[11px] text-fg-muted">
        {step.number}
      </span>
      <WorkflowRunStatusIcon
        status={step.status}
        conclusion={step.conclusion}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-fg">
        {step.name}
      </span>
    </li>
  );
}

function formatRunDuration(
  startedAt: string,
  status: string,
  updatedAt: string,
): string {
  const start = toUnixSeconds(startedAt);
  if (start <= 0) return "";
  const completed = status.toLowerCase() === "completed";
  const end = completed
    ? toUnixSeconds(updatedAt) || Math.floor(Date.now() / 1000)
    : Math.floor(Date.now() / 1000);
  return formatDurationSeconds(Math.max(0, end - start));
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem === 0 ? `${hours}h` : `${hours}h ${minRem}m`;
}

function formatJobDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt) return "";
  const start = toUnixSeconds(startedAt);
  if (start <= 0) return "";
  const end = completedAt ? toUnixSeconds(completedAt) : Math.floor(Date.now() / 1000);
  return formatDurationSeconds(Math.max(0, end - start));
}

function WorkflowRunStatusIcon({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  const s = status.toLowerCase();
  if (s !== "completed") {
    if (s === "queued" || s === "pending" || s === "waiting" || s === "requested") {
      return (
        <CircleDashed size={14} className="shrink-0 text-fg-muted" />
      );
    }
    // in_progress and anything else still running
    return (
      <Loader2
        size={14}
        className="shrink-0 animate-spin text-accent"
      />
    );
  }
  switch ((conclusion ?? "").toLowerCase()) {
    case "success":
      return <CircleCheck size={14} className="shrink-0 text-emerald-400" />;
    case "failure":
    case "timed_out":
    case "startup_failure":
      return <CircleX size={14} className="shrink-0 text-rose-400" />;
    case "cancelled":
      return <MinusCircle size={14} className="shrink-0 text-fg-muted" />;
    case "action_required":
      return <CircleAlert size={14} className="shrink-0 text-amber-400" />;
    case "skipped":
    case "neutral":
      return <MinusCircle size={14} className="shrink-0 text-fg-muted" />;
    default:
      return <CircleDashed size={14} className="shrink-0 text-fg-muted" />;
  }
}

function NoAccessBanner({
  slug,
  accounts,
  repoPath,
}: {
  slug: string;
  accounts: AccountSummary[];
  repoPath: string;
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
      <p className="flex flex-wrap items-center gap-1.5 opacity-70">
        Run
        <CommandHint command="gh auth login" repoPath={repoPath} />
        with an account that has access, or accept the invitation on
        github.com.
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

/**
 * Shared row used by the PRs tab and the PR search modal. Keeps the visual
 * shape identical across both surfaces so the search modal feels like a
 * filtered view of the same list.
 */
function PrRow({
  pr,
  onOpen,
  onContextMenu,
  surface = "panel",
  showAvatar = false,
}: {
  pr: PullRequestInfo;
  onOpen: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  /**
   * Background context the row sits on. `panel` is the right-panel
   * (`bg-bg`), `dialog` is the modal surface (`bg-bg-elevated`) — each
   * needs a different hover color to actually feel interactive.
   */
  surface?: "panel" | "dialog";
  /**
   * Render the author's GitHub avatar to the left of the row. Bumps the
   * row's vertical footprint slightly in exchange for at-a-glance author
   * recognition. Controlled by the `github.showAvatars` setting.
   */
  showAvatar?: boolean;
}) {
  const hoverBg =
    surface === "dialog"
      ? "hover:bg-bg-sidebar focus-visible:bg-bg-sidebar"
      : "hover:bg-bg-elevated/50 focus-visible:bg-bg-elevated/60";
  // Avatar rows get a touch more leading + larger text so the avatar
  // doesn't dominate visually. Plain rows stay compact at the prior size.
  const titleSize = showAvatar ? "text-[13px]" : "text-xs";
  const metaSize = showAvatar ? "text-[11px]" : "text-[10px]";
  return (
    <li
      role="button"
      tabIndex={0}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-3 py-2 text-left transition focus-visible:outline-none",
        hoverBg,
      )}
    >
      <span
        className={cn(
          "flex w-full min-w-0 items-center gap-2",
          titleSize,
        )}
      >
        <span className="shrink-0 font-mono text-fg-muted">#{pr.number}</span>
        <PrStateBadge state={pr.state} isDraft={pr.is_draft} />
        <Tooltip
          label={pr.title}
          side="top"
          multiline
          className="flex! min-w-0 flex-1"
        >
          <span className="min-w-0 flex-1 truncate text-fg">{pr.title}</span>
        </Tooltip>
      </span>
      <span
        className={cn(
          "flex w-full min-w-0 items-center gap-2 text-fg-muted",
          metaSize,
        )}
      >
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          {showAvatar ? <AuthorAvatar login={pr.author} size={14} /> : null}
          <span className="truncate">{pr.author}</span>
        </span>
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
  );
}

const PR_SEARCH_STATE_OPTIONS: { value: PrStateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];

/**
 * Modal-scoped PR search. Queries gh server-side via `--search`, so it
 * reaches every PR in the repo rather than filtering the (capped) list that
 * the PRs tab currently displays. Empty query → no fetch; results paginate
 * by growing `limit` on scroll, mirroring the main tab's pattern.
 */
function PullRequestSearchModal({
  open,
  detailOpen,
  onClose,
  onOpenDetail,
}: {
  open: { repoPath: string } | null;
  /**
   * True while the PR detail modal stacks on top. Used to suppress this
   * modal's ESC handler so the top-of-stack closes first.
   */
  detailOpen: boolean;
  onClose: () => void;
  onOpenDetail: (number: number) => void;
}) {
  const repoPath = open?.repoPath ?? null;
  const showAvatars = useSettings((s) => s.settings.github.showAvatars);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("all");
  const [listing, setListing] = useState<PullRequestListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(PR_PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Refetch trigger used by row actions after a merge/close so the modal
  // updates without the user reopening it.
  const [refetchTick, setRefetchTick] = useState(0);
  const rowActions = usePrRowActions(
    repoPath ?? "",
    onOpenDetail,
    () => setRefetchTick((v) => v + 1),
  );

  useDialogShortcuts(open !== null && !detailOpen, { onCancel: onClose });

  // Wipe transient state every time the modal opens so a reopen never shows
  // results from the previous session.
  useEffect(() => {
    if (!open) return;
    setRawQuery("");
    setDebouncedQuery("");
    setStateFilter("all");
    setListing(null);
    setError(null);
    setLimit(PR_PAGE_SIZE);
    // Defer focus until after the portal mounts so autoFocus on the input
    // wins over Modal's own focus handling.
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Debounce the input so typing doesn't fire a `gh` spawn per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(rawQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // Reset pagination when the search inputs change — a new query starts at
  // the first page rather than inheriting the previous query's growth.
  useEffect(() => {
    setLimit(PR_PAGE_SIZE);
    setListing(null);
  }, [debouncedQuery, stateFilter]);

  useEffect(() => {
    if (!open || !repoPath) return;
    if (!debouncedQuery) {
      setListing(null);
      setError(null);
      setLoading(false);
      return;
    }
    const signal = { cancelled: false };
    setLoading(true);
    api
      .listPullRequests(repoPath, stateFilter, limit, debouncedQuery)
      .then((result) => {
        if (signal.cancelled) return;
        setListing(result);
        setError(null);
      })
      .catch((e) => {
        if (signal.cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false);
      });
    return () => {
      signal.cancelled = true;
    };
  }, [open, repoPath, debouncedQuery, stateFilter, limit, refetchTick]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (loading) return;
    if (!listing || listing.kind !== "ok") return;
    if (listing.items.length < limit) return;
    if (limit >= PR_PAGE_MAX) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setLimit((prev) => Math.min(prev + PR_PAGE_SIZE, PR_PAGE_MAX));
    }
  }

  const reachedMax =
    listing?.kind === "ok" &&
    listing.items.length >= limit &&
    limit >= PR_PAGE_MAX;

  return (
    <Modal
      open={open !== null}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabel="Search pull requests"
    >
      <ModalHeader
        title="Search pull requests"
        icon={<Search size={14} className="text-fg-muted" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <TextInput
          ref={inputRef}
          value={rawQuery}
          onChange={(e) => setRawQuery(e.currentTarget.value)}
          placeholder="Search title, author, label, branch…"
          autoFocus
        />
        <div className="flex items-center gap-1 text-[11px]">
          {PR_SEARCH_STATE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStateFilter(opt.value)}
              className={cn(
                "rounded px-2 py-0.5 transition",
                stateFilter === opt.value
                  ? "bg-bg text-fg"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {opt.label}
            </button>
          ))}
          {loading ? (
            <span className="ml-auto text-fg-muted">Searching…</span>
          ) : listing?.kind === "ok" ? (
            <span className="ml-auto font-mono text-fg-muted">
              {listing.items.length}
              {listing.items.length >= limit && limit < PR_PAGE_MAX ? "+" : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="h-[60vh] overflow-y-auto"
        onScroll={handleScroll}
      >
        {!debouncedQuery ? (
          <Empty msg="Type to search pull requests." />
        ) : error || rowActions.error ? (
          <div className="p-3 text-xs text-danger">
            {error ?? rowActions.error}
          </div>
        ) : !listing ? (
          <PrSkeletonList count={6} />
        ) : listing.kind === "not_github" ? (
          <Empty msg="Origin remote is not a GitHub repository." />
        ) : listing.kind === "no_access" ? (
          <div className="p-3 text-xs text-fg-muted">
            No logged-in gh account can access this repo.
          </div>
        ) : listing.items.length === 0 ? (
          <Empty msg="No matching pull requests." />
        ) : (
          <ul className="text-xs">
            {listing.items.map((pr) => (
              <PrRow
                key={pr.number}
                pr={pr}
                surface="dialog"
                showAvatar={showAvatars}
                onOpen={() => onOpenDetail(pr.number)}
                onContextMenu={(e) => rowActions.openContextMenu(e, pr)}
              />
            ))}
            {loading && listing.items.length >= limit ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                Loading more…
              </li>
            ) : null}
            {reachedMax ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                Showing first {PR_PAGE_MAX}. Refine the query for older PRs.
              </li>
            ) : null}
          </ul>
        )}
      </div>
      {rowActions.overlays}
    </Modal>
  );
}
