import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useTranslation } from "../lib/useTranslation";
import { Modal, ModalHeader } from "./ui";

type RemoveChoice = "session_only" | "session_and_worktree" | "cancel";
type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface RemoveSessionDialogProps {
  session: Session | null;
  onClose: (choice: RemoveChoice) => void;
}

export function RemoveSessionDialog({ session, onClose }: RemoveSessionDialogProps) {
  const t = useTranslation();
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

  return (
    <Modal
      open={session !== null}
      onClose={() => commit("cancel")}
      variant="dialog"
      size="md"
    >
      {session ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.removeSession.title")}
            icon={<AlertTriangle size={16} className="text-warning" />}
            variant="dialog"
            onClose={() => commit("cancel")}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p>
              {dt(t, "dialogs.removeSession.confirmPrefix")}{" "}
              <span className="font-mono text-accent">{session.name}</span>?
            </p>
            {isolated ? (
              <div className="space-y-2 rounded-md border border-border bg-bg-sidebar/60 p-3">
                <p className="text-xs text-fg-muted">
                  {dt(t, "dialogs.removeSession.isolatedWorktree")}
                </p>
                <p className="break-all font-mono text-xs text-fg">
                  {session.worktree_path}
                </p>
                <p className="text-xs text-fg-muted">
                  {dt(t, "dialogs.removeSession.deleteWorktreeQuestion")}
                </p>
              </div>
            ) : (
              <p className="text-xs text-fg-muted">
                {dt(t, "dialogs.removeSession.filesIn")}{" "}
                {session.worktree_path}{" "}
                {dt(t, "dialogs.removeSession.willNotBeTouched")}
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
                {dt(t, "dialogs.removeSession.dontAskAgain")}
              </label>
            ) : null}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={() => commit("cancel")}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
            >
              {dt(t, "dialogs.common.cancel")}
            </button>
            {isolated ? (
              <>
                <button
                  type="button"
                  onClick={() => commit("session_only")}
                  className="rounded-md px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
                >
                  {dt(t, "dialogs.removeSession.keepWorktree")}
                </button>
                <button
                  type="button"
                  onClick={() => commit("session_and_worktree")}
                  className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25"
                >
                  {dt(t, "dialogs.removeSession.deleteWorktree")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => commit("session_only")}
                className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25"
              >
                {dt(t, "dialogs.removeSession.remove")}
              </button>
            )}
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
