import { X } from "lucide-react";
import { DiffSplitView } from "./DiffSplitView";
import type { DiffPayload } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";

interface DiffViewerModalProps {
  payload: DiffPayload | null;
  title: string;
  subtitle?: string;
  /**
   * Working directory for resolving repo-relative diff paths to absolute paths
   * (used by the file context menu's "Open in editor" action). Typically the
   * active session's `worktree_path`. When omitted, the action is hidden.
   */
  cwd?: string;
  onClose: () => void;
}

export function DiffViewerModal({
  payload,
  title,
  subtitle,
  cwd,
  onClose,
}: DiffViewerModalProps) {
  // Read-only viewer: Enter dismisses just like Esc since there is no other
  // primary action.
  useDialogShortcuts(payload !== null, {
    onCancel: onClose,
    onConfirm: onClose,
  });

  if (!payload) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-black/60 px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight text-fg">
              {title}
            </h3>
            {subtitle ? (
              <p className="truncate font-mono text-xs text-fg-muted">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffSplitView payload={payload} cwd={cwd} />
        </div>
      </div>
    </div>
  );
}
