import { Download, Sparkles } from "lucide-react";
import type { ReactElement } from "react";
import { useUpdater } from "../lib/updater-store";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";
import { Markdown } from "./ui/Markdown";

interface WhatsNewModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Standalone release-notes dialog. Triggered both from the top-of-app
 * `UpdateBanner` and from the Settings → About panel so the same content
 * surfaces in one place regardless of entry point.
 *
 * Reads `available` / `currentVersion` directly from the updater store —
 * the modal renders nothing when no update is pending, which is the same
 * lifecycle the banner already obeys.
 */
export function WhatsNewModal({
  open,
  onClose,
}: WhatsNewModalProps): ReactElement | null {
  const update = useUpdater((s) => s.available);
  const currentVersion = useUpdater((s) => s.currentVersion);
  const busy = useUpdater((s) => s.busy);
  const error = useUpdater((s) => s.error);
  const install = useUpdater((s) => s.install);

  if (!update) return null;

  const body = update.body?.trim() ?? "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabelledBy="acorn-whatsnew-title"
    >
      <ModalHeader
        title={`What's new in Acorn ${update.version}`}
        subtitle={
          currentVersion ? `currently running ${currentVersion}` : undefined
        }
        titleId="acorn-whatsnew-title"
        icon={<Sparkles size={14} className="text-accent" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="max-h-[28rem] overflow-y-auto px-4 py-4">
        {body.length > 0 ? (
          <Markdown content={body} className="text-xs" />
        ) : (
          <p className="text-xs text-fg-muted">
            No release notes were published with this version.
          </p>
        )}
      </div>
      {error ? (
        <p className="border-t border-danger/40 bg-danger/10 px-4 py-2 text-[11px] text-danger">
          {error}
        </p>
      ) : null}
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => void install()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
        >
          <Download size={12} />
          {busy ? "Installing…" : "Install & relaunch"}
        </button>
      </footer>
    </Modal>
  );
}
