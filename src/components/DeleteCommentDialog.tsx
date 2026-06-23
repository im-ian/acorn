import { useEffect, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

const TITLE_ID = "delete-comment-title";

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface DeleteCommentDialogProps {
  open: boolean;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}

export function DeleteCommentDialog({
  open,
  onCancel,
  onDelete,
}: DeleteCommentDialogProps) {
  const t = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDeleting(false);
      setError(null);
    }
  }, [open]);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
    }
  }

  useDialogShortcuts(open, {
    onCancel,
    onConfirm: () => void handleDelete(),
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
        title={dt(t, "dialogs.githubComment.deleteTitle")}
        titleId={TITLE_ID}
        icon={<AlertTriangle size={16} className="text-danger" />}
        variant="dialog"
        onClose={onCancel}
      />
      <div className="space-y-2 px-4 py-3 text-xs leading-relaxed text-fg-muted">
        <p>{dt(t, "dialogs.githubComment.deleteMessage")}</p>
        {error ? (
          <Notice tone="danger" density="compact">
            {dt(t, "dialogs.githubComment.deleteFailed")} {error}
          </Notice>
        ) : null}
      </div>
      <ModalFooter variant="sidebar">
        <Button
          onClick={onCancel}
          disabled={deleting}
          size="md"
          surface="dialog"
        >
          {dt(t, "dialogs.common.cancel")}
        </Button>
        <Button
          onClick={() => void handleDelete()}
          disabled={deleting}
          variant="dangerSoft"
          size="md"
          surface="dialog"
        >
          <Trash2 size={13} />
          {deleting
            ? dt(t, "dialogs.githubComment.deleting")
            : dt(t, "dialogs.githubComment.deleteConfirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
