import { useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { ExternalLink } from "lucide-react";
import { cn } from "../lib/cn";
import { countStats, parseDiff } from "../lib/diff";
import { openFileInEditor } from "../lib/editor";
import type { DiffFile, DiffPayload } from "../lib/types";
import { Tooltip } from "./Tooltip";
import { joinPath } from "../lib/paths";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffLine, useHighlightedDiff } from "./DiffView";
import { ResizeHandle } from "./ResizeHandle";

interface DiffSplitViewProps {
  payload: DiffPayload;
  /**
   * Working directory for resolving repo-relative diff paths. When provided,
   * a context-menu "Open in editor" action becomes available on each file.
   */
  cwd?: string;
}

interface MenuState {
  x: number;
  y: number;
  entry: FileEntry;
}

interface FileEntry {
  index: number;
  path: string;
  file: DiffFile;
  lines: ReturnType<typeof parseDiff>;
  add: number;
  del: number;
}

/**
 * GitHub-style diff layout: file list on the left, full diff for the
 * currently-selected file on the right. Used inside `DiffViewerModal`.
 *
 * Renamed files show `old → new`. The file list stays alphabetised by display
 * path so navigation is stable across diff payloads.
 */
export function DiffSplitView({ payload, cwd }: DiffSplitViewProps) {
  const entries = useMemo<FileEntry[]>(() => {
    return payload.files
      .map((file, index) => {
        const newPath = file.new_path;
        const oldPath = file.old_path;
        const path =
          newPath && oldPath && newPath !== oldPath
            ? `${oldPath} → ${newPath}`
            : (newPath ?? oldPath ?? "(unknown)");
        const lines = parseDiff(file.patch);
        const stats = countStats(lines);
        return { index, path, file, lines, add: stats.add, del: stats.del };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [payload]);

  const [selectedIndex, setSelectedIndex] = useState<number>(() =>
    entries[0]?.index ?? 0,
  );
  const [menu, setMenu] = useState<MenuState | null>(null);

  // If the payload changes (e.g. a different commit selected) reset selection
  // to the first file so we don't keep pointing at a stale index.
  useEffect(() => {
    setSelectedIndex(entries[0]?.index ?? 0);
    setMenu(null);
  }, [payload]);

  if (entries.length === 0) {
    return (
      <div className="p-3 text-xs text-fg-muted">No changes in this diff.</div>
    );
  }

  const selected =
    entries.find((e) => e.index === selectedIndex) ?? entries[0];
  const totals = entries.reduce(
    (acc, e) => {
      acc.add += e.add;
      acc.del += e.del;
      return acc;
    },
    { add: 0, del: 0 },
  );

  async function openInEditor(entry: FileEntry) {
    const rel = entry.file.new_path ?? entry.file.old_path;
    if (!rel || !cwd) return;
    try {
      await openFileInEditor(joinPath(cwd, rel));
    } catch (err) {
      console.error("[DiffSplitView] open in editor failed", err);
    }
  }

  return (
    <>
    <PanelGroup
      direction="horizontal"
      autoSaveId="acorn:diff-split"
      className="h-full"
    >
      <Panel id="files" order={1} defaultSize={28} minSize={18} maxSize={50}>
        <aside className="flex h-full flex-col bg-bg-sidebar">
          <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-fg-muted">
            <span>
              {entries.length} file{entries.length === 1 ? "" : "s"}
            </span>
            <span className="flex gap-2 normal-case">
              <span className="text-[oklch(72%_0.16_145)]">+{totals.add}</span>
              <span className="text-[oklch(62%_0.22_25)]">-{totals.del}</span>
            </span>
          </header>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {entries.map((entry) => {
              const active = entry.index === selected.index;
              const dir = dirnameOf(entry.path);
              return (
                <li key={entry.index}>
                  <Tooltip
                    label={entry.path}
                    side="right"
                    multiline
                    className="w-full"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedIndex(entry.index)}
                      onContextMenu={(e) => {
                        if (!cwd) return;
                        e.preventDefault();
                        setSelectedIndex(entry.index);
                        setMenu({ x: e.clientX, y: e.clientY, entry });
                      }}
                      className={cn(
                        "flex w-full flex-col items-stretch gap-0.5 px-3 py-1.5 text-left font-mono text-xs transition",
                        active
                          ? "bg-bg-elevated text-fg"
                          : "text-fg-muted hover:bg-bg-elevated/60 hover:text-fg",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">
                          {basenameOf(entry.path)}
                        </span>
                        <span className="flex shrink-0 gap-1.5 text-[10px]">
                          <span className="text-[oklch(72%_0.16_145)]">
                            +{entry.add}
                          </span>
                          <span className="text-[oklch(62%_0.22_25)]">
                            -{entry.del}
                          </span>
                        </span>
                      </span>
                      {dir ? (
                        <span className="block truncate text-[10px] text-fg-muted/70">
                          {dir}
                        </span>
                      ) : null}
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </aside>
      </Panel>
      <ResizeHandle />
      <Panel id="content" order={2} defaultSize={72} minSize={40}>
        <section className="flex h-full flex-col bg-bg">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-elevated px-3 py-2 font-mono text-xs">
            <Tooltip label={selected.path} side="bottom" multiline>
              <span className="min-w-0 truncate text-fg">{selected.path}</span>
            </Tooltip>
            <span className="flex shrink-0 gap-2">
              <span className="text-[oklch(72%_0.16_145)]">
                +{selected.add}
              </span>
              <span className="text-[oklch(62%_0.22_25)]">
                -{selected.del}
              </span>
            </span>
          </header>
          <DiffSplitContent entry={selected} />
        </section>
      </Panel>
    </PanelGroup>
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
                disabled: menu.entry.file.new_path === null,
                onClick: () => {
                  void openInEditor(menu.entry);
                },
              },
            ] satisfies ContextMenuItem[])
          : []
      }
      onClose={() => setMenu(null)}
    />
    </>
  );
}


function DiffSplitContent({ entry }: { entry: FileEntry }) {
  const path = entry.file.new_path ?? entry.file.old_path ?? entry.path;
  const highlighted = useHighlightedDiff(entry.lines, path);
  if (entry.file.is_image) {
    return <ImageDiffPane file={entry.file} />;
  }
  return (
    <div className="acorn-selectable min-h-0 flex-1 select-text overflow-auto font-mono text-[11px] leading-5">
      {entry.lines.map((line, i) => (
        <DiffLine key={i} line={line} html={highlighted[i] ?? null} />
      ))}
    </div>
  );
}

function ImageDiffPane({ file }: { file: DiffFile }) {
  const hasOld = !!file.old_image;
  const hasNew = !!file.new_image;
  if (!hasOld && !hasNew) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-fg-muted">
        Binary image change (no preview available)
      </div>
    );
  }
  if (!hasOld) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ImagePreview label="Added" src={file.new_image!} accent="add" />
      </div>
    );
  }
  if (!hasNew) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ImagePreview label="Deleted" src={file.old_image!} accent="del" />
      </div>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-4">
      <ImagePreview label="Before" src={file.old_image!} accent="del" />
      <ImagePreview label="After" src={file.new_image!} accent="add" />
    </div>
  );
}

function ImagePreview({
  label,
  src,
  accent,
}: {
  label: string;
  src: string;
  accent: "add" | "del";
}) {
  const ringCls =
    accent === "add"
      ? "ring-1 ring-[oklch(35%_0.10_145_/_0.6)]"
      : "ring-1 ring-[oklch(35%_0.16_25_/_0.6)]";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      <div
        className={cn(
          "flex max-h-[60vh] items-center justify-center overflow-hidden rounded bg-bg-elevated/40 p-2",
          ringCls,
        )}
      >
        <img
          src={src}
          alt={label}
          loading="lazy"
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </div>
  );
}

function basenameOf(path: string): string {
  // For renames the path contains " → " — show the new (right) part's base.
  const display = path.includes(" → ") ? path.split(" → ").pop() ?? path : path;
  const segs = display.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? display;
}

function dirnameOf(path: string): string {
  const display = path.includes(" → ") ? path.split(" → ").pop() ?? path : path;
  const segs = display.split("/").filter(Boolean);
  if (segs.length <= 1) return "";
  return segs.slice(0, -1).join("/");
}
