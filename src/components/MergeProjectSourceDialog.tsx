import { FolderInput } from "lucide-react";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { basenamePath } from "../lib/projectFolders";
import type { ProjectSourceMerge } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

const TITLE_ID = "merge-project-source-title";

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface MergeProjectSourceDialogProps {
  merge: ProjectSourceMerge | null;
  /** Name of the project that would gain the folder. */
  targetName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A folder can belong to exactly one project, so adopting one another project
 * already owns moves it — and, when it is that project's primary root, absorbs
 * the whole project. Both outcomes are surprising enough to confirm first.
 */
export function MergeProjectSourceDialog({
  merge,
  targetName,
  onCancel,
  onConfirm,
}: MergeProjectSourceDialogProps) {
  const t = useTranslation();

  useDialogShortcuts(merge !== null, { onCancel, onConfirm });

  return (
    <Modal
      open={merge !== null}
      onClose={onCancel}
      variant="dialog"
      size="md"
      ariaLabelledBy={TITLE_ID}
    >
      {merge ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.mergeProjectSource.title")}
            titleId={TITLE_ID}
            icon={<FolderInput size={16} className="text-accent" />}
            variant="dialog"
            onClose={onCancel}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p>
              {dt(
                t,
                merge.wholeProject
                  ? "dialogs.mergeProjectSource.messageProject"
                  : "dialogs.mergeProjectSource.messageFolder",
              )
                .replace("{source}", merge.ownerName)
                .replace("{target}", targetName)}
            </p>
            <Notice tone="info">
              <div className="text-[11px] uppercase tracking-wide text-fg-muted">
                {dt(t, "dialogs.mergeProjectSource.folderLabel")}
              </div>
              <div className="mt-1 truncate font-mono text-xs text-accent">
                {basenamePath(merge.sourcePath)}
              </div>
              <div className="truncate font-mono text-[11px] text-fg-muted">
                {merge.sourcePath}
              </div>
            </Notice>
            <p className="text-xs text-fg-muted">
              {dt(t, "dialogs.mergeProjectSource.sessionsKept")}
            </p>
          </div>
          <ModalFooter variant="sidebar">
            <Button onClick={onCancel} size="md" surface="dialog">
              {dt(t, "dialogs.common.cancel")}
            </Button>
            <Button
              onClick={onConfirm}
              variant="accentSoft"
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.mergeProjectSource.confirm")}
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
