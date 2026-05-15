import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type FsLineDiffEntry,
  type FsReadFileResult,
} from "../lib/api";
import { highlightCode, langFromPath } from "../lib/highlight";
import { cn } from "../lib/cn";

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

export function CodeViewer({ path, isActive }: CodeViewerProps) {
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

  if (state.loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        Loading…
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
        title="Binary file"
        body={`${state.data.size.toLocaleString()} bytes — not shown in the readonly viewer.`}
      />
    );
  }
  if (!state.data) return null;

  const sourceLines = state.data.content.split("\n");
  const lines =
    state.highlightedLines ?? sourceLines.map(() => null);
  const gutterWidth = String(sourceLines.length).length;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col bg-bg",
        isActive ? "" : "pointer-events-none opacity-50",
      )}
    >
      {state.data.truncated ? (
        <div className="shrink-0 border-b border-border bg-bg-warning/15 px-3 py-1 text-[11px] text-fg-muted">
          File truncated to 2 MB. Open externally to view the rest.
        </div>
      ) : null}
      <pre className="acorn-selectable m-0 flex-1 cursor-text overflow-auto bg-transparent font-mono text-[12px] leading-[1.5] text-fg">
        {sourceLines.map((rawText, i) => {
          const tokens = lines[i];
          const diff = diffByLine.get(i + 1);
          return (
            <div key={i} className="flex whitespace-pre">
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
                {i + 1}
              </span>
              <span
                className="grow"
                {...(tokens
                  ? { dangerouslySetInnerHTML: { __html: tokens } }
                  : { children: rawText })}
              />
            </div>
          );
        })}
      </pre>
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
