import { useEffect, useState } from "react";
import { GitPullRequestClosed } from "lucide-react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { emitPullRequestMutation } from "../lib/pullRequestEvents";
import { useToasts } from "../lib/toasts";
import type { PullRequestDetail } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import {
  Button,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  SkeletonBlock,
} from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function CloseDialogSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="space-y-3 px-4 py-3 text-sm text-fg"
    >
      <SkeletonBlock className="h-3 w-48 bg-bg-sidebar" />
      <div className="space-y-2 rounded-md border border-border bg-bg-sidebar/60 p-3">
        <SkeletonBlock className="h-3 w-3/4 bg-bg-elevated" />
        <SkeletonBlock className="h-3 w-1/2 bg-bg-elevated" />
      </div>
    </div>
  );
}

interface ClosePullRequestDialogProps {
  open: boolean;
  repoPath: string;
  number?: number;
  detail: PullRequestDetail | null;
  loading?: boolean;
  loadError?: string | null;
  onClose: () => void;
  onClosed: () => void;
}

export function ClosePullRequestDialog({
  open,
  repoPath,
  number,
  detail,
  loading = false,
  loadError = null,
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
      emitPullRequestMutation({
        kind: "closed",
        repoPath,
        number: detail.number,
        headBranch: detail.head_branch,
        baseBranch: detail.base_branch,
        title: detail.title,
        isDraft: detail.is_draft,
      });
      onClosed();
    } catch (e) {
      const message = String(e);
      setError(message);
      showToast(`${t("toasts.pullRequests.closeFailed")} ${message}`);
      setSubmitting(false);
    }
  }

  const dialogNumber = detail?.number ?? number;
  const dialogTitle = `${dt(t, "dialogs.closePullRequest.titlePrefix")}${
    dialogNumber ? ` #${dialogNumber}` : ""
  }`;

  return (
    <Modal open={open} onClose={onClose} variant="dialog" size="md">
      {!detail ? (
        <>
          <ModalHeader
            title={dialogTitle}
            icon={<GitPullRequestClosed size={16} className="text-rose-400" />}
            variant="dialog"
            onClose={onClose}
          />
          {loadError && !loading ? (
            <div className="space-y-3 px-4 py-3 text-xs text-fg">
              <Notice tone="danger" density="compact">
                {loadError}
              </Notice>
            </div>
          ) : (
            <CloseDialogSkeleton
              label={dt(t, "dialogs.closePullRequest.loadingDetails")}
            />
          )}
          <ModalFooter variant="sidebar">
            <Button
              onClick={onClose}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <>
          <ModalHeader
            title={dialogTitle}
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
      )}
    </Modal>
  );
}
