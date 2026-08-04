import { FolderOpen } from "lucide-react";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

const TITLE_ID = "add-existing-project-title";

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface AddExistingProjectDialogProps {
  open: boolean;
  choosing: boolean;
  onCancel: () => void;
  onChoose: () => void;
}

/**
 * Sits in front of the folder picker so opening a project is a decision, not a
 * side effect of a keystroke: it says what registering a folder does, which
 * agents read the extra source folders, and adds nothing until the user picks.
 */
export function AddExistingProjectDialog({
  open,
  choosing,
  onCancel,
  onChoose,
}: AddExistingProjectDialogProps) {
  const t = useTranslation();

  useDialogShortcuts(open, { onCancel, onConfirm: onChoose });

  return (
    <Modal
      open={open}
      onClose={onCancel}
      variant="dialog"
      size="md"
      ariaLabelledBy={TITLE_ID}
    >
      <ModalHeader
        title={dt(t, "dialogs.addExistingProject.title")}
        titleId={TITLE_ID}
        icon={<FolderOpen size={16} className="text-accent" />}
        variant="dialog"
        onClose={onCancel}
      />
      <div className="space-y-3 px-4 py-3 text-sm text-fg">
        <p>{dt(t, "dialogs.addExistingProject.message")}</p>
        <Notice tone="info">
          {dt(t, "dialogs.addExistingProject.agentSupport")}
        </Notice>
        <p className="text-xs text-fg-muted">
          {dt(t, "dialogs.addExistingProject.noSessionHint")}
        </p>
      </div>
      <ModalFooter variant="sidebar">
        <Button onClick={onCancel} size="md" surface="dialog">
          {dt(t, "dialogs.common.cancel")}
        </Button>
        <Button
          onClick={onChoose}
          disabled={choosing}
          variant="accentSoft"
          size="md"
          surface="dialog"
        >
          {choosing
            ? dt(t, "dialogs.addExistingProject.choosing")
            : dt(t, "dialogs.addExistingProject.choose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
