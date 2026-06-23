import { AlertTriangle } from "lucide-react";
import type { Project, Session } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { hasRecordedWorktree } from "../lib/sessionWorktree";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalHeader } from "./ui";

type RemoveProjectChoice =
  | "project_only"
  | "project_and_worktrees"
  | "cancel";
type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

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
  const t = useTranslation();
  const worktreeSessions = sessions.filter(hasRecordedWorktree);
  const worktreeCount = worktreeSessions.length;
  const linkedCount = worktreeSessions.filter((s) => !s.isolated).length;
  const primaryChoice: RemoveProjectChoice =
    worktreeCount > 0 && linkedCount === 0
      ? "project_and_worktrees"
      : "project_only";

  useDialogShortcuts(project !== null, {
    onCancel: () => onClose("cancel"),
    onConfirm: () => onClose(primaryChoice),
  });

  return (
    <Modal
      open={project !== null}
      onClose={() => onClose("cancel")}
      variant="dialog"
      size="md"
    >
      {project ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.removeProject.title")}
            icon={<AlertTriangle size={16} className="text-warning" />}
            variant="dialog"
            onClose={() => onClose("cancel")}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p>
              {dt(t, "dialogs.removeProject.confirmPrefix")}{" "}
              <span className="font-mono text-accent">{project.name}</span>?
            </p>
            <div className="space-y-1 rounded-md border border-border bg-bg-sidebar/60 p-3 text-xs">
              <p className="break-all font-mono text-fg-muted">
                {project.repo_path}
              </p>
              <p className="text-fg-muted">
                {sessions.length}{" "}
                {sessions.length === 1
                  ? dt(t, "dialogs.removeProject.sessionSingular")
                  : dt(t, "dialogs.removeProject.sessionPlural")}{" "}
                {dt(t, "dialogs.removeProject.willBeRemoved")}
                {worktreeCount > 0
                  ? ` (${worktreeCount} ${
                      worktreeCount === 1
                        ? dt(t, "dialogs.removeProject.linkedWorktreeSingular")
                        : dt(t, "dialogs.removeProject.linkedWorktreePlural")
                    })`
                  : ""}
                .
              </p>
            </div>
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <Button
              onClick={() => onClose("cancel")}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
            {worktreeCount > 0 ? (
              <Button
                onClick={() => onClose("project_only")}
                variant="neutral"
                size="md"
                surface="dialog"
              >
                {dt(t, "dialogs.removeProject.closeKeepWorktrees")}
              </Button>
            ) : null}
            <Button
              onClick={() =>
                onClose(
                  worktreeCount > 0 ? "project_and_worktrees" : "project_only",
                )
              }
              variant="dangerSoft"
              size="md"
              surface="dialog"
            >
              {worktreeCount > 0
                ? dt(t, "dialogs.removeProject.closeDeleteWorktrees")
                : dt(t, "dialogs.removeProject.closeProject")}
            </Button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
