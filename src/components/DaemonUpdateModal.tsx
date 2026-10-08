import { useState, type ReactElement } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { api, type DaemonVersionMismatch } from "../lib/api";
import {
  clearDaemonUpdateResumePass,
  stashDaemonUpdateResumePass,
} from "../lib/daemonUpdateResume";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DaemonUpdateModalProps {
  mismatch: DaemonVersionMismatch | null;
  onDismiss: () => void;
}

/**
 * Boot-time prompt shown when the running `acornd` was built by an
 * older app version but still owns live PTYs. The bridge preserves
 * that generation for every RPC — new spawns included — so daemon-side
 * fixes (PTY spawn env among them) never reach new sessions until the
 * daemon restarts. Updating kills the preserved shells; a resume pass
 * stashed across the reload re-enters each agent conversation.
 */
export function DaemonUpdateModal({
  mismatch,
  onDismiss,
}: DaemonUpdateModalProps): ReactElement | null {
  const t = useTranslation();
  const [updating, setUpdating] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!mismatch) return null;

  async function handleUpdate() {
    if (updating || dismissing) return;
    setUpdating(true);
    setError(null);
    stashDaemonUpdateResumePass(useAppStore.getState().sessions);
    try {
      await api.daemonShutdown();
    } catch (err) {
      // No reload will follow — drop the stash so a later boot does
      // not type resume commands into live agent TUIs.
      clearDaemonUpdateResumePass();
      console.error("[DaemonUpdateModal] daemon shutdown failed", err);
      setError(
        `${dt(t, "dialogs.daemonUpdate.updateFailed")} ${errorMessage(err)}`,
      );
      setUpdating(false);
      return;
    }
    try {
      await api.acknowledgeDaemonVersionMismatch();
      // Webview reload re-runs the app setup: the daemon boot thread
      // spawns a fresh `acornd` from the current build, and the boot
      // resume pass queues each session's agent resume command.
      window.location.reload();
    } catch (err) {
      console.error("[DaemonUpdateModal] acknowledge failed", err);
      setError(
        `${dt(t, "dialogs.daemonUpdate.updateFailed")} ${errorMessage(err)}`,
      );
      setUpdating(false);
      return;
    }
  }

  async function handleLater() {
    if (updating || dismissing) return;
    setDismissing(true);
    setError(null);
    try {
      await api.acknowledgeDaemonVersionMismatch();
    } catch (err) {
      console.error(
        "[DaemonUpdateModal] acknowledge_daemon_version_mismatch failed",
        err,
      );
      setError(
        `${dt(t, "dialogs.daemonUpdate.dismissFailed")} ${errorMessage(err)}`,
      );
      setDismissing(false);
      return;
    }
    onDismiss();
  }

  const busy = updating || dismissing;

  const sessionWord =
    mismatch.alive_session_count === 1
      ? dt(t, "dialogs.daemonUpdate.sessionSingular")
      : dt(t, "dialogs.daemonUpdate.sessionPlural");

  return (
    <Modal
      open={true}
      onClose={handleLater}
      variant="dialog"
      size="md"
      ariaLabelledBy="acorn-daemon-update-title"
    >
      <ModalHeader
        title={dt(t, "dialogs.daemonUpdate.title")}
        subtitle={`${mismatch.daemon_version} → ${mismatch.app_version}`}
        titleId="acorn-daemon-update-title"
        icon={<Terminal size={14} className="text-accent" />}
        variant="dialog"
        onClose={handleLater}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p>{dt(t, "dialogs.daemonUpdate.bodyIntro")}</p>
        <p>
          {dt(t, "dialogs.daemonUpdate.bodyUpdate")
            .replace("{count}", String(mismatch.alive_session_count))
            .replace("{sessions}", sessionWord)}
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
          {dt(t, "dialogs.daemonUpdate.later")}
        </Button>
        <Button
          onClick={handleUpdate}
          disabled={busy}
          variant="primary"
          className="disabled:opacity-50"
        >
          <RefreshCw
            size={12}
            className={updating ? "animate-spin" : undefined}
          />
          {updating
            ? dt(t, "dialogs.daemonUpdate.updating")
            : dt(t, "dialogs.daemonUpdate.updateNow")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
