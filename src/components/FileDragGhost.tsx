import { File, Folder } from "lucide-react";
import { createPortal } from "react-dom";
import { useFileExplorerDragSession } from "../lib/fileExplorerDrag";

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() || path;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function FileDragGhost() {
  const session = useFileExplorerDragSession();
  if (!session) return null;

  const isDirectory = session.payload.entryKind === "directory";
  const Icon = isDirectory ? Folder : File;
  const width = 240;
  const height = 36;
  const left = clamp(session.pointer.x + 12, 8, window.innerWidth - width - 8);
  const top = clamp(session.pointer.y + 12, 8, window.innerHeight - height - 8);

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[9999] flex h-9 max-w-60 items-center gap-2 rounded-md border border-border bg-bg-elevated/95 px-2.5 text-xs text-fg opacity-95 shadow-2xl shadow-black/30 ring-1 ring-accent/10 backdrop-blur"
      data-file-drag-ghost
      style={{ left, top, width }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded border border-accent/35 bg-accent/15 text-accent">
        <Icon size={13} strokeWidth={2} />
      </span>
      <span className="min-w-0 truncate font-medium leading-none">
        {fileNameFromPath(session.payload.path)}
      </span>
    </div>,
    document.body,
  );
}
