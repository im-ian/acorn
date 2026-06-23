import { useEffect, useState } from "react";
import { GitPullRequestClosed } from "lucide-react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useToasts } from "../lib/toasts";
import type { PullRequestDetail } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Modal, ModalHeader } from "./ui";

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
      <div className="h-3 w-48 animate-pulse rounded bg-bg-sidebar" />
      <div className="space-y-2 rounded-md border border-border bg-bg-sidebar/60 p-3">
        <div className="h-3 w-3/4 animate-pulse rounded bg-bg-elevated" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-bg-elevated" />
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
              <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
                {loadError}
              </p>
            </div>
          ) : (
            <CloseDialogSkeleton
              label={dt(t, "dialogs.closePullRequest.loadingDetails")}
            />
          )}
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
            >
              {dt(t, "dialogs.common.cancel")}
            </button>
          </footer>
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
              <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dt(t, "dialogs.common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleClose()}
              disabled={submitting}
              className="rounded-md bg-rose-500/20 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting
                ? dt(t, "dialogs.closePullRequest.closing")
                : dt(t, "dialogs.closePullRequest.closePr")}
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}
