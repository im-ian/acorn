import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import type { Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

const TITLE_ID = "running-session-close-warning-title";

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface RunningSessionCloseWarningDialogProps {
  session: Session | null;
  onCancel: () => void;
  onContinue: () => void;
}

export function RunningSessionCloseWarningDialog({
  session,
  onCancel,
  onContinue,
}: RunningSessionCloseWarningDialogProps) {
  const t = useTranslation();
  const patchSessions = useSettings((s) => s.patchSessions);
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

  useEffect(() => {
    if (session) setDontWarnAgain(false);
  }, [session?.id]);

  function commitContinue() {
    if (dontWarnAgain) {
      patchSessions({ warnBeforeClosingRunning: false });
    }
    onContinue();
  }

  useDialogShortcuts(session !== null, {
    onCancel,
    onConfirm: commitContinue,
  });

  return (
    <Modal
      open={session !== null}
      onClose={onCancel}
      variant="dialog"
      size="md"
      ariaLabelledBy={TITLE_ID}
    >
      {session ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.runningSessionClose.title")}
            titleId={TITLE_ID}
            icon={<AlertTriangle size={16} className="text-warning" />}
            variant="dialog"
            onClose={onCancel}
          />
          <div className="space-y-3 px-4 py-3 text-sm text-fg">
            <p>{dt(t, "dialogs.runningSessionClose.message")}</p>
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-fg-muted">
                {dt(t, "dialogs.runningSessionClose.sessionLabel")}
              </div>
              <div className="mt-1 truncate font-mono text-xs text-accent">
                {session.name}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={dontWarnAgain}
                onChange={(e) => setDontWarnAgain(e.target.checked)}
                className="acorn-check"
              />
              {dt(t, "dialogs.runningSessionClose.dontWarnAgain")}
            </label>
          </div>
          <ModalFooter variant="sidebar">
            <Button
              onClick={onCancel}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
            <Button
              onClick={commitContinue}
              variant="dangerSoft"
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.runningSessionClose.continue")}
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
