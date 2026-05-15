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
  Copy,
  Link2,
  MessageSquarePlus,
  Pencil,
  Trash2,
  ExternalLink,
  Edit3,
  EyeOff,
  Eye,
  Filter,
  Search,
  Regex,
  TerminalSquare,
  X,
} from "lucide-react";
import { api, type FsEntry, FS_CHANGED_EVENT } from "../lib/api";
import type { FsChangePayload, FsGitStatus, FsGitStatusEntry } from "../lib/api";
import { cn } from "../lib/cn";
import type { TranslationKey, Translator } from "../lib/i18n";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { setFileDragPayload } from "../lib/dnd";
import { Tooltip } from "./Tooltip";
import { IconInput, TextInput } from "./ui";
import { useTranslation } from "../lib/useTranslation";

const SHOW_HIDDEN_KEY = "acorn:fs-show-hidden";
const RESPECT_GITIGNORE_KEY = "acorn:fs-respect-gitignore";

type FileExplorerTranslationKey = Extract<TranslationKey, `fileExplorer.${string}`>;

function fileExplorerText(
  t: Translator,
  key: FileExplorerTranslationKey,
): string {
  return t(key);
}

interface FileExplorerProps {
  rootPath: string;
}

interface DirState {
  entries: FsEntry[] | null;
  loading: boolean;
  error: string | null;
}

type Cache = Record<string, DirState>;

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

interface MatcherResult {
  matcher: ((name: string) => boolean) | null;
  invalidRegex: boolean;
}

function globToRegex(glob: string, flags: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if ("^$.|+()[]{}\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(re, flags);
}

function buildQueryMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): MatcherResult {
  const q = query.trim();
  if (!q) return { matcher: null, invalidRegex: false };
  const flags = caseSensitive ? "" : "i";
  if (regex) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(q, flags);
    } catch {
      // Regex compile failed — fall through and try glob.
    }
    if (!re && (q.includes("*") || q.includes("?"))) {
      try {
        re = globToRegex(q, flags);
      } catch {
        re = null;
      }
    }
    if (re) {
      const compiled = re;
      return { matcher: (name) => compiled.test(name), invalidRegex: false };
    }
    return { matcher: null, invalidRegex: true };
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  return {
    matcher: caseSensitive
      ? (name) => name.includes(needle)
      : (name) => name.toLowerCase().includes(needle),
    invalidRegex: false,
  };
}

/**
 * Compile a comma-separated glob list (e.g. `*.ts, *.tsx, **\/test/*`) into
 * a name predicate. Returns null when the list is empty so callers can
 * treat "no filter" distinctly from "matches none".
 */
function buildGlobListMatcher(
  list: string,
): ((name: string) => boolean) | null {
  const parts = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const compiled: RegExp[] = [];
  for (const p of parts) {
    try {
      compiled.push(globToRegex(p, "i"));
    } catch {
      // Skip invalid entries silently — VSCode-style behavior.
    }
  }
  if (compiled.length === 0) return null;
  return (name) => compiled.some((re) => re.test(name));
}

/**
 * Build a set of directory paths that contain at least one git-dirty
 * descendant. Used to roll the modified/added/deleted color up to
 * parent folders so the tree surfaces dirty subtrees even when
 * collapsed.
 */
function buildDirtyAncestors(
  status: Record<string, FsGitStatusEntry>,
  rootPath: string,
): Set<string> {
  const out = new Set<string>();
  for (const p of Object.keys(status)) {
    let cur = p;
    while (true) {
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break;
      const parent = cur.slice(0, idx);
      if (parent === rootPath || !parent.startsWith(rootPath)) break;
      out.add(parent);
      cur = parent;
    }
  }
  return out;
}

/**
 * POSIX shell-quote a path with single quotes. Inside `'…'` every byte
 * except `'` is literal — even newlines, `!`, `$`, backticks. The only
 * escape needed is closing the quote, inserting a literal `'`, and
 * reopening: `'\''`. Safer than the double-quote + char-class regex
 * dance because it cannot be defeated by history expansion or by an
 * unescaped metacharacter that we forgot to list.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function relativeTo(base: string, abs: string): string {
  const b = base.endsWith("/") ? base : base + "/";
  if (abs === base) return ".";
  if (abs.startsWith(b)) return abs.slice(b.length);
  return abs;
}

async function writeToActiveSession(
  sessionId: string | null,
  payload: string,
  noActiveSessionMessage: string,
): Promise<void> {
  if (!sessionId) throw new Error(noActiveSessionMessage);
  await api.ptyWrite(sessionId, payload);
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
  const t = useTranslation();
  const [cache, setCache] = useState<Cache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(() =>
    getLocalBool(SHOW_HIDDEN_KEY, false),
  );
  const [respectGitignore, setRespectGitignore] = useState(() =>
    getLocalBool(RESPECT_GITIGNORE_KEY, true),
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draftRename, setDraftRename] = useState<DraftRename | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cached `$EDITOR` value from the user's shell rc. Empty string means
  // the user did not set one, in which case the open action falls back
  // to the OS default app and the menu label reflects that.
  const [shellEditor, setShellEditor] = useState<string>("");
  // Selection — Cmd-click toggle, Shift-click range. When non-empty
  // the context menu offers bulk actions across `selection`.
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // VSCode-style search panel. Toggled via Cmd+F when the Files tab is
  // active. Three composable filters: free-form query, include globs,
  // exclude globs. Case-sensitivity + regex are per-query toggles.
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [query, setQuery] = useState<string>("");
  const [useRegex, setUseRegex] = useState<boolean>(false);
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [includeGlobs, setIncludeGlobs] = useState<string>("");
  const [excludeGlobs, setExcludeGlobs] = useState<string>("");
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  // Per-path git status keyed by absolute path. Refreshed on mount + when
  // the fs watcher fires (debounced). Used to color filenames + show
  // status label + +/- line counts.
  const [gitStatus, setGitStatus] = useState<Record<string, FsGitStatusEntry>>(
    {},
  );
  // Which agent (if any) is currently running in the focused session.
  // Drives the "Attach to Conversation" context-menu entries — null
  // values mean no live process found for that agent kind.
  const [agent, setAgent] = useState<{
    claude: string | null;
    codex: string | null;
  }>({ claude: null, codex: null });
  // Tracks the focused session id so the menu can write into the right
  // PTY without re-importing the store at every click.
  const [activeSessionId, setActiveSessionIdLocal] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    api
      .fsShellEditor()
      .then((v) => {
        if (!cancelled) setShellEditor(v.trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshGitStatus = useCallback(async () => {
    try {
      const map = await api.fsGitStatus(rootPath);
      setGitStatus(map);
    } catch {
      setGitStatus({});
    }
  }, [rootPath]);

  useEffect(() => {
    void refreshGitStatus();
  }, [refreshGitStatus]);

  // Subscribe to focused-session changes via the store so the menu
  // always reflects the agent state of whichever PTY would receive the
  // attached path.
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    void import("../store").then(({ useAppStore }) => {
      if (cancelled) return;
      const sync = (sid: string | null) => {
        setActiveSessionIdLocal(sid);
        if (!sid) {
          setAgent({ claude: null, codex: null });
          return;
        }
        api
          .detectSessionAgent(sid)
          .then((res) => {
            if (!cancelled) setAgent(res);
          })
          .catch(() => {});
      };
      sync(useAppStore.getState().activeSessionId);
      unsub = useAppStore.subscribe((s) => {
        sync(s.activeSessionId);
      });
    });
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);

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
      setDraftRename(null);
      setActivePath(null);
    }
  }, [rootPath]);

  // The watcher listener needs the *current* cache to decide which
  // directories to refresh, but rebinding the listener every cache
  // write would tear down + recreate the Tauri subscription on every
  // expand. Track the latest cache in a ref so the listener stays
  // alive while still seeing fresh state inside its flush callback.
  const cacheRef = useRef(cache);
  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

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
      const current = cacheRef.current;
      for (const dir of toFetch) {
        if (current[dir] || dir === rootPath) {
          void fetchDir(dir);
        }
      }
      void refreshGitStatus();
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
  }, [rootPath, fetchDir, refreshGitStatus]);

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
      // Probe `$EDITOR` from cached shell env. Empty means the user has
      // not configured one — fall back to the OS default app for the
      // file type. Without this fallback the PTY path becomes
      // `"<path>"` after the shell expands an empty `$EDITOR`, which
      // zsh tries to execute and rejects with "permission denied".
      const editor = (await api.fsShellEditor()).trim();
      if (!editor) {
        await api.fsOpenDefault(entry.path);
        return;
      }
      const store = await import("../store");
      const sid = store.useAppStore.getState().activeSessionId;
      if (!sid) {
        await api.fsOpenDefault(entry.path);
        return;
      }
      await api.ptyWrite(sid, `$EDITOR ${shellQuote(entry.path)}\n`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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

  const dirtyAncestors = useMemo(
    () => buildDirtyAncestors(gitStatus, rootPath),
    [gitStatus, rootPath],
  );

  const queryMatcherResult = useMemo(
    () => buildQueryMatcher(query, useRegex, caseSensitive),
    [query, useRegex, caseSensitive],
  );
  const includeMatcher = useMemo(
    () => buildGlobListMatcher(includeGlobs),
    [includeGlobs],
  );
  const excludeMatcher = useMemo(
    () => buildGlobListMatcher(excludeGlobs),
    [excludeGlobs],
  );
  const invalidRegex = queryMatcherResult.invalidRegex;
  // Composite matcher: query AND include AND NOT exclude. Each layer
  // is optional — when one is null, that layer is skipped. The filter
  // is gated on `searchOpen` so closing the panel removes the visual
  // filter while preserving the last-used values for the next open.
  const matcher = useMemo<((name: string) => boolean) | null>(() => {
    if (!searchOpen) return null;
    const qm = queryMatcherResult.matcher;
    if (!qm && !includeMatcher && !excludeMatcher) return null;
    return (name) => {
      if (qm && !qm(name)) return false;
      if (includeMatcher && !includeMatcher(name)) return false;
      if (excludeMatcher && excludeMatcher(name)) return false;
      return true;
    };
  }, [searchOpen, queryMatcherResult.matcher, includeMatcher, excludeMatcher]);

  // When a filter is active, walk the loaded cache to find every
  // directory that contains at least one matching descendant. The
  // tree then hides directories whose names don't match and whose
  // (loaded) subtree contains no match. Unloaded subtrees are not
  // probed — the user has to expand to surface them.
  const matchingDirs = useMemo(() => {
    if (!matcher) return new Set<string>();
    const result = new Set<string>();
    for (const [dirPath, dirState] of Object.entries(cache)) {
      if (!dirState?.entries) continue;
      const hasMatch = dirState.entries.some(
        (e) => matcher(e.name) || (e.is_dir && result.has(e.path)),
      );
      if (!hasMatch) continue;
      let cur = dirPath;
      while (cur && cur.length >= rootPath.length) {
        result.add(cur);
        if (cur === rootPath) break;
        const idx = cur.lastIndexOf("/");
        if (idx <= 0) break;
        const next = cur.slice(0, idx);
        if (next === cur) break;
        cur = next;
      }
    }
    // Second pass to propagate ancestor flags when matches surfaced
    // out of cache iteration order.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [dirPath, dirState] of Object.entries(cache)) {
        if (!dirState?.entries) continue;
        if (result.has(dirPath)) continue;
        if (
          dirState.entries.some(
            (e) => matcher(e.name) || (e.is_dir && result.has(e.path)),
          )
        ) {
          let cur = dirPath;
          while (cur && cur.length >= rootPath.length) {
            result.add(cur);
            if (cur === rootPath) break;
            const idx = cur.lastIndexOf("/");
            if (idx <= 0) break;
            const next = cur.slice(0, idx);
            if (next === cur) break;
            cur = next;
          }
          changed = true;
        }
      }
    }
    return result;
  }, [matcher, cache, rootPath]);

  const handleEntryClick = useCallback(
    (entry: FsEntry, event: React.MouseEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const shift = event.shiftKey;
      if (meta || shift) {
        event.preventDefault();
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        return;
      }
      // Plain click: clear multi-selection and act on the entry.
      setSelection(new Set());
      if (entry.is_dir) toggleDir(entry.path);
      else setActivePath(entry.path);
    },
    [toggleDir],
  );

  const handleEntryDoubleClick = useCallback(
    async (entry: FsEntry) => {
      if (entry.is_dir) return;
      try {
        const store = await import("../store");
        store.useAppStore.getState().openViewerTab(entry.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const handleBulkTrash = useCallback(async () => {
    const paths = Array.from(selection);
    for (const p of paths) {
      try {
        await api.fsTrash(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setSelection(new Set());
    void refreshGitStatus();
  }, [selection, refreshGitStatus]);

  const handleBulkCopyPaths = useCallback(
    async (mode: "relative" | "absolute") => {
      const paths = Array.from(selection);
      const lines = paths.map((p) =>
        mode === "absolute" ? p : relativeTo(rootPath, p),
      );
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
      } catch {
        setError(fileExplorerText(t, "fileExplorer.errors.clipboardWriteFailed"));
      }
    },
    [selection, rootPath, t],
  );

  const handleBulkAttach = useCallback(async () => {
    if (!activeSessionId) {
      setError(fileExplorerText(t, "fileExplorer.errors.noActiveSession"));
      return;
    }
    const paths = Array.from(selection);
    const rels = paths.map((p) => `@${relativeTo(rootPath, p)}`).join(" ");
    try {
      await api.ptyWrite(activeSessionId, ` ${rels} `);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeSessionId, selection, rootPath, t]);

  const handleOpenFolderInNewTab = useCallback(async (folderPath: string) => {
    try {
      const store = await import("../store");
      const state = store.useAppStore.getState();
      const project = state.activeProject;
      if (!project) {
        setError(fileExplorerText(t, "fileExplorer.errors.noActiveProject"));
        return;
      }
      const name =
        folderPath.split("/").filter(Boolean).pop() ??
        fileExplorerText(t, "fileExplorer.defaults.sessionName");
      // Spawn a regular session in the current project, then queue a
      // `cd <folder>` to land inside the clicked directory once the PTY
      // is up. Mirrors how CommandRunDialog primes new sessions.
      const session = await state.createSession(name, project, false);
      if (session) {
        state.setPendingTerminalInput(
          session.id,
          `cd ${shellQuote(folderPath)}\n`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [t]);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Cmd+F toggles the VSCode-style search panel. Window-level so it
  // works even when focus is inside the tree (which doesn't bubble to
  // the container otherwise). Esc closes the panel when it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((open) => {
          const next = !open;
          if (next) {
            requestAnimationFrame(() => queryInputRef.current?.focus());
          }
          return next;
        });
        return;
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // F2 to rename the focused / single-selected entry. Scoped to the
  // FileExplorer container so it does not collide with terminal input.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      if (selection.size === 1) {
        const path = Array.from(selection)[0];
        const name = path.split("/").pop() ?? "";
        setDraftRename({ path, value: name });
        e.preventDefault();
        return;
      }
      if (activePath) {
        const name = activePath.split("/").pop() ?? "";
        setDraftRename({ path: activePath, value: name });
        e.preventDefault();
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [selection, activePath]);

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
    const rel = entry ? relativeTo(rootPath, entry.path) : "";
    const items: ContextMenuItem[] = [];

    // Bulk-action mode: ≥2 entries selected (and the right-clicked
    // entry is among them) — show actions that apply to the whole set.
    if (entry && selection.size > 1 && selection.has(entry.path)) {
      const n = selection.size;
      items.push({
        label: `${fileExplorerText(t, "fileExplorer.menu.copyRelativePaths")} (${n})`,
        icon: <Link2 size={13} />,
        onClick: () => void handleBulkCopyPaths("relative"),
      });
      items.push({
        label: `${fileExplorerText(t, "fileExplorer.menu.copyAbsolutePaths")} (${n})`,
        icon: <Copy size={13} />,
        onClick: () => void handleBulkCopyPaths("absolute"),
      });
      if (agent.claude || agent.codex) {
        items.push({ type: "separator" });
        items.push({
          label: `${fileExplorerText(t, "fileExplorer.menu.attachAllToConversation")} (${n})`,
          icon: <MessageSquarePlus size={13} />,
          onClick: () => void handleBulkAttach(),
        });
      }
      items.push({ type: "separator" });
      items.push({
        label: `${fileExplorerText(t, "fileExplorer.menu.moveToTrash")} (${n})`,
        icon: <Trash2 size={13} />,
        onClick: () => void handleBulkTrash(),
      });
      return items;
    }

    // Group 1: Open actions
    if (entry && !entry.is_dir) {
      const editorBin = shellEditor.split(/\s+/)[0];
      const openLabel = editorBin
        ? `${fileExplorerText(t, "fileExplorer.menu.openIn")} ${editorBin}`
        : fileExplorerText(t, "fileExplorer.menu.openWithDefaultProgram");
      items.push({
        label: openLabel,
        icon: <Edit3 size={13} />,
        onClick: () => void openInEditor(entry),
      });
    }
    if (entry) {
      items.push({
        label: fileExplorerText(t, "fileExplorer.menu.revealInFileManager"),
        icon: <ExternalLink size={13} />,
        onClick: () => {
          void api.fsReveal(entry.path).catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
          });
        },
      });
    }
    if (entry?.is_dir) {
      items.push({
        label: fileExplorerText(t, "fileExplorer.menu.openInNewTab"),
        icon: <TerminalSquare size={13} />,
        onClick: () => void handleOpenFolderInNewTab(entry.path),
      });
    }

    // Group 2: Agent attach (only when an agent is live)
    if (entry && (agent.claude || agent.codex)) {
      items.push({ type: "separator" });
      if (agent.claude) {
        items.push({
          label: fileExplorerText(t, "fileExplorer.menu.attachToClaude"),
          icon: <MessageSquarePlus size={13} />,
          onClick: () => {
            void writeToActiveSession(
              activeSessionId,
              ` @${rel} `,
              fileExplorerText(t, "fileExplorer.errors.noActiveSession"),
            ).catch(
              (e) => setError(e instanceof Error ? e.message : String(e)),
            );
          },
        });
      }
      if (agent.codex) {
        items.push({
          label: fileExplorerText(t, "fileExplorer.menu.attachToCodex"),
          icon: <MessageSquarePlus size={13} />,
          onClick: () => {
            void writeToActiveSession(
              activeSessionId,
              ` @${rel} `,
              fileExplorerText(t, "fileExplorer.errors.noActiveSession"),
            ).catch(
              (e) => setError(e instanceof Error ? e.message : String(e)),
            );
          },
        });
      }
    }

    // Group 3: Path copy
    if (entry) {
      items.push({ type: "separator" });
      items.push({
        label: fileExplorerText(t, "fileExplorer.menu.copyRelativePath"),
        icon: <Link2 size={13} />,
        onClick: () => {
          void navigator.clipboard.writeText(rel).catch(() => {
            setError(fileExplorerText(t, "fileExplorer.errors.clipboardWriteFailed"));
          });
        },
      });
      items.push({
        label: fileExplorerText(t, "fileExplorer.menu.copyAbsolutePath"),
        icon: <Copy size={13} />,
        onClick: () => {
          void navigator.clipboard.writeText(entry.path).catch(() => {
            setError(fileExplorerText(t, "fileExplorer.errors.clipboardWriteFailed"));
          });
        },
      });
    }

    // Group 4: Destructive
    if (entry) {
      items.push({ type: "separator" });
      items.push({
        label: fileExplorerText(t, "fileExplorer.menu.rename"),
        icon: <Pencil size={13} />,
        onClick: () => setDraftRename({ path: entry.path, value: entry.name }),
      });
      items.push({
        label: fileExplorerText(t, "fileExplorer.menu.moveToTrash"),
        icon: <Trash2 size={13} />,
        onClick: () => void handleTrash(entry),
      });
    }
    return items;
  }, [
    menu,
    rootPath,
    expanded,
    toggleDir,
    openInEditor,
    handleTrash,
    shellEditor,
    agent,
    activeSessionId,
    selection,
    handleBulkAttach,
    handleBulkCopyPaths,
    handleBulkTrash,
    handleOpenFolderInNewTab,
    t,
  ]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="flex h-full w-full flex-col outline-none"
      onContextMenu={(e) => openMenu(e, null)}
    >
      <Toolbar
        rootPath={rootPath}
        showHidden={showHidden}
        respectGitignore={respectGitignore}
        onToggleHidden={() => setShowHidden((v) => !v)}
        onToggleGitignore={() => setRespectGitignore((v) => !v)}
        searchActive={searchOpen}
        onToggleSearch={() => {
          setSearchOpen((open) => {
            const next = !open;
            if (next) {
              requestAnimationFrame(() => queryInputRef.current?.focus());
            }
            return next;
          });
        }}
      />
      {searchOpen ? (
        <SearchBar
          query={query}
          useRegex={useRegex}
          caseSensitive={caseSensitive}
          invalidRegex={invalidRegex}
          includeGlobs={includeGlobs}
          excludeGlobs={excludeGlobs}
          queryInputRef={queryInputRef}
          onQueryChange={setQuery}
          onToggleRegex={() => setUseRegex((v) => !v)}
          onToggleCaseSensitive={() => setCaseSensitive((v) => !v)}
          onIncludeChange={setIncludeGlobs}
          onExcludeChange={setExcludeGlobs}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      <div className="flex-1 overflow-auto py-1 text-[12px]">
        <div className="w-max min-w-full">
        <DirNode
          path={rootPath}
          depth={0}
          state={cache[rootPath]}
          isRoot
          expanded={expanded}
          cache={cache}
          activePath={activePath}
          draftRename={draftRename}
          gitStatus={gitStatus}
          dirtyAncestors={dirtyAncestors}
          selection={selection}
          matcher={matcher}
          matchingDirs={matchingDirs}
          onToggleDir={toggleDir}
          onOpenEntry={openInEditor}
          onEntryClick={handleEntryClick}
          onEntryDoubleClick={handleEntryDoubleClick}
          onContextMenu={openMenu}
          onCommitRename={handleRename}
          onCancelRename={() => setDraftRename(null)}
          onChangeRename={(v) =>
            setDraftRename((prev) => (prev ? { ...prev, value: v } : prev))
          }
        />
        </div>
      </div>
      {error ? (
        <div className="flex items-start gap-2 border-t border-border bg-bg-error/20 px-3 py-1.5 text-[11px] text-fg">
          <span className="flex-1 break-all">{error}</span>
          <button
            type="button"
            className="text-fg-muted hover:text-fg"
            aria-label={fileExplorerText(t, "fileExplorer.errorBanner.dismiss")}
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
  searchActive: boolean;
  onToggleHidden: () => void;
  onToggleGitignore: () => void;
  onToggleSearch: () => void;
}

function Toolbar(props: ToolbarProps) {
  const t = useTranslation();
  const rootName = props.rootPath.split("/").filter(Boolean).pop() ?? "/";
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
      <span
        className="truncate font-medium text-fg-muted"
        title={props.rootPath}
      >
        {rootName.toUpperCase()}
      </span>
      <span className="flex-1" />
      <ToolbarBtn
        label={
          props.searchActive
            ? fileExplorerText(t, "fileExplorer.toolbar.closeSearch")
            : fileExplorerText(t, "fileExplorer.toolbar.search")
        }
        active={props.searchActive}
        onClick={props.onToggleSearch}
      >
        <Search size={12} />
      </ToolbarBtn>
      <ToolbarBtn
        label={
          props.showHidden
            ? fileExplorerText(t, "fileExplorer.toolbar.hideDotfiles")
            : fileExplorerText(t, "fileExplorer.toolbar.showDotfiles")
        }
        active={props.showHidden}
        onClick={props.onToggleHidden}
      >
        {props.showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
      </ToolbarBtn>
      <ToolbarBtn
        label={
          props.respectGitignore
            ? fileExplorerText(t, "fileExplorer.toolbar.showGitignored")
            : fileExplorerText(t, "fileExplorer.toolbar.hideGitignored")
        }
        active={!props.respectGitignore}
        onClick={props.onToggleGitignore}
      >
        <Filter size={12} />
      </ToolbarBtn>
    </div>
  );
}

interface SearchBarProps {
  query: string;
  useRegex: boolean;
  caseSensitive: boolean;
  invalidRegex: boolean;
  includeGlobs: string;
  excludeGlobs: string;
  queryInputRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (v: string) => void;
  onToggleRegex: () => void;
  onToggleCaseSensitive: () => void;
  onIncludeChange: (v: string) => void;
  onExcludeChange: (v: string) => void;
  onClose: () => void;
}

function SearchBar(props: SearchBarProps) {
  const t = useTranslation();
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-2">
      <IconInput
        ref={props.queryInputRef}
        value={props.query}
        onChange={(e) => props.onQueryChange(e.target.value)}
        placeholder={
          props.useRegex
            ? fileExplorerText(t, "fileExplorer.search.regexPlaceholder")
            : fileExplorerText(t, "fileExplorer.search.searchFilesPlaceholder")
        }
        invalid={props.invalidRegex}
        leading={<Search size={12} />}
        trailing={
          <>
            <Tooltip label={fileExplorerText(t, "fileExplorer.search.matchCase")}>
              <button
                type="button"
                aria-label={fileExplorerText(t, "fileExplorer.search.matchCase")}
                onClick={props.onToggleCaseSensitive}
                className={cn(
                  "rounded p-0.5 text-[10px] font-semibold transition",
                  props.caseSensitive
                    ? "bg-fg-muted/15 text-fg"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                Aa
              </button>
            </Tooltip>
            <Tooltip
              label={fileExplorerText(
                t,
                "fileExplorer.search.useRegularExpression",
              )}
            >
              <button
                type="button"
                aria-label={fileExplorerText(
                  t,
                  "fileExplorer.search.toggleRegex",
                )}
                onClick={props.onToggleRegex}
                className={cn(
                  "rounded p-0.5 transition",
                  props.useRegex
                    ? "bg-fg-muted/15 text-fg"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                <Regex size={12} />
              </button>
            </Tooltip>
            <Tooltip label={fileExplorerText(t, "fileExplorer.search.close")}>
              <button
                type="button"
                aria-label={fileExplorerText(t, "fileExplorer.search.closeSearch")}
                onClick={props.onClose}
                className="rounded p-0.5 text-fg-muted hover:text-fg"
              >
                <X size={11} />
              </button>
            </Tooltip>
          </>
        }
      />
      <GlobInput
        label={fileExplorerText(t, "fileExplorer.search.filesToInclude")}
        placeholder={fileExplorerText(
          t,
          "fileExplorer.search.includePlaceholder",
        )}
        value={props.includeGlobs}
        onChange={props.onIncludeChange}
      />
      <GlobInput
        label={fileExplorerText(t, "fileExplorer.search.filesToExclude")}
        placeholder={fileExplorerText(
          t,
          "fileExplorer.search.excludePlaceholder",
        )}
        value={props.excludeGlobs}
        onChange={props.onExcludeChange}
      />
    </div>
  );
}

interface GlobInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}

function GlobInput({ label, placeholder, value, onChange }: GlobInputProps) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted/80">
        {label}
      </span>
      <TextInput
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
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
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
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
    </Tooltip>
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
  draftRename: DraftRename | null;
  gitStatus: Record<string, FsGitStatusEntry>;
  dirtyAncestors: Set<string>;
  selection: Set<string>;
  matcher: ((name: string) => boolean) | null;
  matchingDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenEntry: (entry: FsEntry) => void;
  onEntryClick: (entry: FsEntry, event: React.MouseEvent) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry | null) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onChangeRename: (v: string) => void;
}

function DirNode(props: DirNodeProps) {
  const t = useTranslation();
  const { state, isRoot, matcher, matchingDirs } = props;
  const rawEntries = state?.entries ?? [];
  // When a matcher is active, hide entries that fail to match. Directories
  // survive only when their own name matches or their loaded subtree
  // contains at least one matching descendant (tracked in `matchingDirs`).
  const entries = matcher
    ? rawEntries.filter((e) => {
        if (matcher(e.name)) return true;
        if (e.is_dir && matchingDirs.has(e.path)) return true;
        return false;
      })
    : rawEntries;
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
          {fileExplorerText(t, "fileExplorer.tree.empty")}
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
            isSelected={props.selection.has(entry.path)}
            gitStatus={props.gitStatus[entry.path]}
            dirtyDescendant={
              entry.is_dir && props.dirtyAncestors.has(entry.path)
            }
            onEntryClick={props.onEntryClick}
            onEntryDoubleClick={props.onEntryDoubleClick}
            onContextMenu={props.onContextMenu}
          >
            {entry.is_dir && props.expanded.has(entry.path) ? (
              <DirNode
                {...props}
                path={entry.path}
                depth={props.depth + 1}
                state={props.cache[entry.path]}
                isRoot={false}
              />
            ) : null}
          </EntryRow>
        ),
      )}
      {loading && entries.length === 0 ? (
        <div
          className="px-2 py-1 text-[11px] text-fg-muted/60"
          style={{ paddingLeft: 8 + props.depth * 12 }}
        >
          {fileExplorerText(t, "fileExplorer.tree.loading")}
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
  isSelected: boolean;
  gitStatus?: FsGitStatusEntry;
  dirtyDescendant: boolean;
  onEntryClick: (entry: FsEntry, event: React.MouseEvent) => void;
  onEntryDoubleClick: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  children?: React.ReactNode;
}

const STATUS_LABELS: Record<FsGitStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  conflicted: "C",
  clean: "",
};

function gitStatusClass(status: FsGitStatus | undefined): string {
  switch (status) {
    case "modified":
      return "text-amber-400";
    case "added":
      return "text-emerald-400";
    case "deleted":
      return "text-rose-400 line-through";
    case "renamed":
      return "text-sky-400";
    case "conflicted":
      return "text-orange-400";
    default:
      return "";
  }
}

function EntryRow({
  entry,
  depth,
  expanded,
  isActive,
  isSelected,
  gitStatus,
  dirtyDescendant,
  onEntryClick,
  onEntryDoubleClick,
  onContextMenu,
  children,
}: EntryRowProps) {
  const t = useTranslation();
  const nameClass = gitStatusClass(gitStatus?.kind);
  const statusLetter = gitStatus ? STATUS_LABELS[gitStatus.kind] : "";
  const additions = gitStatus?.additions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;
  // Folder rollup: when a directory itself has no status entry but
  // contains at least one dirty descendant, tint the name amber so the
  // user sees there's something to look at inside.
  const folderRollupClass =
    !gitStatus && dirtyDescendant ? "text-amber-400/70" : "";
  return (
    <>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          // Set both the OS-friendly text data (terminals + external
          // apps paste the quoted path) and the in-process Acorn drag
          // mirror used by Pane/TabStrip drop targets.
          if (!entry.is_dir) {
            setFileDragPayload(e, { path: entry.path });
          }
          const quoted = shellQuote(entry.path);
          try {
            e.dataTransfer.setData("text/plain", quoted);
            e.dataTransfer.setData("text/uri-list", `file://${entry.path}`);
          } catch {
            // ignore
          }
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={(e) => onEntryClick(entry, e)}
        onDoubleClick={(e) => {
          e.preventDefault();
          onEntryDoubleClick(entry);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          onContextMenu(e, entry);
        }}
        className={cn(
          "flex w-full items-center gap-1 whitespace-nowrap py-0.5 pr-2 text-left transition",
          isSelected
            ? "bg-accent/25 text-fg"
            : isActive
            ? "bg-accent/15 text-fg"
            : "text-fg hover:bg-fg-muted/10",
          entry.gitignored ? "opacity-60" : "",
        )}
        style={{ paddingLeft: 8 }}
        title={entry.path}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="relative block w-2 shrink-0 self-stretch before:absolute before:left-[4px] before:-top-[2px] before:-bottom-[2px] before:w-px before:bg-fg-muted/25"
          />
        ))}
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
        <span className={cn("whitespace-nowrap", nameClass, folderRollupClass)}>
          {entry.name}
          {entry.is_symlink ? (
            <span className="ml-1 text-fg-muted">↪</span>
          ) : null}
        </span>
        {statusLetter ? (
          <span
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1 pl-2 text-[10px] tabular-nums",
              nameClass,
            )}
          >
            {additions > 0 ? (
              <span className="text-emerald-400">+{additions}</span>
            ) : null}
            {deletions > 0 ? (
              <span className="text-rose-400">-{deletions}</span>
            ) : null}
            <span
              className="rounded bg-fg-muted/15 px-1 font-medium"
              aria-label={`${fileExplorerText(
                t,
                "fileExplorer.tree.gitStatus",
              )} ${gitStatus?.kind}`}
            >
              {statusLetter}
            </span>
          </span>
        ) : null}
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
  const t = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div
      className="flex w-full items-center gap-1 py-0.5 pr-2"
      style={{ paddingLeft: 8 }}
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          aria-hidden
          className="block w-3 shrink-0 self-stretch border-l border-fg-muted/20"
        />
      ))}
      <span className="w-3 shrink-0" />
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <input
        ref={inputRef}
        aria-label={fileExplorerText(t, "fileExplorer.tree.renameInput")}
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
