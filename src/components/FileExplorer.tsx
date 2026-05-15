import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File as FileIcon,
  RefreshCw,
  EyeOff,
  Eye,
  Filter,
} from "lucide-react";
import { api, type FsEntry, FS_CHANGED_EVENT } from "../lib/api";
import type { FsChangePayload } from "../lib/api";
import { cn } from "../lib/cn";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const SHOW_HIDDEN_KEY = "acorn:fs-show-hidden";
const RESPECT_GITIGNORE_KEY = "acorn:fs-respect-gitignore";

interface FileExplorerProps {
  rootPath: string;
}

interface DirState {
  entries: FsEntry[] | null;
  loading: boolean;
  error: string | null;
}

type Cache = Record<string, DirState>;

interface DraftCreate {
  parentPath: string;
  kind: "file" | "dir";
  value: string;
}

interface DraftRename {
  path: string;
  value: string;
}

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry | null;
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return parent + name;
  return parent + "/" + name;
}

function getLocalBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

function setLocalBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* localStorage may be denied in some webview modes; safe to swallow */
  }
}

export function FileExplorer({ rootPath }: FileExplorerProps) {
  const [cache, setCache] = useState<Cache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(() =>
    getLocalBool(SHOW_HIDDEN_KEY, false),
  );
  const [respectGitignore, setRespectGitignore] = useState(() =>
    getLocalBool(RESPECT_GITIGNORE_KEY, true),
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draftCreate, setDraftCreate] = useState<DraftCreate | null>(null);
  const [draftRename, setDraftRename] = useState<DraftRename | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalBool(SHOW_HIDDEN_KEY, showHidden);
  }, [showHidden]);
  useEffect(() => {
    setLocalBool(RESPECT_GITIGNORE_KEY, respectGitignore);
  }, [respectGitignore]);

  const fetchDir = useCallback(
    async (path: string) => {
      setCache((prev) => ({
        ...prev,
        [path]: {
          entries: prev[path]?.entries ?? null,
          loading: true,
          error: null,
        },
      }));
      try {
        const res = await api.fsListDir(path, showHidden, respectGitignore);
        setCache((prev) => ({
          ...prev,
          [path]: { entries: res.entries, loading: false, error: null },
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setCache((prev) => ({
          ...prev,
          [path]: {
            entries: prev[path]?.entries ?? null,
            loading: false,
            error: msg,
          },
        }));
      }
    },
    [showHidden, respectGitignore],
  );

  // Re-fetch root and every currently-loaded path whenever filter toggles
  // change or the root itself swaps in. StrictMode-safe: each effect run
  // races at most one fetch per path; later runs overwrite earlier results.
  useEffect(() => {
    let cancelled = false;
    const paths = [rootPath, ...Array.from(expanded)];
    void Promise.all(paths.map((p) => (cancelled ? null : fetchDir(p))));
    return () => {
      cancelled = true;
    };
    // We intentionally do not depend on `expanded` here — only the rootPath
    // and filter toggles invalidate the full set. Expansion triggers a
    // targeted `fetchDir` in `toggleDir`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, showHidden, respectGitignore, fetchDir]);

  // Bind backend watcher to current root.
  useEffect(() => {
    void api.fsWatchSetRoot(rootPath).catch((e) => {
      console.debug("[FileExplorer] fs_watch_set_root failed", e);
    });
    return () => {
      void api.fsWatchSetRoot(null).catch(() => {});
    };
  }, [rootPath]);

  // Reset state on root change so previous project's tree is not flashed.
  const rootRef = useRef(rootPath);
  useEffect(() => {
    if (rootRef.current !== rootPath) {
      rootRef.current = rootPath;
      setCache({});
      setExpanded(new Set());
      setDraftCreate(null);
      setDraftRename(null);
      setActivePath(null);
    }
  }, [rootPath]);

  // Listen for backend fs-changed events and refresh the parent dir of
  // each changed path. Backend emits raw notify events, no debouncing —
  // collapse here within a 100ms window to avoid refresh storms.
  useEffect(() => {
    let cancel: (() => void) | null = null;
    const pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const toFetch = Array.from(pending);
      pending.clear();
      for (const dir of toFetch) {
        if (cache[dir] || dir === rootPath) {
          void fetchDir(dir);
        }
      }
    };
    void listen<FsChangePayload>(FS_CHANGED_EVENT, (event) => {
      for (const p of event.payload.paths) {
        pending.add(parentOf(p));
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    }).then((unlisten) => {
      cancel = unlisten;
    });
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      if (cancel) cancel();
    };
  }, [rootPath, fetchDir, cache]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!cache[path]?.entries) {
            void fetchDir(path);
          }
        }
        return next;
      });
    },
    [cache, fetchDir],
  );

  const openInEditor = useCallback(async (entry: FsEntry) => {
    setActivePath(entry.path);
    try {
      // Resolve which session to write into by walking the focused pane.
      // Avoid a cross-module dep on the store by inlining the lookup.
      const store = await import("../store");
      const state = store.useAppStore.getState();
      const sid = state.activeSessionId;
      if (!sid) {
        setError("No active session — open a terminal first");
        return;
      }
      // Shell expands $EDITOR. Quote the path. Trailing \n executes.
      const escaped = entry.path.replace(/(["\\$`])/g, "\\$1");
      await api.ptyWrite(sid, `$EDITOR "${escaped}"\n`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (!draftCreate) return;
    const { parentPath, kind, value } = draftCreate;
    const name = value.trim();
    if (!name) {
      setDraftCreate(null);
      return;
    }
    const target = joinPath(parentPath, name);
    try {
      if (kind === "file") {
        await api.fsCreateFile(target);
      } else {
        await api.fsCreateDir(target);
      }
      setDraftCreate(null);
      await fetchDir(parentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draftCreate, fetchDir]);

  const handleRename = useCallback(async () => {
    if (!draftRename) return;
    const { path, value } = draftRename;
    const name = value.trim();
    if (!name) {
      setDraftRename(null);
      return;
    }
    const target = joinPath(parentOf(path), name);
    if (target === path) {
      setDraftRename(null);
      return;
    }
    try {
      await api.fsRename(path, target);
      setDraftRename(null);
      await fetchDir(parentOf(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draftRename, fetchDir]);

  const handleTrash = useCallback(
    async (entry: FsEntry) => {
      try {
        await api.fsTrash(entry.path);
        await fetchDir(parentOf(entry.path));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [fetchDir],
  );

  const openMenu = useCallback(
    (e: React.MouseEvent, entry: FsEntry | null) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, entry });
    },
    [],
  );

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menu) return [];
    const entry = menu.entry;
    const parentForCreate = entry?.is_dir ? entry.path : rootPath;
    const items: ContextMenuItem[] = [];
    if (entry && !entry.is_dir) {
      items.push({
        label: "Open in $EDITOR",
        onClick: () => void openInEditor(entry),
      });
      items.push({ type: "separator" });
    }
    items.push({
      label: "New file",
      onClick: () => {
        if (entry?.is_dir && !expanded.has(entry.path)) {
          toggleDir(entry.path);
        }
        setDraftCreate({ parentPath: parentForCreate, kind: "file", value: "" });
      },
    });
    items.push({
      label: "New folder",
      onClick: () => {
        if (entry?.is_dir && !expanded.has(entry.path)) {
          toggleDir(entry.path);
        }
        setDraftCreate({ parentPath: parentForCreate, kind: "dir", value: "" });
      },
    });
    if (entry) {
      items.push({ type: "separator" });
      items.push({
        label: "Rename",
        onClick: () => setDraftRename({ path: entry.path, value: entry.name }),
      });
      items.push({
        label: "Move to Trash",
        onClick: () => void handleTrash(entry),
      });
      items.push({ type: "separator" });
      items.push({
        label: "Copy path",
        onClick: () => {
          void navigator.clipboard.writeText(entry.path).catch(() => {
            setError("Clipboard write failed");
          });
        },
      });
      items.push({
        label: "Reveal in file manager",
        onClick: () => {
          void api.fsReveal(entry.path).catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
          });
        },
      });
    }
    return items;
  }, [menu, rootPath, expanded, toggleDir, openInEditor, handleTrash]);

  return (
    <div
      className="flex h-full w-full flex-col"
      onContextMenu={(e) => openMenu(e, null)}
    >
      <Toolbar
        rootPath={rootPath}
        showHidden={showHidden}
        respectGitignore={respectGitignore}
        onToggleHidden={() => setShowHidden((v) => !v)}
        onToggleGitignore={() => setRespectGitignore((v) => !v)}
        onRefresh={() => void fetchDir(rootPath)}
        onNewFile={() =>
          setDraftCreate({ parentPath: rootPath, kind: "file", value: "" })
        }
        onNewFolder={() =>
          setDraftCreate({ parentPath: rootPath, kind: "dir", value: "" })
        }
      />
      <div className="flex-1 overflow-auto py-1 text-[12px]">
        <DirNode
          path={rootPath}
          depth={0}
          state={cache[rootPath]}
          isRoot
          expanded={expanded}
          cache={cache}
          activePath={activePath}
          draftCreate={draftCreate}
          draftRename={draftRename}
          onToggleDir={toggleDir}
          onOpenEntry={openInEditor}
          onContextMenu={openMenu}
          onCommitCreate={handleCreate}
          onCancelCreate={() => setDraftCreate(null)}
          onChangeCreate={(v) =>
            setDraftCreate((prev) => (prev ? { ...prev, value: v } : prev))
          }
          onCommitRename={handleRename}
          onCancelRename={() => setDraftRename(null)}
          onChangeRename={(v) =>
            setDraftRename((prev) => (prev ? { ...prev, value: v } : prev))
          }
        />
      </div>
      {error ? (
        <div className="flex items-start gap-2 border-t border-border bg-bg-error/20 px-3 py-1.5 text-[11px] text-fg">
          <span className="flex-1 break-all">{error}</span>
          <button
            type="button"
            className="text-fg-muted hover:text-fg"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      ) : null}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

interface ToolbarProps {
  rootPath: string;
  showHidden: boolean;
  respectGitignore: boolean;
  onToggleHidden: () => void;
  onToggleGitignore: () => void;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

function Toolbar(props: ToolbarProps) {
  const rootName = props.rootPath.split("/").filter(Boolean).pop() ?? "/";
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
      <span
        className="flex-1 truncate font-medium text-fg-muted"
        title={props.rootPath}
      >
        {rootName.toUpperCase()}
      </span>
      <ToolbarBtn label="New file" onClick={props.onNewFile}>
        <FileIcon size={12} />
      </ToolbarBtn>
      <ToolbarBtn label="New folder" onClick={props.onNewFolder}>
        <Folder size={12} />
      </ToolbarBtn>
      <ToolbarBtn
        label={props.showHidden ? "Hide dotfiles" : "Show dotfiles"}
        active={props.showHidden}
        onClick={props.onToggleHidden}
      >
        {props.showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
      </ToolbarBtn>
      <ToolbarBtn
        label={
          props.respectGitignore
            ? "Show gitignored"
            : "Hide gitignored"
        }
        active={!props.respectGitignore}
        onClick={props.onToggleGitignore}
      >
        <Filter size={12} />
      </ToolbarBtn>
      <ToolbarBtn label="Refresh" onClick={props.onRefresh}>
        <RefreshCw size={12} />
      </ToolbarBtn>
    </div>
  );
}

function ToolbarBtn({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "rounded p-1 transition",
        active
          ? "bg-fg-muted/15 text-fg"
          : "text-fg-muted hover:bg-fg-muted/10 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

interface DirNodeProps {
  path: string;
  depth: number;
  state: DirState | undefined;
  isRoot?: boolean;
  expanded: Set<string>;
  cache: Cache;
  activePath: string | null;
  draftCreate: DraftCreate | null;
  draftRename: DraftRename | null;
  onToggleDir: (path: string) => void;
  onOpenEntry: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry | null) => void;
  onCommitCreate: () => void;
  onCancelCreate: () => void;
  onChangeCreate: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onChangeRename: (v: string) => void;
}

function DirNode(props: DirNodeProps) {
  const { state, path, isRoot } = props;
  const entries = state?.entries ?? [];
  const loading = state?.loading ?? false;
  const error = state?.error ?? null;

  return (
    <>
      {error ? (
        <div
          className="px-2 py-1 text-[11px] text-fg-muted"
          style={{ paddingLeft: 8 + props.depth * 12 }}
        >
          {error}
        </div>
      ) : null}
      {!isRoot && entries.length === 0 && !loading && !error ? (
        <div
          className="px-2 py-0.5 text-[11px] italic text-fg-muted/60"
          style={{ paddingLeft: 8 + props.depth * 12 }}
        >
          (empty)
        </div>
      ) : null}
      {entries.map((entry) =>
        props.draftRename?.path === entry.path ? (
          <EditRow
            key={entry.path}
            depth={props.depth}
            icon={
              entry.is_dir ? <Folder size={13} /> : <FileIcon size={13} />
            }
            value={props.draftRename.value}
            onChange={props.onChangeRename}
            onCommit={props.onCommitRename}
            onCancel={props.onCancelRename}
          />
        ) : (
          <EntryRow
            key={entry.path}
            entry={entry}
            depth={props.depth}
            expanded={props.expanded.has(entry.path)}
            isActive={props.activePath === entry.path}
            onToggleDir={props.onToggleDir}
            onOpenEntry={props.onOpenEntry}
            onContextMenu={props.onContextMenu}
          >
            {entry.is_dir && props.expanded.has(entry.path) ? (
              <DirNode {...props} path={entry.path} depth={props.depth + 1} state={props.cache[entry.path]} isRoot={false} />
            ) : null}
            {entry.is_dir &&
            props.expanded.has(entry.path) &&
            props.draftCreate?.parentPath === entry.path ? (
              <EditRow
                depth={props.depth + 1}
                icon={
                  props.draftCreate.kind === "dir" ? (
                    <Folder size={13} />
                  ) : (
                    <FileIcon size={13} />
                  )
                }
                value={props.draftCreate.value}
                onChange={props.onChangeCreate}
                onCommit={props.onCommitCreate}
                onCancel={props.onCancelCreate}
              />
            ) : null}
          </EntryRow>
        ),
      )}
      {isRoot && props.draftCreate?.parentPath === path ? (
        <EditRow
          depth={props.depth}
          icon={
            props.draftCreate.kind === "dir" ? (
              <Folder size={13} />
            ) : (
              <FileIcon size={13} />
            )
          }
          value={props.draftCreate.value}
          onChange={props.onChangeCreate}
          onCommit={props.onCommitCreate}
          onCancel={props.onCancelCreate}
        />
      ) : null}
      {loading && entries.length === 0 ? (
        <div
          className="px-2 py-1 text-[11px] text-fg-muted/60"
          style={{ paddingLeft: 8 + props.depth * 12 }}
        >
          Loading…
        </div>
      ) : null}
    </>
  );
}

interface EntryRowProps {
  entry: FsEntry;
  depth: number;
  expanded: boolean;
  isActive: boolean;
  onToggleDir: (path: string) => void;
  onOpenEntry: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  children?: React.ReactNode;
}

function EntryRow({
  entry,
  depth,
  expanded,
  isActive,
  onToggleDir,
  onOpenEntry,
  onContextMenu,
  children,
}: EntryRowProps) {
  const onClick = () => {
    if (entry.is_dir) onToggleDir(entry.path);
    else onOpenEntry(entry);
  };
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        onContextMenu={(e) => {
          e.stopPropagation();
          onContextMenu(e, entry);
        }}
        className={cn(
          "flex w-full items-center gap-1 truncate px-2 py-0.5 text-left transition",
          isActive
            ? "bg-accent/15 text-fg"
            : "text-fg hover:bg-fg-muted/10",
          entry.gitignored ? "opacity-60" : "",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={entry.path}
      >
        {entry.is_dir ? (
          <span className="shrink-0 text-fg-muted">
            {expanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
          </span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 text-fg-muted">
          {entry.is_dir ? (
            expanded ? (
              <FolderOpen size={13} />
            ) : (
              <Folder size={13} />
            )
          ) : (
            <FileIcon size={13} />
          )}
        </span>
        <span className="truncate">
          {entry.name}
          {entry.is_symlink ? (
            <span className="ml-1 text-fg-muted">↪</span>
          ) : null}
        </span>
      </button>
      {children}
    </>
  );
}

interface EditRowProps {
  depth: number;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function EditRow({
  depth,
  icon,
  value,
  onChange,
  onCommit,
  onCancel,
}: EditRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div
      className="flex w-full items-center gap-1 px-2 py-0.5"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-3 shrink-0" />
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={onCommit}
        className="w-full bg-transparent text-[12px] text-fg outline outline-1 outline-accent/40 focus:outline-accent"
      />
    </div>
  );
}
