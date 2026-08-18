import { useState, type ReactElement } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { api, type StagedRevMismatch } from "../lib/api";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!mismatch) return null;

  async function handleRestart() {
    if (restarting || dismissing) return;
    setRestarting(true);
    setError(null);
    try {
      await api.daemonShutdown();
      await api.acknowledgeStagedRevMismatch();
      // Webview reload re-runs the app setup. The daemon boot thread
      // will spawn a fresh `acornd` process whose registry is empty, so
      // the next reconcile finds nothing stale and the prompt does not
      // reappear.
      window.location.reload();
    } catch (err) {
      console.error("[StagedRevMismatchModal] restart failed", err);
      setError(
        `${dt(t, "dialogs.stagedRevMismatch.restartFailed")} ${errorMessage(err)}`,
      );
      setRestarting(false);
      return;
    }
  }

  async function handleLater() {
    if (restarting || dismissing) return;
    setDismissing(true);
    setError(null);
    try {
      await api.acknowledgeStagedRevMismatch();
    } catch (err) {
      console.error(
        "[StagedRevMismatchModal] acknowledge_staged_rev_mismatch failed",
        err,
      );
      setError(
        `${dt(t, "dialogs.stagedRevMismatch.dismissFailed")} ${errorMessage(err)}`,
      );
      setDismissing(false);
      return;
    }
    onDismiss();
  }

  const busy = restarting || dismissing;

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
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
      <ModalFooter>
        <Button
          onClick={handleLater}
          disabled={busy}
          className="disabled:opacity-50"
        >
          {dt(t, "dialogs.stagedRevMismatch.later")}
        </Button>
        <Button
          onClick={handleRestart}
          disabled={busy}
          variant="primary"
          className="disabled:opacity-50"
        >
          <RefreshCw
            size={12}
            className={restarting ? "animate-spin" : undefined}
          />
          {restarting
            ? dt(t, "dialogs.stagedRevMismatch.restarting")
            : dt(t, "dialogs.stagedRevMismatch.restartSessions")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
