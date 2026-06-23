import { AlertTriangle } from "lucide-react";
import type { ProjectFolder } from "../lib/projectFolders";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import type { Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Button, CodeValue, Modal, ModalFooter, ModalHeader } from "./ui";

type RemoveProjectFolderChoice =
  | "folder_only"
  | "folder_and_sessions"
  | "folder_and_worktree"
  | "cancel";
type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface RemoveProjectFolderDialogProps {
  folder: ProjectFolder | null;
  sessions: readonly Session[];
  deleteWorktrees?: boolean;
  worktreeWorkspace?: boolean;
  onClose: (choice: RemoveProjectFolderChoice) => void;
}

export function RemoveProjectFolderDialog({
  folder,
  sessions,
  deleteWorktrees = false,
  worktreeWorkspace = false,
  onClose,
}: RemoveProjectFolderDialogProps) {
  const t = useTranslation();
  const confirmDeleteEmptyWorktreeWorkspaces = useSettings(
    (s) => s.settings.sessions.confirmDeleteEmptyWorktreeWorkspaces,
  );
  const patchSessions = useSettings((s) => s.patchSessions);
  const sessionCount = sessions.length;
  const canChooseWorktreeRemoval = worktreeWorkspace && sessionCount === 0;

  useDialogShortcuts(folder !== null, {
    onCancel: () => onClose("cancel"),
    onConfirm: () =>
      onClose(sessionCount > 0 ? "folder_and_sessions" : "folder_only"),
  });

  return (
    <Modal
      open={folder !== null}
      onClose={() => onClose("cancel")}
      variant="dialog"
      size="md"
      ariaLabelledBy="acorn-remove-project-folder-title"
    >
      {folder ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.removeProjectFolder.title")}
            subtitle={folder.name}
            titleId="acorn-remove-project-folder-title"
            icon={<AlertTriangle size={16} className="text-warning" />}
            variant="dialog"
            onClose={() => onClose("cancel")}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p>
              {dt(t, "dialogs.removeProjectFolder.confirmPrefix")}{" "}
              <span className="font-mono text-accent">{folder.name}</span>?
            </p>
            <div className="space-y-1 rounded-md border border-border bg-bg-sidebar/60 p-3 text-xs">
              {sessionCount > 0 ? (
                <>
                  <p className="text-fg-muted">
                    {sessionCount}{" "}
                    {sessionCount === 1
                      ? dt(t, "dialogs.removeProjectFolder.sessionSingular")
                      : dt(t, "dialogs.removeProjectFolder.sessionPlural")}{" "}
                    {dt(t, "dialogs.removeProjectFolder.sessionsWillBeRemoved")}
                  </p>
                  {worktreeWorkspace ? (
                    <p className="text-fg-muted">
                      {dt(
                        t,
                        "dialogs.removeProjectFolder.worktreeSessionsWillBeRemovedOnly",
                      )}
                    </p>
                  ) : null}
                </>
              ) : worktreeWorkspace ? (
                <>
                  <p className="text-fg-muted">
                    {dt(t, "dialogs.removeProjectFolder.emptyFolder")}
                  </p>
                  <p className="text-fg-muted">
                    {dt(t, "dialogs.removeProjectFolder.worktreeWorkspacePath")}
                  </p>
                  <CodeValue overflow="breakAll">
                    {folder.cwdPath}
                  </CodeValue>
                  <p className="text-fg-muted">
                    {deleteWorktrees
                      ? dt(
                          t,
                          "dialogs.removeProjectFolder.worktreesWillBeDeleted",
                        )
                      : dt(
                          t,
                          "dialogs.removeProjectFolder.deleteWorkspaceWorktreeQuestion",
                        )}
                  </p>
                </>
              ) : (
                <p className="text-fg-muted">
                  {dt(t, "dialogs.removeProjectFolder.emptyFolder")}
                </p>
              )}
              {!canChooseWorktreeRemoval ? (
                <p className="text-fg-muted">
                  {deleteWorktrees
                    ? dt(
                        t,
                        "dialogs.removeProjectFolder.worktreesWillBeDeleted",
                      )
                    : worktreeWorkspace
                      ? dt(
                          t,
                          "dialogs.removeProjectFolder.sharedWorktreeWillBeKept",
                        )
                      : dt(
                          t,
                          "dialogs.removeProjectFolder.filesWillNotBeTouched",
                        )}
                </p>
              ) : null}
            </div>
            {canChooseWorktreeRemoval ? (
              <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={confirmDeleteEmptyWorktreeWorkspaces}
                  onChange={(e) =>
                    patchSessions({
                      confirmDeleteEmptyWorktreeWorkspaces: e.target.checked,
                    })
                  }
                  className="acorn-check"
                />
                {dt(
                  t,
                  "dialogs.removeProjectFolder.rememberDeleteWorktree",
                )}
              </label>
            ) : null}
          </div>
          <ModalFooter variant="sidebar">
            <Button
              onClick={() => onClose("cancel")}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
            {canChooseWorktreeRemoval ? (
              <>
                <Button
                  onClick={() => onClose("folder_only")}
                  variant="neutral"
                  size="md"
                  surface="dialog"
                >
                  {dt(t, "dialogs.removeProjectFolder.keepWorktree")}
                </Button>
                <Button
                  onClick={() => onClose("folder_and_worktree")}
                  variant="dangerSoft"
                  size="md"
                  surface="dialog"
                >
                  {dt(t, "dialogs.removeProjectFolder.deleteWorktree")}
                </Button>
              </>
            ) : (
              <Button
                onClick={() =>
                  onClose(
                    sessionCount > 0 ? "folder_and_sessions" : "folder_only",
                  )
                }
                variant="dangerSoft"
                size="md"
                surface="dialog"
              >
                {sessionCount > 0
                  ? dt(t, "dialogs.removeProjectFolder.removeWithSessions")
                  : dt(t, "dialogs.removeProjectFolder.removeFolder")}
              </Button>
            )}
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
