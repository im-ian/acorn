import { useState, type ReactElement } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { api, type StagedRevMismatch } from "../lib/api";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface StagedRevMismatchModalProps {
  mismatch: StagedRevMismatch | null;
  onDismiss: () => void;
}

/**
 * Boot-time prompt shown when `acornd` still owns PTY sessions
 * spawned against an older `shell-init/` revision than the running
 * build. Reattaching to those PTYs leaves the user typing into a
 * ZLE wired up against the old `.zshrc` — surfaces as duplicated
 * keystrokes / broken prompt redraws.
 */
export function StagedRevMismatchModal({
  mismatch,
  onDismiss,
}: StagedRevMismatchModalProps): ReactElement | null {
  const t = useTranslation();
  const [restarting, setRestarting] = useState(false);

  if (!mismatch) return null;

  async function handleRestart() {
    setRestarting(true);
    try {
      await api.daemonShutdown();
    } catch (err) {
      console.error("[StagedRevMismatchModal] daemon_shutdown failed", err);
    }
    try {
      await api.acknowledgeStagedRevMismatch();
    } catch (err) {
      console.error(
        "[StagedRevMismatchModal] acknowledge_staged_rev_mismatch failed",
        err,
      );
    }
    // Webview reload re-runs the app setup. The daemon boot thread
    // will spawn a fresh `acornd` process whose registry is empty, so
    // the next reconcile finds nothing stale and the prompt does not
    // reappear.
    window.location.reload();
  }

  async function handleLater() {
    try {
      await api.acknowledgeStagedRevMismatch();
    } catch (err) {
      console.error(
        "[StagedRevMismatchModal] acknowledge_staged_rev_mismatch failed",
        err,
      );
    }
    onDismiss();
  }

  const sessionWord =
    mismatch.stale_session_count === 1
      ? dt(t, "dialogs.stagedRevMismatch.sessionSingular")
      : dt(t, "dialogs.stagedRevMismatch.sessionPlural");

  return (
    <Modal
      open={true}
      onClose={handleLater}
      variant="dialog"
      size="md"
      ariaLabelledBy="acorn-staged-rev-mismatch-title"
    >
      <ModalHeader
        title={dt(t, "dialogs.stagedRevMismatch.title")}
        subtitle={`${mismatch.stale_session_count} ${dt(t, "dialogs.stagedRevMismatch.background")} ${sessionWord} ${dt(t, "dialogs.stagedRevMismatch.needRestart")}`}
        titleId="acorn-staged-rev-mismatch-title"
        icon={<Terminal size={14} className="text-accent" />}
        variant="dialog"
        onClose={handleLater}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p>
          {dt(t, "dialogs.stagedRevMismatch.bodyIntro")}
        </p>
        <p>
          {dt(t, "dialogs.stagedRevMismatch.bodyRestart")}
        </p>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={handleLater}
          disabled={restarting}
          className="rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:opacity-50"
        >
          {dt(t, "dialogs.stagedRevMismatch.later")}
        </button>
        <button
          type="button"
          onClick={handleRestart}
          disabled={restarting}
          className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
        >
          <RefreshCw
            size={12}
            className={restarting ? "animate-spin" : undefined}
          />
          {restarting
            ? dt(t, "dialogs.stagedRevMismatch.restarting")
            : dt(t, "dialogs.stagedRevMismatch.restartSessions")}
        </button>
      </footer>
    </Modal>
  );
}
