import { AlertTriangle } from "lucide-react";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

const TITLE_ID = "discard-comment-draft-title";

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface DiscardCommentDraftDialogProps {
  open: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}

export function DiscardCommentDraftDialog({
  open,
  onCancel,
  onDiscard,
}: DiscardCommentDraftDialogProps) {
  const t = useTranslation();

  useDialogShortcuts(open, {
    onCancel,
    onConfirm: onDiscard,
  });

  return (
    <Modal
      open={open}
      onClose={onCancel}
      variant="dialog"
      size="sm"
      ariaLabelledBy={TITLE_ID}
    >
      <ModalHeader
        title={dt(t, "dialogs.commentDraftDiscard.title")}
        titleId={TITLE_ID}
        icon={<AlertTriangle size={16} className="text-warning" />}
        variant="dialog"
        onClose={onCancel}
      />
      <p className="px-4 py-3 text-xs leading-relaxed text-fg-muted">
        {dt(t, "dialogs.commentDraftDiscard.message")}
      </p>
      <ModalFooter variant="sidebar">
        <Button onClick={onCancel} size="md" surface="dialog">
          {dt(t, "dialogs.commentDraftDiscard.keepEditing")}
        </Button>
        <Button
          onClick={onDiscard}
          variant="dangerSoft"
          size="md"
          surface="dialog"
        >
          {dt(t, "dialogs.commentDraftDiscard.discard")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
