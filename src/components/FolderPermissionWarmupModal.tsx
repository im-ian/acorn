import { useState, type ReactElement } from "react";
import { FolderCheck, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import {
  markPermissionWarmupHandled,
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
  currentVersion: string | null;
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

export function FolderPermissionWarmupModal({
  open,
  currentVersion,
  onClose,
}: FolderPermissionWarmupModalProps): ReactElement | null {
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FolderPermissionWarmupResult[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  function closeForVersion() {
    if (currentVersion) markPermissionWarmupHandled(currentVersion);
    onClose();
  }

  async function runWarmup() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.warmMacosFolderPermissions();
      setResults(next);
    } catch (err) {
      console.error("[FolderPermissionWarmupModal] warmup failed", err);
      setError(
        err instanceof Error
          ? err.message
          : dt(t, "dialogs.folderPermissionWarmup.genericError"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeForVersion}
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
        onClose={closeForVersion}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p>{dt(t, "dialogs.folderPermissionWarmup.bodyIntro")}</p>
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
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={closeForVersion}
          disabled={busy}
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
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {busy
              ? dt(t, "dialogs.folderPermissionWarmup.checking")
              : dt(t, "dialogs.folderPermissionWarmup.check")}
          </button>
        ) : null}
      </footer>
    </Modal>
  );
}
