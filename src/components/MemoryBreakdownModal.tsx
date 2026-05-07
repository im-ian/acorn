import { useMemo } from "react";
import type { MemoryProcess } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import { Modal, ModalHeader } from "./ui";

interface MemoryBreakdownModalProps {
  open: boolean;
  totalBytes: number;
  processes: MemoryProcess[];
  onClose: () => void;
}

interface TreeRow {
  process: MemoryProcess;
  /** Total RSS of this node + all descendants (used for sort + display). */
  subtreeBytes: number;
  /** Pre-rendered tree connector prefix, e.g. "│  ├─ ". */
  prefix: string;
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  const fixed = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[i]}`;
}

function buildTree(processes: MemoryProcess[]): TreeRow[] {
  if (processes.length === 0) return [];

  const byPid = new Map<number, MemoryProcess>();
  const childrenOf = new Map<number, MemoryProcess[]>();
  for (const p of processes) {
    byPid.set(p.pid, p);
  }
  // Roots = depth 0 (server walks from acorn self_pid). Anything else groups by parent.
  const roots: MemoryProcess[] = [];
  for (const p of processes) {
    if (p.depth === 0 || p.parent_pid === null || !byPid.has(p.parent_pid)) {
      if (p.depth === 0) roots.push(p);
      continue;
    }
    const list = childrenOf.get(p.parent_pid) ?? [];
    list.push(p);
    childrenOf.set(p.parent_pid, list);
  }

  // Sum subtree bytes (post-order).
  const subtreeBytes = new Map<number, number>();
  function sumSubtree(pid: number): number {
    const cached = subtreeBytes.get(pid);
    if (cached !== undefined) return cached;
    const self = byPid.get(pid)?.bytes ?? 0;
    const children = childrenOf.get(pid) ?? [];
    let total = self;
    for (const c of children) total += sumSubtree(c.pid);
    subtreeBytes.set(pid, total);
    return total;
  }
  for (const r of roots) sumSubtree(r.pid);

  // DFS, children sorted by subtree bytes desc, with tree connectors.
  const rows: TreeRow[] = [];
  function walk(p: MemoryProcess, ancestorsLast: boolean[], isLast: boolean) {
    let prefix = "";
    for (const last of ancestorsLast) {
      prefix += last ? "    " : "│   ";
    }
    if (ancestorsLast.length > 0) {
      prefix += isLast ? "└─ " : "├─ ";
    }

    rows.push({
      process: p,
      subtreeBytes: subtreeBytes.get(p.pid) ?? p.bytes,
      prefix,
    });

    const children = (childrenOf.get(p.pid) ?? [])
      .slice()
      .sort(
        (a, b) =>
          (subtreeBytes.get(b.pid) ?? 0) - (subtreeBytes.get(a.pid) ?? 0),
      );

    children.forEach((child, idx) => {
      walk(child, [...ancestorsLast, isLast], idx === children.length - 1);
    });
  }

  roots
    .slice()
    .sort(
      (a, b) =>
        (subtreeBytes.get(b.pid) ?? 0) - (subtreeBytes.get(a.pid) ?? 0),
    )
    .forEach((root, idx, arr) => walk(root, [], idx === arr.length - 1));

  return rows;
}

export function MemoryBreakdownModal({
  open,
  totalBytes,
  processes,
  onClose,
}: MemoryBreakdownModalProps) {
  useDialogShortcuts(open, {
    onCancel: onClose,
    onConfirm: onClose,
  });

  const rows = useMemo(() => buildTree(processes), [processes]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="panel"
      size="3xl"
      ariaLabelledBy="memory-breakdown-title"
    >
      <ModalHeader
        title="Memory breakdown"
        titleId="memory-breakdown-title"
        subtitle={`total (RSS, sum): ${formatBytes(totalBytes)} · ${processes.length} processes`}
        onClose={onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full font-mono text-xs">
          <thead className="sticky top-0 bg-bg-sidebar text-fg-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left font-medium">PID</th>
              <th className="px-4 py-2 text-left font-medium">Process tree</th>
              <th className="px-4 py-2 text-right font-medium">RSS</th>
              <th
                className="px-4 py-2 text-right font-medium"
                title="Sum of this process and all descendants"
              >
                Subtree
              </th>
              <th className="px-4 py-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ process, subtreeBytes, prefix }) => {
              const share =
                totalBytes > 0 ? (process.bytes / totalBytes) * 100 : 0;
              return (
                <tr
                  key={process.pid}
                  className="border-b border-border/50 hover:bg-bg-elevated"
                >
                  <td className="px-4 py-1.5 text-fg-muted">{process.pid}</td>
                  <td className="px-4 py-1.5 text-fg">
                    <span className="whitespace-pre text-fg-muted/60">
                      {prefix}
                    </span>
                    <span title={process.command_line || undefined}>
                      {process.name}
                    </span>
                    {process.command_line ? (
                      <span
                        className="ml-2 truncate text-fg-muted/60"
                        title={process.command_line}
                      >
                        {truncateMiddle(process.command_line, 80)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg">
                    {formatBytes(process.bytes)}
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg-muted">
                    {process.depth === 0 || subtreeBytes !== process.bytes
                      ? formatBytes(subtreeBytes)
                      : ""}
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg-muted">
                    {share.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="shrink-0 border-t border-border px-4 py-2 font-mono text-[11px] text-fg-muted">
        Tree ordered by parent→child (DFS). Siblings sorted by subtree RSS desc.
        Sum-of-RSS overcounts shared memory; WebView helpers and PTY children
        (claude, node) included.
      </footer>
    </Modal>
  );
}
