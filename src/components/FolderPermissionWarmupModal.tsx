import { useEffect, useState, type ReactElement } from "react";
import { FolderCheck, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import {
  hasDeniedFolderPermission,
  type FolderPermissionWarmupResult,
  type FolderPermissionWarmupStatus,
} from "../lib/permissionWarmup";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface FolderPermissionWarmupModalProps {
  open: boolean;
  initialResults?: FolderPermissionWarmupResult[] | null;
  onClose: () => void;
}

function folderName(
  t: Translator,
  id: FolderPermissionWarmupResult["id"],
): string {
  switch (id) {
    case "desktop":
      return dt(t, "dialogs.folderPermissionWarmup.folder.desktop");
    case "documents":
      return dt(t, "dialogs.folderPermissionWarmup.folder.documents");
    case "downloads":
      return dt(t, "dialogs.folderPermissionWarmup.folder.downloads");
    case "icloud":
      return dt(t, "dialogs.folderPermissionWarmup.folder.icloud");
  }
}

function statusText(t: Translator, status: FolderPermissionWarmupStatus): string {
  switch (status) {
    case "ok":
      return dt(t, "dialogs.folderPermissionWarmup.status.ok");
    case "missing":
      return dt(t, "dialogs.folderPermissionWarmup.status.missing");
    case "denied":
      return dt(t, "dialogs.folderPermissionWarmup.status.denied");
    case "error":
      return dt(t, "dialogs.folderPermissionWarmup.status.error");
  }
}

function statusClass(status: FolderPermissionWarmupStatus): string {
  switch (status) {
    case "ok":
      return "text-accent";
    case "missing":
      return "text-fg-muted";
    case "denied":
    case "error":
      return "text-danger";
  }
}

function errorMessage(t: Translator, err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return dt(t, "dialogs.folderPermissionWarmup.genericError");
}

export function FolderPermissionWarmupModal({
  open,
  initialResults = null,
  onClose,
}: FolderPermissionWarmupModalProps): ReactElement | null {
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FolderPermissionWarmupResult[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const resultSummary = results
    ? hasDeniedFolderPermission(results)
      ? dt(t, "dialogs.folderPermissionWarmup.needsAttention")
      : dt(t, "dialogs.folderPermissionWarmup.complete")
    : dt(t, "dialogs.folderPermissionWarmup.question");

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setResetting(false);
    setError(null);
    setResults(initialResults);
  }, [initialResults, open]);
  const hasDeniedResult = results ? hasDeniedFolderPermission(results) : false;

  async function runWarmup() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.warmMacosFolderPermissions();
      setResults(next);
    } catch (err) {
      console.error("[FolderPermissionWarmupModal] warmup failed", err);
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function resetAndRunWarmup() {
    setResetting(true);
    setError(null);
    try {
      await api.resetMacosFolderPermissions();
      const next = await api.warmMacosFolderPermissions();
      setResults(next);
    } catch (err) {
      console.error("[FolderPermissionWarmupModal] reset failed", err);
      setError(errorMessage(t, err));
    } finally {
      setResetting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="lg"
      ariaLabelledBy="acorn-folder-permission-warmup-title"
    >
      <ModalHeader
        title={dt(t, "dialogs.folderPermissionWarmup.title")}
        subtitle={dt(t, "dialogs.folderPermissionWarmup.subtitle")}
        titleId="acorn-folder-permission-warmup-title"
        icon={<FolderCheck size={14} className="text-accent" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p className="text-fg">{resultSummary}</p>
        <p>{dt(t, "dialogs.folderPermissionWarmup.reason")}</p>
        <p>{dt(t, "dialogs.folderPermissionWarmup.bodyPrompt")}</p>
        {error ? (
          <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            {error}
          </p>
        ) : null}
        {results ? (
          <div className="rounded border border-border bg-bg">
            {results.map((result) => (
              <div
                key={result.id}
                className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="font-medium text-fg">
                    {folderName(t, result.id)}
                  </div>
                  <div className="truncate text-[11px] text-fg-muted">
                    {result.path}
                  </div>
                </div>
                <div
                  className={`shrink-0 text-[11px] font-medium ${statusClass(result.status)}`}
                >
                  {statusText(t, result.status)}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {hasDeniedResult ? (
          <p className="rounded border border-border bg-bg-elevated/40 px-3 py-2 text-fg-muted">
            {dt(t, "dialogs.folderPermissionWarmup.deniedHint")}
          </p>
        ) : null}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        {hasDeniedResult ? (
          <button
            type="button"
            onClick={() => void resetAndRunWarmup()}
            disabled={busy || resetting}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            {resetting ? <Loader2 size={12} className="animate-spin" /> : null}
            {resetting
              ? dt(t, "dialogs.folderPermissionWarmup.resetting")
              : dt(t, "dialogs.folderPermissionWarmup.reset")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          disabled={busy || resetting}
          className="rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:opacity-50"
        >
          {results || error
            ? dt(t, "dialogs.folderPermissionWarmup.done")
            : dt(t, "dialogs.folderPermissionWarmup.skip")}
        </button>
        {!results && !error ? (
          <button
            type="button"
            onClick={() => void runWarmup()}
            disabled={busy || resetting}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <FolderCheck size={12} />
            )}
            {busy
              ? dt(t, "dialogs.folderPermissionWarmup.checking")
              : dt(t, "dialogs.folderPermissionWarmup.check")}
          </button>
        ) : null}
      </footer>
    </Modal>
  );
}
