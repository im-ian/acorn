import { useState, type ReactElement } from "react";
import { Bot } from "lucide-react";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";
import { CheckboxRow } from "./ui/CheckboxRow";

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
        title="Control session"
        subtitle="A terminal that drives other sessions in this project"
        titleId="acorn-control-guide-title"
        icon={<Bot size={14} className="text-accent" />}
        variant="dialog"
        onClose={dismiss}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p>
          Control sessions are an upcoming way to coordinate work across
          terminals from a single place — handy for agents and scripts that
          need to dispatch commands to siblings in the same project.
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>Send keystrokes to any session in this project.</li>
          <li>List the other sessions and their status.</li>
          <li>Read recent output from a target session.</li>
        </ul>
        <p>
          You just created a control session. The{" "}
          <code className="rounded bg-bg px-1 py-0.5 text-fg">acorn-ipc</code>{" "}
          CLI that drives it ships in the next update; this terminal will
          start behaving like a regular shell until then.
        </p>
        <CheckboxRow
          label="Don't show this again"
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
          Got it
        </button>
      </footer>
    </Modal>
  );
}
