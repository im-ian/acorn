import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { hasRecordedWorktree } from "../lib/sessionWorktree";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader } from "./ui";

type RemoveChoice = "session_only" | "session_and_worktree" | "cancel";
type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface RemoveSessionDialogProps {
  session: Session | null;
  canDeleteWorktree?: boolean;
  ownedSessionCount?: number;
  onClose: (choice: RemoveChoice) => void;
}

export function RemoveSessionDialog({
  session,
  canDeleteWorktree = true,
  ownedSessionCount = 0,
  onClose,
}: RemoveSessionDialogProps) {
  const t = useTranslation();
  const isolated = session?.isolated ?? false;
  const recordedWorktree = session ? hasRecordedWorktree(session) : false;
  const showWorktreeDeleteChoice = recordedWorktree && canDeleteWorktree;
  const showIsolatedCleanupSetting = isolated && canDeleteWorktree;
  const confirmDeleteIsolatedWorktrees = useSettings(
    (s) => s.settings.sessions.confirmDeleteIsolatedWorktrees,
  );
  const patchSessions = useSettings((s) => s.patchSessions);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [
    autoDeleteIsolatedWorktreesNextTime,
    setAutoDeleteIsolatedWorktreesNextTime,
  ] = useState(false);

  // Reset checkboxes each time dialog opens for a new session.
  useEffect(() => {
    if (!session) return;
    setDontAskAgain(false);
    setAutoDeleteIsolatedWorktreesNextTime(
      !confirmDeleteIsolatedWorktrees,
    );
  }, [confirmDeleteIsolatedWorktrees, session?.id]);

  // Keep Enter conservative for non-isolated linked worktrees, which may be
  // user-managed outside Acorn even though the session path is a real worktree.
  const primaryChoice: RemoveChoice = isolated && canDeleteWorktree
    ? "session_and_worktree"
    : "session_only";

  function commit(choice: RemoveChoice) {
    if (choice !== "cancel") {
      if (dontAskAgain && !recordedWorktree) {
        patchSessions({ confirmRemove: false });
      }
      if (
        showIsolatedCleanupSetting &&
        autoDeleteIsolatedWorktreesNextTime !==
          !confirmDeleteIsolatedWorktrees
      ) {
        patchSessions({
          confirmDeleteIsolatedWorktrees:
            !autoDeleteIsolatedWorktreesNextTime,
        });
      }
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
            subtitle={session.name}
            icon={<AlertTriangle size={16} className="text-warning" />}
            variant="dialog"
            onClose={() => commit("cancel")}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p>
              {dt(t, "dialogs.removeSession.confirmPrefix")}{" "}
              <span className="font-mono text-accent">{session.name}</span>?
            </p>
            {ownedSessionCount > 0 ? (
              <p className="text-xs text-warning">
                {dt(t, "dialogs.removeSession.ownedSessionsWillBeRemovedPrefix")}{" "}
                <span className="font-mono">{ownedSessionCount}</span>{" "}
                {dt(t, "dialogs.removeSession.ownedSessionsWillBeRemovedSuffix")}
              </p>
            ) : null}
            {recordedWorktree ? (
              <div className="space-y-2 rounded-md border border-border bg-bg-sidebar/60 p-3">
                <p className="text-xs text-fg-muted">
                  {isolated
                    ? dt(t, "dialogs.removeSession.isolatedWorktree")
                    : dt(t, "dialogs.removeSession.linkedWorktree")}
                </p>
                <p className="break-all font-mono text-xs text-fg">
                  {session.worktree_path}
                </p>
                <p className="text-xs text-fg-muted">
                  {canDeleteWorktree
                    ? dt(t, "dialogs.removeSession.deleteWorktreeQuestion")
                    : dt(t, "dialogs.removeSession.keepSharedWorktree")}
                </p>
              </div>
            ) : (
              <p className="text-xs text-fg-muted">
                {dt(t, "dialogs.removeSession.filesIn")}{" "}
                {session.worktree_path}{" "}
                {dt(t, "dialogs.removeSession.willNotBeTouched")}
              </p>
            )}
            {showIsolatedCleanupSetting ? (
              <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={autoDeleteIsolatedWorktreesNextTime}
                  onChange={(e) =>
                    setAutoDeleteIsolatedWorktreesNextTime(e.target.checked)
                  }
                  className="acorn-check"
                />
                {dt(
                  t,
                  "dialogs.removeSession.autoDeleteIsolatedWorktreesNextTime",
                )}
              </label>
            ) : !recordedWorktree ? (
              <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={dontAskAgain}
                  onChange={(e) => setDontAskAgain(e.target.checked)}
                  className="acorn-check"
                />
                {dt(t, "dialogs.removeSession.dontAskAgain")}
              </label>
            ) : null}
          </div>
          <ModalFooter variant="sidebar">
            <Button
              onClick={() => commit("cancel")}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
            {showWorktreeDeleteChoice ? (
              <>
                <Button
                  onClick={() => commit("session_only")}
                  variant="neutral"
                  size="md"
                  surface="dialog"
                >
                  {dt(t, "dialogs.removeSession.keepWorktree")}
                </Button>
                <Button
                  onClick={() => commit("session_and_worktree")}
                  variant="dangerSoft"
                  size="md"
                  surface="dialog"
                >
                  {dt(t, "dialogs.removeSession.deleteWorktree")}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => commit("session_only")}
                variant="dangerSoft"
                size="md"
                surface="dialog"
              >
                {dt(t, "dialogs.removeSession.remove")}
              </Button>
            )}
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
