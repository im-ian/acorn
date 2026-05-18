import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type FsLineDiffEntry,
  type FsReadFileResult,
} from "../lib/api";
import { highlightCode, langFromPath } from "../lib/highlight";
import { cn } from "../lib/cn";
import { useTranslation } from "../lib/useTranslation";
import {
  estimateMaxLineWidthCh,
  lineIndexProps,
  lineTextContentProps,
  VirtualizedLineList,
} from "./VirtualizedLines";

interface CodeViewerProps {
  path: string;
  isActive: boolean;
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

export function CodeViewer({ path, isActive }: CodeViewerProps) {
  const t = useTranslation();
  const [state, setState] = useState<ViewerState>(EMPTY_STATE);
  const [diffLines, setDiffLines] = useState<FsLineDiffEntry[]>([]);

  const refreshDiff = useCallback(async () => {
    try {
      const lines = await api.fsGitDiffLines(path);
      setDiffLines(lines);
    } catch {
      setDiffLines([]);
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY_STATE);
    api
      .fsReadFile(path)
      .then(async (data) => {
        if (cancelled) return;
        if (data.binary) {
          setState({
            data,
            highlightedLines: null,
            error: null,
            loading: false,
          });
          return;
        }
        const lang = langFromPath(path);
        const lines = await highlightCode(data.content, lang);
        if (cancelled) return;
        setState({
          data,
          highlightedLines: lines,
          error: null,
          loading: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          highlightedLines: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      });
    void refreshDiff();
    return () => {
      cancelled = true;
    };
  }, [path, refreshDiff]);

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
        "flex h-full w-full flex-col bg-bg",
        isActive ? "" : "pointer-events-none opacity-50",
      )}
    >
      {state.data.truncated ? (
        <div className="shrink-0 border-b border-border bg-bg-warning/15 px-3 py-1 text-[11px] text-fg-muted">
          {t("codeViewer.truncated")}
        </div>
      ) : null}
      <VirtualizedLineList
        as="pre"
        count={sourceLines.length}
        className="acorn-selectable m-0 flex-1 cursor-text overflow-auto bg-transparent font-mono text-[12px] leading-[1.5] text-fg"
        estimateSize={() => CODE_LINE_HEIGHT}
        getLineText={(index) => sourceLines[index] ?? ""}
        minWidthCh={minWidthCh}
        renderLine={(index) => (
          <CodeLine
            key={index}
            index={index}
            rawText={sourceLines[index] ?? ""}
            tokens={lines[index] ?? null}
            diff={diffByLine.get(index + 1)}
            gutterWidth={gutterWidth}
          />
        )}
      />
    </div>
  );
}

function CodeLine({
  index,
  rawText,
  tokens,
  diff,
  gutterWidth,
}: {
  index: number;
  rawText: string;
  tokens: string | null;
  diff?: FsLineDiffEntry["kind"];
  gutterWidth: number;
}) {
  return (
    <div className="flex whitespace-pre" {...lineIndexProps(index)}>
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
        {...(tokens
          ? { dangerouslySetInnerHTML: { __html: tokens } }
          : { children: rawText })}
      />
    </div>
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
