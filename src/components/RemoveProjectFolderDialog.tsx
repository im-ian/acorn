import { AlertTriangle } from "lucide-react";
import type { ProjectFolder } from "../lib/projectFolders";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import type { Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Modal, ModalHeader } from "./ui";

type RemoveProjectFolderChoice =
  | "folder_only"
  | "folder_and_sessions"
  | "cancel";
type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface RemoveProjectFolderDialogProps {
  folder: ProjectFolder | null;
  sessions: readonly Session[];
  onClose: (choice: RemoveProjectFolderChoice) => void;
}

export function RemoveProjectFolderDialog({
  folder,
  sessions,
  onClose,
}: RemoveProjectFolderDialogProps) {
  const t = useTranslation();
  const sessionCount = sessions.length;

  useDialogShortcuts(folder !== null, {
    onCancel: () => onClose("cancel"),
    onConfirm: () =>
      onClose(sessionCount > 0 ? "folder_only" : "folder_and_sessions"),
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
                    {dt(t, "dialogs.removeProjectFolder.canBeMovedOut")}.
                  </p>
                  <p className="text-fg-muted">
                    {dt(t, "dialogs.removeProjectFolder.removeSessionsHint")}
                  </p>
                </>
              ) : (
                <p className="text-fg-muted">
                  {dt(t, "dialogs.removeProjectFolder.emptyFolder")}
                </p>
              )}
              <p className="text-fg-muted">
                {dt(t, "dialogs.removeProjectFolder.filesWillNotBeTouched")}
              </p>
            </div>
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={() => onClose("cancel")}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
            >
              {dt(t, "dialogs.common.cancel")}
            </button>
            {sessionCount > 0 ? (
              <button
                type="button"
                onClick={() => onClose("folder_only")}
                className="rounded-md px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              >
                {dt(t, "dialogs.removeProjectFolder.moveSessionsOut")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                onClose(
                  sessionCount > 0 ? "folder_and_sessions" : "folder_only",
                )
              }
              className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25"
            >
              {sessionCount > 0
                ? dt(t, "dialogs.removeProjectFolder.removeWithSessions")
                : dt(t, "dialogs.removeProjectFolder.removeFolder")}
            </button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
