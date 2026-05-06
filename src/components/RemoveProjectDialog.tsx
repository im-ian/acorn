import { AlertTriangle, X } from "lucide-react";
import type { Project, Session } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";

type RemoveProjectChoice =
  | "project_only"
  | "project_and_worktrees"
  | "cancel";

interface RemoveProjectDialogProps {
  project: Project | null;
  sessions: Session[];
  onClose: (choice: RemoveProjectChoice) => void;
}

export function RemoveProjectDialog({
  project,
  sessions,
  onClose,
}: RemoveProjectDialogProps) {
  const isolatedCount = sessions.filter((s) => s.isolated).length;
  const primaryChoice: RemoveProjectChoice =
    isolatedCount > 0 ? "project_and_worktrees" : "project_only";

  useDialogShortcuts(project !== null, {
    onCancel: () => onClose("cancel"),
    onConfirm: () => onClose(primaryChoice),
  });

  if (!project) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-32"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose("cancel");
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-warning" />
            <h3 className="text-sm font-semibold tracking-tight text-fg">
              Close project
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onClose("cancel")}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>
        <div className="space-y-3 px-4 py-3 text-sm text-fg">
          <p>
            Close project{" "}
            <span className="font-mono text-accent">{project.name}</span>?
          </p>
          <div className="space-y-1 rounded-md border border-border bg-bg-sidebar/60 p-3 text-xs">
            <p className="break-all font-mono text-fg-muted">
              {project.repo_path}
            </p>
            <p className="text-fg-muted">
              {sessions.length} session{sessions.length === 1 ? "" : "s"} will
              be removed
              {isolatedCount > 0
                ? ` (${isolatedCount} isolated worktree${isolatedCount === 1 ? "" : "s"})`
                : ""}
              .
            </p>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
          <button
            type="button"
            onClick={() => onClose("cancel")}
            className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
          >
            Cancel
          </button>
          {isolatedCount > 0 ? (
            <button
              type="button"
              onClick={() => onClose("project_only")}
              className="rounded-md px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
            >
              Close · keep worktrees
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              onClose(
                isolatedCount > 0 ? "project_and_worktrees" : "project_only",
              )
            }
            className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25"
          >
            {isolatedCount > 0 ? "Close · delete worktrees" : "Close project"}
          </button>
        </footer>
      </div>
    </div>
  );
}
