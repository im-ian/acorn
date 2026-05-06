import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import { useSettings } from "../lib/settings";

type RemoveChoice = "session_only" | "session_and_worktree" | "cancel";

interface RemoveSessionDialogProps {
  session: Session | null;
  onClose: (choice: RemoveChoice) => void;
}

export function RemoveSessionDialog({ session, onClose }: RemoveSessionDialogProps) {
  const isolated = session?.isolated ?? false;
  const patchSessions = useSettings((s) => s.patchSessions);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Reset checkbox each time dialog opens for a new session.
  useEffect(() => {
    if (session) setDontAskAgain(false);
  }, [session?.id]);

  // Enter triggers the same primary action as the rightmost destructive button:
  // for isolated worktrees that means "Delete worktree", otherwise "Remove".
  const primaryChoice: RemoveChoice = isolated
    ? "session_and_worktree"
    : "session_only";

  function commit(choice: RemoveChoice) {
    if (choice !== "cancel" && dontAskAgain && !isolated) {
      patchSessions({ confirmRemove: false });
    }
    onClose(choice);
  }

  useDialogShortcuts(session !== null, {
    onCancel: () => commit("cancel"),
    onConfirm: () => commit(primaryChoice),
  });

  if (!session) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-32"
      onClick={(e) => {
        if (e.target === e.currentTarget) commit("cancel");
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-warning" />
            <h3 className="text-sm font-semibold tracking-tight text-fg">
              Remove session
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => commit("cancel")}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>
        <div className="space-y-3 px-4 py-3 text-sm text-fg">
          <p>
            Remove session{" "}
            <span className="font-mono text-accent">{session.name}</span>?
          </p>
          {isolated ? (
            <div className="space-y-2 rounded-md border border-border bg-bg-sidebar/60 p-3">
              <p className="text-xs text-fg-muted">
                This is an isolated worktree:
              </p>
              <p className="break-all font-mono text-xs text-fg">
                {session.worktree_path}
              </p>
              <p className="text-xs text-fg-muted">
                Also delete the worktree from disk?
              </p>
            </div>
          ) : (
            <p className="text-xs text-fg-muted">
              Files in {session.worktree_path} will not be touched.
            </p>
          )}
          {!isolated ? (
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              Don't ask again (toggle in Settings → Sessions)
            </label>
          ) : null}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
          <button
            type="button"
            onClick={() => commit("cancel")}
            className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
          >
            Cancel
          </button>
          {isolated ? (
            <>
              <button
                type="button"
                onClick={() => commit("session_only")}
                className="rounded-md px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              >
                Keep worktree
              </button>
              <button
                type="button"
                onClick={() => commit("session_and_worktree")}
                className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25"
              >
                Delete worktree
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => commit("session_only")}
              className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25"
            >
              Remove
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
