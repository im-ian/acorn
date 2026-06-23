import { useEffect, useState } from "react";
import { GitPullRequestClosed } from "lucide-react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useToasts } from "../lib/toasts";
import type { PullRequestDetail } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface ClosePullRequestDialogProps {
  open: boolean;
  repoPath: string;
  detail: PullRequestDetail | null;
  onClose: () => void;
  onClosed: () => void;
}

export function ClosePullRequestDialog({
  open,
  repoPath,
  detail,
  onClose,
  onClosed,
}: ClosePullRequestDialogProps) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setError(null);
  }, [open]);

  useDialogShortcuts(open, {
    onCancel: () => {
      if (!submitting) onClose();
    },
    onConfirm: () => {
      if (!submitting) void handleClose();
    },
  });

  async function handleClose() {
    if (!detail) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.closePullRequest(repoPath, detail.number);
      onClosed();
    } catch (e) {
      const message = String(e);
      setError(message);
      showToast(`${t("toasts.pullRequests.closeFailed")} ${message}`);
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} variant="dialog" size="md">
      {detail ? (
        <>
          <ModalHeader
            title={`${dt(t, "dialogs.closePullRequest.titlePrefix")} #${detail.number}`}
            icon={
              <GitPullRequestClosed size={16} className="text-rose-400" />
            }
            variant="dialog"
            onClose={() => {
              if (!submitting) onClose();
            }}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p className="text-xs">
              {dt(t, "dialogs.closePullRequest.confirmPrefix")}{" "}
              <span className="font-mono text-accent">#{detail.number}</span>{" "}
              {dt(t, "dialogs.closePullRequest.confirmSuffix")}
            </p>
            <div className="rounded-md border border-border bg-bg-sidebar/60 p-3 text-[11px]">
              <p className="truncate font-medium">{detail.title}</p>
              <p className="mt-1 truncate font-mono text-fg-muted">
                {detail.head_branch} → {detail.base_branch}
              </p>
            </div>
            {error ? (
              <Notice tone="danger" density="compact">
                {error}
              </Notice>
            ) : null}
          </div>
          <ModalFooter variant="sidebar">
            <Button
              onClick={onClose}
              disabled={submitting}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
            <Button
              onClick={() => void handleClose()}
              disabled={submitting}
              variant="dangerSoft"
              size="md"
              surface="dialog"
            >
              {submitting
                ? dt(t, "dialogs.closePullRequest.closing")
                : dt(t, "dialogs.closePullRequest.closePr")}
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
