import { AlertTriangle } from "lucide-react";
import type { Project, Session } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Modal, ModalHeader } from "./ui";

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
  const isolatedCount = sessions.filter((s) => s.isolated).length;
  const primaryChoice: RemoveProjectChoice =
    isolatedCount > 0 ? "project_and_worktrees" : "project_only";

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
                {isolatedCount > 0
                  ? ` (${isolatedCount} ${
                      isolatedCount === 1
                        ? dt(t, "dialogs.removeProject.isolatedWorktreeSingular")
                        : dt(t, "dialogs.removeProject.isolatedWorktreePlural")
                    })`
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
              {dt(t, "dialogs.common.cancel")}
            </button>
            {isolatedCount > 0 ? (
              <button
                type="button"
                onClick={() => onClose("project_only")}
                className="rounded-md px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              >
                {dt(t, "dialogs.removeProject.closeKeepWorktrees")}
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
              {isolatedCount > 0
                ? dt(t, "dialogs.removeProject.closeDeleteWorktrees")
                : dt(t, "dialogs.removeProject.closeProject")}
            </button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
