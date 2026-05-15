import { useState, type ReactElement } from "react";
import { Bot } from "lucide-react";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";
import { CheckboxRow } from "./ui/CheckboxRow";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

/**
 * localStorage key gating this modal. Exported so the App-level host can write
 * to it when the user dismisses with "don't show again". The matching read
 * (the gate that decides whether to open at all) lives in `store.ts` where
 * the session is created.
 *
 * Versioned so a future substantive change to the control-session UX can
 * re-surface the guide to existing users without colliding with the prior
 * dismissed state.
 */
export const CONTROL_GUIDE_DISMISSED_KEY = "acorn:control-guide-dismissed-v1";

interface ControlSessionGuideModalProps {
  open: boolean;
  /** Called with `true` when the user checked "don't show again" before closing. */
  onClose: (dontShowAgain: boolean) => void;
}

/**
 * One-time onboarding card shown the first time the user creates a control
 * session. Explains the concept and previews the upcoming `acorn-ipc` CLI.
 * Purely informational — does not block creation.
 */
export function ControlSessionGuideModal({
  open,
  onClose,
}: ControlSessionGuideModalProps): ReactElement | null {
  const t = useTranslation();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  function dismiss() {
    onClose(dontShowAgain);
  }

  return (
    <Modal
      open={open}
      onClose={dismiss}
      variant="dialog"
      size="lg"
      ariaLabelledBy="acorn-control-guide-title"
    >
      <ModalHeader
        title={dt(t, "dialogs.controlSessionGuide.title")}
        subtitle={dt(t, "dialogs.controlSessionGuide.subtitle")}
        titleId="acorn-control-guide-title"
        icon={<Bot size={14} className="text-accent" />}
        variant="dialog"
        onClose={dismiss}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p>
          {dt(t, "dialogs.controlSessionGuide.bodyIntro")}
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>{dt(t, "dialogs.controlSessionGuide.pointKeystrokes")}</li>
          <li>{dt(t, "dialogs.controlSessionGuide.pointListSessions")}</li>
          <li>{dt(t, "dialogs.controlSessionGuide.pointReadOutput")}</li>
        </ul>
        <p>
          {dt(t, "dialogs.controlSessionGuide.createdPrefix")}{" "}
          <code className="rounded bg-bg px-1 py-0.5 text-fg">acorn-ipc</code>{" "}
          {dt(t, "dialogs.controlSessionGuide.createdSuffix")}
        </p>
        <CheckboxRow
          label={dt(t, "dialogs.common.dontShowAgain")}
          checked={dontShowAgain}
          onChange={setDontShowAgain}
        />
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={dismiss}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90"
        >
          {dt(t, "dialogs.common.gotIt")}
        </button>
      </footer>
    </Modal>
  );
}
