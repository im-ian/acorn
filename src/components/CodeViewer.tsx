import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Code2, Eye, Search, X } from "lucide-react";
import {
  api,
  FS_CHANGED_EVENT,
  type FsChangePayload,
  type FsLineDiffEntry,
  type FsReadFileResult,
} from "../lib/api";
import { highlightCode, langFromPath } from "../lib/highlight";
import { cn } from "../lib/cn";
import { useSettings } from "../lib/settings";
import { resolveThemeMode, useThemes } from "../lib/themes";
import { useTranslation } from "../lib/useTranslation";
import type { ScrollPosition } from "../lib/scrollPosition";
import {
  estimateMaxLineWidthCh,
  lineIndexProps,
  lineTextContentProps,
  VirtualizedLineList,
  type VirtualizedLineListHandle,
} from "./VirtualizedLines";
import { Tooltip } from "./Tooltip";
import { Button, FloatingToolbar, IconButton, Markdown } from "./ui";
import type {
  CodeWorkspaceTabTarget,
  CodeWorkspaceTabViewState,
} from "../lib/workspaceTabs";
import {
  scrollPositionFromEventTarget,
  useDeferredScrollReporter,
  useRestoredScrollRef,
} from "./useScrollViewState";

interface CodeViewerProps {
  path: string;
  isActive: boolean;
  target?: CodeWorkspaceTabTarget;
  viewState?: CodeWorkspaceTabViewState;
  onViewStateChange?: (patch: CodeWorkspaceTabViewState) => void;
}

interface ViewerState {
  data: FsReadFileResult | null;
  highlightedLines: (string | null)[] | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_STATE: ViewerState = {
  data: null,
  highlightedLines: null,
  error: null,
  loading: true,
};

const DIFF_KIND_CLASS: Record<FsLineDiffEntry["kind"], string> = {
  added: "bg-emerald-400",
  modified: "bg-amber-400",
  deleted: "bg-rose-400",
};

const CODE_LINE_HEIGHT = 18;
// Stable reference so VirtualizedLineList's size memos don't recompute on
// every CodeViewer render.
const estimateCodeLineHeight = () => CODE_LINE_HEIGHT;
const MARKDOWN_EXT_RE = /\.(md|mdown|markdown|mdx)$/i;
const SEARCH_MARK_CLASS = "rounded-[2px] px-0.5 text-fg";
const SEARCH_MARK_ACTIVE_CLASS = `${SEARCH_MARK_CLASS} bg-accent/75`;
const SEARCH_MARK_INACTIVE_CLASS = `${SEARCH_MARK_CLASS} bg-warning/60`;
const PREVIEW_SEARCH_MARK_SELECTOR = "mark[data-acorn-preview-search]";
const SHOW_TEXT_NODE = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

interface SearchMatch {
  line: number;
  start: number;
  end: number;
  index: number;
}

interface LineSearchMatch {
  start: number;
  end: number;
  active: boolean;
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT_RE.test(path);
}

function classifyCodeViewerFsChange(
  filePath: string,
  payload: FsChangePayload,
): { content: boolean; diff: boolean } {
  const sameRoot =
    !payload.root ||
    isSameOrInside(payload.root, filePath) ||
    isSameOrInside(filePath, payload.root);
  if (!sameRoot) return { content: false, diff: false };

  const content =
    payload.paths.some((changedPath) => pathsOverlap(changedPath, filePath)) ||
    (payload.overflow
      ? payload.refresh
        ? isSameOrInside(payload.refresh.path, filePath)
        : true
      : false);

  return {
    content,
    diff: content || payload.dotgit_changed,
  };
}

function normalizeFsPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function isSameOrInside(parent: string, child: string): boolean {
  const normalizedParent = normalizeFsPath(parent);
  const normalizedChild = normalizeFsPath(child);
  if (normalizedParent === "/") return normalizedChild.startsWith("/");
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
}

function pathsOverlap(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

export function CodeViewer({
  path,
  isActive,
  target,
  viewState,
  onViewStateChange,
}: CodeViewerProps) {
  const t = useTranslation();
  const themeId = useSettings((s) => s.settings.appearance.themeId);
  const themes = useThemes((s) => s.themes);
  const [state, setState] = useState<ViewerState>(EMPTY_STATE);
  const [diffLines, setDiffLines] = useState<FsLineDiffEntry[]>([]);
  const [previewMarkdown, setPreviewMarkdown] = useState(
    () => viewState?.code?.previewMarkdown ?? false,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [previewMatchCount, setPreviewMatchCount] = useState(0);
  const lineListRef = useRef<VirtualizedLineListHandle | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const loadSeqRef = useRef(0);
  const themeMode = useMemo(
    () => resolveThemeMode(themeId, themes),
    [themeId, themes],
  );
  const reportCodeScrollPosition = useDeferredScrollReporter(
    useCallback(
      (position: ScrollPosition) => onViewStateChange?.({ code: position }),
      [onViewStateChange],
    ),
  );
  const restorePreviewScrollRef = useRestoredScrollRef<HTMLDivElement>(
    viewState?.code,
  );
  const setPreviewRef = useCallback(
    (node: HTMLDivElement | null) => {
      previewRef.current = node;
      restorePreviewScrollRef(node);
    },
    [restorePreviewScrollRef],
  );

  const refreshFile = useCallback(
    async ({ reset = false }: { reset?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      if (reset) setState(EMPTY_STATE);
      try {
        const data = await api.fsReadFile(path);
        if (seq !== loadSeqRef.current) return;
        setState({
          data,
          highlightedLines: null,
          error: null,
          loading: false,
        });
      } catch (err: unknown) {
        if (seq !== loadSeqRef.current) return;
        setState({
          data: null,
          highlightedLines: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      }
    },
    [path],
  );

  const refreshDiff = useCallback(async () => {
    try {
      const lines = await api.fsGitDiffLines(path);
      setDiffLines(lines);
    } catch {
      setDiffLines([]);
    }
  }, [path]);

  useEffect(() => {
    setPreviewMarkdown(viewState?.code?.previewMarkdown ?? false);
    setSearchOpen(false);
    setSearchQuery("");
    setActiveMatchIndex(0);
    setPreviewMatchCount(0);
    void refreshFile({ reset: true });
    return () => {
      loadSeqRef.current += 1;
    };
  }, [path, refreshFile]);

  const togglePreviewMarkdown = useCallback(() => {
    const next = !previewMarkdown;
    setPreviewMarkdown(next);
    onViewStateChange?.({ code: { previewMarkdown: next } });
  }, [onViewStateChange, previewMarkdown]);

  useEffect(() => {
    const data = state.data;
    if (!data || data.binary) return;
    let cancelled = false;
    setState((current) =>
      current.data === data ? { ...current, highlightedLines: null } : current,
    );
    const lang = langFromPath(path);
    highlightCode(data.content, lang, themeMode)
      .then((lines) => {
        if (cancelled) return;
        setState((current) =>
          current.data === data
            ? { ...current, highlightedLines: lines }
            : current,
        );
      })
      .catch((err) => {
        console.warn("[CodeViewer] highlight failed", err);
        if (cancelled) return;
        setState((current) =>
          current.data === data
            ? { ...current, highlightedLines: null }
            : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [path, state.data, themeMode]);

  useEffect(() => {
    void refreshDiff();
  }, [refreshDiff]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listen<FsChangePayload>(FS_CHANGED_EVENT, (event) => {
      if (cancelled) return;
      const change = classifyCodeViewerFsChange(path, event.payload);
      if (change.content) {
        void refreshFile();
      }
      if (change.content || change.diff) {
        void refreshDiff();
      }
    }).then((cancel) => {
      if (cancelled) {
        cancel();
        return;
      }
      unlisten = cancel;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [path, refreshDiff, refreshFile]);

  const diffByLine = useMemo(() => {
    const map = new Map<number, FsLineDiffEntry["kind"]>();
    for (const d of diffLines) map.set(d.line, d.kind);
    return map;
  }, [diffLines]);
  const sourceLines = useMemo(
    () =>
      state.data && !state.data.binary ? state.data.content.split("\n") : [],
    [state.data],
  );
  const plainHighlightedLines = useMemo(
    () => sourceLines.map(() => null),
    [sourceLines],
  );
  const gutterWidth = String(Math.max(1, sourceLines.length)).length;
  const minWidthCh = useMemo(
    () => estimateMaxLineWidthCh(sourceLines, gutterWidth + 7),
    [gutterWidth, sourceLines],
  );
  const canPreviewMarkdown = isMarkdownPath(path);
  const previewMode = previewMarkdown && canPreviewMarkdown;
  const effectiveSearchQuery = searchOpen ? searchQuery : "";
  const searchMatches = useMemo(
    () => findLineMatches(sourceLines, effectiveSearchQuery),
    [effectiveSearchQuery, sourceLines],
  );
  const searchMatchesByLine = useMemo(() => {
    const map = new Map<number, LineSearchMatch[]>();
    for (const match of searchMatches) {
      const lineMatches = map.get(match.line) ?? [];
      lineMatches.push({
        start: match.start,
        end: match.end,
        active: match.index === activeMatchIndex,
      });
      map.set(match.line, lineMatches);
    }
    return map;
  }, [activeMatchIndex, searchMatches]);
  const currentMatchCount = previewMode
    ? previewMatchCount
    : searchMatches.length;
  const targetLineIndex =
    target &&
    target.line >= 1 &&
    target.line <= sourceLines.length &&
    !previewMode
      ? target.line - 1
      : null;

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const stepMatch = useCallback(
    (direction: 1 | -1) => {
      if (currentMatchCount === 0) return;
      setActiveMatchIndex(
        (current) =>
          (current + direction + currentMatchCount) % currentMatchCount,
      );
    },
    [currentMatchCount],
  );

  useEffect(() => {
    if (previewMode) return;
    if (!searchOpen || searchQuery === "") return;
    if (searchMatches.length === 0) {
      setActiveMatchIndex(0);
      return;
    }
    if (activeMatchIndex >= searchMatches.length) {
      setActiveMatchIndex(searchMatches.length - 1);
      return;
    }
    lineListRef.current?.scrollToIndex(searchMatches[activeMatchIndex].line);
  }, [activeMatchIndex, previewMode, searchMatches, searchOpen, searchQuery]);

  useEffect(() => {
    if (!previewMode) {
      setPreviewMatchCount(0);
      return;
    }
    const root = previewRef.current;
    if (!root) return;
    const { count, activeElement } = highlightPreviewMatches(
      root,
      effectiveSearchQuery,
      activeMatchIndex,
    );
    setPreviewMatchCount(count);
    if (count === 0) {
      setActiveMatchIndex(0);
    } else if (activeMatchIndex >= count) {
      setActiveMatchIndex(count - 1);
    } else {
      activeElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
    return () => {
      removePreviewSearchMarks(root);
    };
  }, [activeMatchIndex, effectiveSearchQuery, previewMode]);

  useEffect(() => {
    if (targetLineIndex === null) return;
    lineListRef.current?.scrollToIndex(targetLineIndex, "center");
  }, [target?.token, targetLineIndex]);

  useEffect(() => {
    if (!isActive) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      openSearch();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, openSearch]);

  if (state.loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        {t("codeViewer.loading")}
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-muted">
        {state.error}
      </div>
    );
  }
  if (state.data?.binary) {
    return (
      <Notice
        title={t("codeViewer.binaryFile")}
        body={t("codeViewer.binaryFileBody").replace(
          "{bytes}",
          state.data.size.toLocaleString(),
        )}
      />
    );
  }
  if (!state.data) return null;

  const lines = state.highlightedLines ?? plainHighlightedLines;
  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col bg-bg",
        isActive ? "" : "pointer-events-none",
      )}
    >
      {state.data.truncated ? (
        <div className="shrink-0 border-b border-border bg-bg-warning/15 px-3 py-1 text-[11px] text-fg-muted">
          {t("codeViewer.truncated")}
        </div>
      ) : null}
      {previewMarkdown && canPreviewMarkdown ? (
        <div
          ref={setPreviewRef}
          onScroll={(event) =>
            reportCodeScrollPosition(
              scrollPositionFromEventTarget(event.currentTarget),
            )
          }
          className="acorn-selectable min-h-0 flex-1 overflow-auto px-8 py-6 pb-16"
        >
          <Markdown
            content={state.data.content}
            className="mx-auto max-w-3xl text-[13px] leading-6"
          />
        </div>
      ) : (
        <VirtualizedLineList
          ref={lineListRef}
          as="pre"
          count={sourceLines.length}
          className="acorn-selectable m-0 flex-1 cursor-text overflow-auto bg-transparent pb-12 font-mono text-[12px] leading-[1.5] text-fg"
          estimateSize={estimateCodeLineHeight}
          getLineText={(index) => sourceLines[index] ?? ""}
          minWidthCh={minWidthCh}
          restoreScrollPosition={viewState?.code}
          onScrollPositionChange={reportCodeScrollPosition}
          renderLine={(index) => (
            <CodeLine
              key={index}
              index={index}
              rawText={sourceLines[index] ?? ""}
              tokens={lines[index] ?? null}
              diff={diffByLine.get(index + 1)}
              gutterWidth={gutterWidth}
              searchMatches={searchMatchesByLine.get(index) ?? []}
              focused={targetLineIndex === index}
            />
          )}
        />
      )}
      {searchOpen ? (
        <FloatingToolbar aria-label={t("codeViewer.findControls")} zIndex={30}>
          <Search size={13} className="ml-1 text-fg-muted" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setActiveMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
            aria-label={t("codeViewer.findInFile")}
            placeholder={t("codeViewer.findInFile")}
            className="h-7 w-52 min-w-0 bg-transparent px-1 text-xs text-fg outline-none placeholder:text-fg-muted"
          />
          <span className="min-w-[4.5rem] text-center text-[11px] tabular-nums text-fg-muted">
            {searchQuery === ""
              ? t("codeViewer.findPrompt")
              : currentMatchCount === 0
                ? t("codeViewer.noMatches")
                : t("codeViewer.matchCount")
                    .replace("{current}", String(activeMatchIndex + 1))
                    .replace("{total}", String(currentMatchCount))}
          </span>
          <Tooltip label={t("codeViewer.previousMatch")} side="bottom">
            <IconButton
              onClick={() => stepMatch(-1)}
              disabled={currentMatchCount === 0}
              aria-label={t("codeViewer.previousMatch")}
              size="md"
              surface="dialog"
              className="disabled:cursor-default disabled:opacity-40"
            >
              <ChevronUp size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t("codeViewer.nextMatch")} side="bottom">
            <IconButton
              onClick={() => stepMatch(1)}
              disabled={currentMatchCount === 0}
              aria-label={t("codeViewer.nextMatch")}
              size="md"
              surface="dialog"
              className="disabled:cursor-default disabled:opacity-40"
            >
              <ChevronDown size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t("codeViewer.closeFind")} side="bottom">
            <IconButton
              onClick={closeSearch}
              aria-label={t("codeViewer.closeFind")}
              size="md"
              surface="dialog"
            >
              <X size={14} />
            </IconButton>
          </Tooltip>
        </FloatingToolbar>
      ) : null}
      {canPreviewMarkdown ? (
        <Button
          aria-pressed={previewMarkdown}
          onClick={togglePreviewMarkdown}
          variant="outline"
          size="xs"
          surface="dialog"
          className="absolute bottom-3 right-3 z-20 bg-bg-elevated/95 px-2.5 py-1.5 text-[11px] text-fg-muted shadow-lg backdrop-blur focus:outline-none focus:ring-2 focus:ring-accent/60"
        >
          {previewMarkdown ? <Code2 size={13} /> : <Eye size={13} />}
          {previewMarkdown
            ? t("codeViewer.showSource")
            : t("codeViewer.showPreview")}
        </Button>
      ) : null}
    </div>
  );
}

function CodeLine({
  index,
  rawText,
  tokens,
  diff,
  gutterWidth,
  searchMatches,
  focused,
}: {
  index: number;
  rawText: string;
  tokens: string | null;
  diff?: FsLineDiffEntry["kind"];
  gutterWidth: number;
  searchMatches: LineSearchMatch[];
  focused: boolean;
}) {
  return (
    <div
      className={cn("flex whitespace-pre", focused ? "bg-accent/10" : "")}
      data-acorn-target-line={focused ? "true" : undefined}
      {...lineIndexProps(index)}
    >
      <span
        aria-hidden
        className={cn(
          "shrink-0 self-stretch",
          diff ? DIFF_KIND_CLASS[diff] : "bg-transparent",
        )}
        style={{ width: 3 }}
      />
      <span
        aria-hidden
        className="select-none shrink-0 pl-2 pr-3 text-right text-fg-muted/60 tabular-nums"
        style={{ minWidth: `${gutterWidth + 3}ch` }}
      >
        {index + 1}
      </span>
      <span
        {...lineTextContentProps()}
        className="grow"
        {...(searchMatches.length > 0
          ? { children: renderSearchLine(rawText, searchMatches) }
          : tokens
            ? { dangerouslySetInnerHTML: { __html: tokens } }
            : { children: rawText })}
      />
    </div>
  );
}

function findLineMatches(
  lines: readonly string[],
  query: string,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  lines.forEach((line, lineIndex) => {
    for (const range of findTextRanges(line, query)) {
      matches.push({
        line: lineIndex,
        start: range.start,
        end: range.end,
        index: matches.length,
      });
    }
  });
  return matches;
}

function renderSearchLine(rawText: string, matches: readonly LineSearchMatch[]) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) {
      nodes.push(rawText.slice(cursor, match.start));
    }
    nodes.push(
      <mark
        key={`${match.start}-${index}`}
        className={
          match.active ? SEARCH_MARK_ACTIVE_CLASS : SEARCH_MARK_INACTIVE_CLASS
        }
      >
        {rawText.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  });
  if (cursor < rawText.length) {
    nodes.push(rawText.slice(cursor));
  }
  return nodes;
}

function highlightPreviewMatches(
  root: HTMLElement,
  query: string,
  activeMatchIndex: number,
): { count: number; activeElement: HTMLElement | null } {
  removePreviewSearchMarks(root);
  if (query === "") return { count: 0, activeElement: null };

  const doc = root.ownerDocument;
  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT_NODE, {
    acceptNode(node) {
      const text = node.nodeValue ?? "";
      const parent = node.parentElement;
      if (!parent || text === "") return FILTER_REJECT;
      if (parent.closest(PREVIEW_SEARCH_MARK_SELECTOR)) {
        return FILTER_REJECT;
      }
      if (parent.closest("script,style")) return FILTER_REJECT;
      return findTextRanges(text, query).length > 0
        ? FILTER_ACCEPT
        : FILTER_REJECT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  let count = 0;
  let activeElement: HTMLElement | null = null;
  for (const node of textNodes) {
    const text = node.data;
    const ranges = findTextRanges(text, query);
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        fragment.append(text.slice(cursor, range.start));
      }
      const mark = doc.createElement("mark");
      mark.dataset.acornPreviewSearch = "true";
      mark.className =
        count === activeMatchIndex
          ? SEARCH_MARK_ACTIVE_CLASS
          : SEARCH_MARK_INACTIVE_CLASS;
      mark.textContent = text.slice(range.start, range.end);
      if (count === activeMatchIndex) activeElement = mark;
      fragment.append(mark);
      count += 1;
      cursor = range.end;
    }
    if (cursor < text.length) {
      fragment.append(text.slice(cursor));
    }
    node.replaceWith(fragment);
  }

  return { count, activeElement };
}

function removePreviewSearchMarks(root: HTMLElement) {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>(PREVIEW_SEARCH_MARK_SELECTOR),
  );
  for (const mark of marks) {
    const parent = mark.parentNode;
    mark.replaceWith(root.ownerDocument.createTextNode(mark.textContent ?? ""));
    parent?.normalize();
  }
}

function findTextRanges(text: string, query: string): { start: number; end: number }[] {
  if (query === "") return [];
  const re = new RegExp(escapeRegExp(query), "giu");
  const ranges: { start: number; end: number }[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index;
    const value = match[0];
    if (start === undefined || value === "") continue;
    ranges.push({ start, end: start + value.length });
  }
  return ranges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFindShortcut(event: KeyboardEvent): boolean {
  const primary = event.metaKey || event.ctrlKey;
  return (
    primary &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLocaleLowerCase() === "f"
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="text-xs text-fg-muted">{body}</p>
    </div>
  );
}
