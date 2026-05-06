import { ChevronRight, Maximize2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { countStats, parseDiff, type ParsedLine } from "../lib/diff";
import type { DiffPayload } from "../lib/types";

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
            <button
              type="button"
              onClick={onExpand}
              className="rounded p-1 transition hover:bg-bg-elevated hover:text-fg"
              title="Open full diff"
              aria-label="Open full diff"
            >
              <Maximize2 size={12} />
            </button>
          ) : null}
        </span>
      </div>
      {payload.files.map((file, idx) => {
        const path = file.new_path ?? file.old_path ?? "(unknown)";
        const lines = parseDiff(file.patch);
        const stats = countStats(lines);
        const isCollapsed = collapsed.has(idx);
        return (
          <div
            key={`${path}-${idx}`}
            className="overflow-hidden rounded-md border border-border bg-bg"
          >
            <button
              type="button"
              onClick={() => toggle(idx)}
              className="flex w-full items-center justify-between gap-2 border-b border-border bg-bg-elevated px-2 py-1 text-left font-mono text-xs transition hover:bg-bg-elevated/80"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <ChevronRight
                  size={12}
                  className={cn(
                    "shrink-0 text-fg-muted transition-transform",
                    !isCollapsed && "rotate-90",
                  )}
                />
                <span className="truncate text-fg">{path}</span>
              </span>
              <span className="flex shrink-0 gap-2">
                <span className="text-[oklch(72%_0.16_145)]">+{stats.add}</span>
                <span className="text-[oklch(62%_0.22_25)]">-{stats.del}</span>
              </span>
            </button>
            {!isCollapsed ? (
              <div className="acorn-selectable max-h-80 overflow-auto font-mono text-[11px] leading-5 select-text">
                {lines.map((line, i) => (
                  <DiffLine key={i} line={line} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function DiffLine({ line }: { line: ParsedLine }) {
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
      ? "bg-[oklch(35%_0.10_145_/_0.25)] text-[oklch(86%_0.14_145)]"
      : line.kind === "del"
        ? "bg-[oklch(35%_0.16_25_/_0.22)] text-[oklch(82%_0.16_25)]"
        : "text-fg-muted";
  const marker =
    line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <div className={`flex gap-2 px-2 py-0 ${cls}`}>
      <span className="select-none w-3 shrink-0 text-center opacity-70">
        {marker}
      </span>
      <span className="whitespace-pre">{line.text || " "}</span>
    </div>
  );
}

