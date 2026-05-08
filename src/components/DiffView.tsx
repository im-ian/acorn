import { ChevronRight, Maximize2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { countStats, parseDiff, type ParsedLine } from "../lib/diff";
import { highlightDiff, langFromPath } from "../lib/highlight";
import type { DiffFile, DiffPayload } from "../lib/types";
import { Tooltip } from "./Tooltip";

interface DiffViewProps {
  payload: DiffPayload;
  onExpand?: () => void;
}

export function DiffView({ payload, onExpand }: DiffViewProps) {
  const collapseByDefault = payload.files.length > 1;
  const [collapsed, setCollapsed] = useState<Set<number>>(
    () => new Set(collapseByDefault ? payload.files.map((_, i) => i) : []),
  );

  useEffect(() => {
    setCollapsed(
      new Set(payload.files.length > 1 ? payload.files.map((_, i) => i) : []),
    );
  }, [payload]);

  if (payload.files.length === 0) {
    return (
      <div className="p-3 text-xs text-fg-muted">No changes in this diff.</div>
    );
  }

  function toggle(idx: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function expandAll() {
    setCollapsed(new Set());
  }

  function collapseAll() {
    setCollapsed(new Set(payload.files.map((_, i) => i)));
  }

  const allCollapsed = collapsed.size === payload.files.length;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>
          {payload.files.length} file{payload.files.length === 1 ? "" : "s"}{" "}
          changed
        </span>
        <span className="flex items-center gap-1">
          {payload.files.length > 1 ? (
            <button
              type="button"
              onClick={allCollapsed ? expandAll : collapseAll}
              className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition hover:bg-bg-elevated hover:text-fg"
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          ) : null}
          {onExpand ? (
            <Tooltip label="Open full diff" side="bottom">
              <button
                type="button"
                onClick={onExpand}
                className="rounded p-1 transition hover:bg-bg-elevated hover:text-fg"
                aria-label="Open full diff"
              >
                <Maximize2 size={12} />
              </button>
            </Tooltip>
          ) : null}
        </span>
      </div>
      {payload.files.map((file, idx) => (
        <DiffFileAccordion
          key={`${file.new_path ?? file.old_path ?? "unknown"}-${idx}`}
          file={file}
          collapsed={collapsed.has(idx)}
          onToggle={() => toggle(idx)}
        />
      ))}
    </div>
  );
}

interface DiffFileAccordionProps {
  file: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
}

function DiffFileAccordion({ file, collapsed, onToggle }: DiffFileAccordionProps) {
  const path = file.new_path ?? file.old_path ?? "(unknown)";
  const lines = useMemo(() => parseDiff(file.patch), [file.patch]);
  const stats = useMemo(() => countStats(lines), [lines]);
  const highlighted = useHighlightedDiff(lines, path);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-bg">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 border-b border-border bg-bg-elevated px-2 py-1 text-left font-mono text-xs transition hover:bg-bg-elevated/80"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight
            size={12}
            className={cn(
              "shrink-0 text-fg-muted transition-transform",
              !collapsed && "rotate-90",
            )}
          />
          <span className="truncate text-fg">{path}</span>
          {file.is_image ? (
            <span className="shrink-0 rounded bg-bg-elevated/80 px-1 text-[10px] uppercase tracking-wide text-fg-muted">
              image
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 gap-2">
          {file.is_image ? null : (
            <>
              <span className="text-[oklch(72%_0.16_145)]">+{stats.add}</span>
              <span className="text-[oklch(62%_0.22_25)]">-{stats.del}</span>
            </>
          )}
        </span>
      </button>
      {!collapsed ? (
        file.is_image ? (
          <ImageDiff file={file} />
        ) : (
          <div className="acorn-selectable max-h-80 overflow-auto font-mono text-[11px] leading-5 select-text">
            {lines.map((line, i) => (
              <DiffLine key={i} line={line} html={highlighted[i] ?? null} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function ImageDiff({ file }: { file: DiffFile }) {
  const hasOld = !!file.old_image;
  const hasNew = !!file.new_image;
  if (!hasOld && !hasNew) {
    return (
      <div className="p-3 text-xs text-fg-muted">
        Binary image change (no preview available)
      </div>
    );
  }
  if (!hasOld) {
    return (
      <div className="p-3">
        <ImagePane label="Added" src={file.new_image ?? null} accent="add" />
      </div>
    );
  }
  if (!hasNew) {
    return (
      <div className="p-3">
        <ImagePane label="Deleted" src={file.old_image ?? null} accent="del" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      <ImagePane label="Before" src={file.old_image ?? null} accent="del" />
      <ImagePane label="After" src={file.new_image ?? null} accent="add" />
    </div>
  );
}

function ImagePane({
  label,
  src,
  accent,
}: {
  label: string;
  src: string | null;
  accent: "add" | "del";
}) {
  const ringCls =
    accent === "add"
      ? "ring-1 ring-[oklch(35%_0.10_145_/_0.6)]"
      : "ring-1 ring-[oklch(35%_0.16_25_/_0.6)]";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      <div
        className={cn(
          "flex min-h-24 items-center justify-center overflow-hidden rounded bg-bg-elevated/40",
          ringCls,
        )}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            className="max-h-80 w-full object-contain"
          />
        ) : (
          <span className="p-3 text-[11px] text-fg-muted">(none)</span>
        )}
      </div>
    </div>
  );
}

/**
 * Hook: asynchronously syntax-highlight a parsed diff. Returns one HTML string
 * per line (or null for unsupported lines / not-yet-loaded). Falls back to
 * plain text rendering when null.
 */
export function useHighlightedDiff(
  lines: ParsedLine[],
  path: string | null,
): (string | null)[] {
  const [html, setHtml] = useState<(string | null)[]>(() =>
    new Array(lines.length).fill(null),
  );

  useEffect(() => {
    const lang = langFromPath(path);
    if (!lang) {
      setHtml(new Array(lines.length).fill(null));
      return;
    }
    let cancelled = false;
    setHtml(new Array(lines.length).fill(null));
    highlightDiff(lines, lang)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch((err) => {
        console.warn("[DiffView] highlight failed", err);
        if (!cancelled) setHtml(new Array(lines.length).fill(null));
      });
    return () => {
      cancelled = true;
    };
  }, [lines, path]);

  return html;
}

export function DiffLine({
  line,
  html,
}: {
  line: ParsedLine;
  html?: string | null;
}) {
  if (line.kind === "hunk") {
    return (
      <div className="bg-[oklch(28%_0.04_250)] px-3 py-0.5 text-[oklch(70%_0.05_250)]">
        {line.text}
      </div>
    );
  }
  if (line.kind === "meta") {
    return (
      <div className="bg-bg-elevated/40 px-3 py-0.5 text-fg-muted">
        {line.text}
      </div>
    );
  }
  const cls =
    line.kind === "add"
      ? "bg-[oklch(35%_0.10_145_/_0.25)]"
      : line.kind === "del"
        ? "bg-[oklch(35%_0.16_25_/_0.22)]"
        : "";
  const fallbackText =
    line.kind === "add"
      ? "text-[oklch(86%_0.14_145)]"
      : line.kind === "del"
        ? "text-[oklch(82%_0.16_25)]"
        : "text-fg-muted";
  const marker =
    line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <div className={`flex gap-2 px-2 py-0 ${cls}`}>
      <span className="select-none w-3 shrink-0 text-center opacity-70">
        {marker}
      </span>
      {html ? (
        <span
          className="whitespace-pre"
          dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }}
        />
      ) : (
        <span className={`whitespace-pre ${fallbackText}`}>
          {line.text || " "}
        </span>
      )}
    </div>
  );
}
