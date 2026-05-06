import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  ExternalLink,
  FileDiff,
  GitCommit,
  Globe,
  ListTodo,
  Maximize2,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Panel, PanelGroup } from "react-resizable-panels";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openFileInEditor } from "../lib/editor";
import { joinPath } from "../lib/paths";
import { useAppStore } from "../store";
import type {
  CommitInfo,
  DiffPayload,
  StagedFile,
  TodoItem,
} from "../lib/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffView } from "./DiffView";
import { DiffViewerModal } from "./DiffViewerModal";
import { ResizeHandle } from "./ResizeHandle";

interface ExpandedDiff {
  payload: DiffPayload;
  title: string;
  subtitle?: string;
}

const COMMITS_PAGE_SIZE = 50;
const COMMIT_ROW_HEIGHT = 48;

export function RightPanel() {
  const { sessions, activeSessionId, rightTab, setRightTab } = useAppStore();
  const active = sessions.find((s) => s.id === activeSessionId);
  const [expanded, setExpanded] = useState<ExpandedDiff | null>(null);

  return (
    <aside className="flex h-full w-full flex-col bg-bg-sidebar">
      <nav className="flex shrink-0 border-b border-border">
        <TabButton
          icon={<ListTodo size={14} />}
          label="Todos"
          active={rightTab === "todos"}
          onClick={() => setRightTab("todos")}
        />
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
      </nav>
      <div className="flex-1 overflow-hidden">
        {!active ? (
          <Empty msg="No session selected" />
        ) : rightTab === "todos" ? (
          <TodosTab
            sessionId={active.id}
            cwd={active.worktree_path}
          />
        ) : rightTab === "commits" ? (
          <CommitsTab
            repoPath={active.worktree_path}
            onExpand={setExpanded}
          />
        ) : (
          <StagedTab
            repoPath={active.worktree_path}
            onExpand={setExpanded}
          />
        )}
      </div>
      <DiffViewerModal
        payload={expanded?.payload ?? null}
        title={expanded?.title ?? ""}
        subtitle={expanded?.subtitle}
        cwd={active?.worktree_path}
        onClose={() => setExpanded(null)}
      />
    </aside>
  );
}

interface TabButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

function TabButton({ icon, label, active, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs transition",
        active
          ? "text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent/30"
          : "text-fg-muted hover:text-fg",
      )}
    >
      {icon}
      {label}
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

const TODOS_POLL_INTERVAL_MS = 1500;

function TodosTab({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setTodos([]);

    const poll = async () => {
      try {
        const result = await api.readSessionTodos(sessionId, cwd);
        if (cancelled) return;
        setTodos(result);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    poll();
    const handle = setInterval(poll, TODOS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [sessionId, cwd]);

  if (error) {
    return <div className="p-3 text-xs text-danger">{error}</div>;
  }
  if (!loaded) {
    return <Empty msg="Loading todos..." />;
  }
  if (todos.length === 0) {
    return (
      <div className="p-3 text-xs text-fg-muted">
        <p>No todos yet.</p>
        <p className="mt-1 opacity-60">
          Todos appear once Claude calls `TodoWrite` or `TaskCreate` in this
          session.
        </p>
      </div>
    );
  }

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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    commit: CommitInfo;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setError(null);
    setSelected(null);
    setDiff(null);
    setHasMore(true);
    setLoadingMore(false);
    api
      .listCommits(repoPath, 0, COMMITS_PAGE_SIZE)
      .then((page) => {
        setCommits(page);
        setHasMore(page.length === COMMITS_PAGE_SIZE);
      })
      .catch((e) => setError(String(e)));
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, commit: c });
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs transition",
                      selected === c.sha
                        ? "bg-bg-elevated"
                        : "hover:bg-bg-elevated/50",
                    )}
                    title={absoluteTime(c.timestamp)}
                    style={{ height: COMMIT_ROW_HEIGHT }}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-accent">
                        {c.short_sha}
                      </span>
                      <span className="truncate text-fg">{c.summary}</span>
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-2 text-[10px] text-fg-muted">
                      <span className="truncate">{c.author}</span>
                      <span className="opacity-50">·</span>
                      <span className="font-mono">
                        {relativeTime(c.timestamp)}
                      </span>
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: StagedFile;
  } | null>(null);

  useEffect(() => {
    setError(null);
    Promise.all([api.listStaged(repoPath), api.stagedDiff(repoPath)])
      .then(([f, d]) => {
        setFiles(f);
        setDiff(d);
      })
      .catch((e) => setError(String(e)));
  }, [repoPath]);

  function isDeleted(file: StagedFile): boolean {
    return file.status.toLowerCase().includes("delete");
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

  if (error) return <div className="p-3 text-xs text-danger">{error}</div>;
  if (files.length === 0) return <Empty msg="No staged or modified files" />;

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
              className="flex cursor-default items-center gap-2 px-3 py-1.5 font-mono text-xs hover:bg-bg-elevated/40"
            >
              <span className="w-24 shrink-0 truncate text-fg-muted">
                {f.status}
              </span>
              <span className="truncate text-fg">{f.path}</span>
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
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
    </PanelGroup>
  );
}
