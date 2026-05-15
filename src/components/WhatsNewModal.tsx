import { Download, ExternalLink, Sparkles } from "lucide-react";
import type { ReactElement } from "react";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";
import { Markdown } from "./ui/Markdown";
import { TextSwap } from "./ui/TextSwap";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface WhatsNewModalProps {
  open: boolean;
  onClose: () => void;
  /** Version whose notes are being shown, e.g. "1.0.8". */
  version: string;
  /** Raw markdown release body. Empty string shows the placeholder. */
  body: string;
  /** Currently-running app version, rendered in the subtitle for context. */
  currentVersion: string | null;
  /**
   * When true, the modal renders the "Install & relaunch" action — used
   * by the update banner / settings update row. Omit (or set false) for
   * the "browse current version's notes" flow on the About tab.
   */
  showInstall?: boolean;
  /** Disables the install button while a download/install is running. */
  busy?: boolean;
  /** Error message shown above the footer. */
  error?: string | null;
  /** Invoked when the install button is clicked. Required if showInstall. */
  onInstall?: () => void;
  /** Optional public release URL — renders a "View on GitHub" affordance. */
  htmlUrl?: string;
  /**
   * When true, the modal subtitle explains that these notes belong to a
   * *different* version than the one the user is running — used when the
   * running version doesn't have a public release and we fall back to
   * the latest one.
   */
  isFallback?: boolean;
}

/**
 * Standalone release-notes dialog. Fed from two surfaces:
 *
 *   1. The pending-update flow (UpdateBanner + the inline button on the
 *      Settings → About update row) — passes the pending `Update` body
 *      and `showInstall=true` to expose the install action.
 *   2. The browse-current-version flow on the Settings → About tab —
 *      passes notes fetched from GitHub Releases for the running
 *      version, with `showInstall=false`.
 *
 * Keeping the modal fully prop-driven (no store reads) makes both flows
 * trivially testable in isolation and avoids the previous coupling
 * where the modal silently rendered nothing whenever the updater store
 * had no `available` update.
 */
export function WhatsNewModal({
  open,
  onClose,
  version,
  body,
  currentVersion,
  showInstall = false,
  busy = false,
  error,
  onInstall,
  htmlUrl,
  isFallback = false,
}: WhatsNewModalProps): ReactElement | null {
  const t = useTranslation();
  const trimmedBody = body.trim();
  const subtitle = isFallback
    ? `${dt(t, "dialogs.whatsNew.latestPublished")} ${currentVersion ?? dt(t, "dialogs.whatsNew.yourVersion")}`
    : currentVersion && currentVersion !== version
      ? `${dt(t, "dialogs.whatsNew.currentlyRunning")} ${currentVersion}`
      : currentVersion === version
        ? dt(t, "dialogs.whatsNew.onThisVersion")
        : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabelledBy="acorn-whatsnew-title"
    >
      <ModalHeader
        title={`${dt(t, "dialogs.whatsNew.titlePrefix")} ${version}`}
        subtitle={subtitle}
        titleId="acorn-whatsnew-title"
        icon={<Sparkles size={14} className="text-accent" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="max-h-[28rem] overflow-y-auto px-4 py-4">
        {trimmedBody.length > 0 ? (
          <Markdown content={trimmedBody} className="text-xs" />
        ) : (
          <p className="text-xs text-fg-muted">
            {dt(t, "dialogs.whatsNew.noReleaseNotes")}
          </p>
        )}
      </div>
      {error ? (
        <p className="border-t border-danger/40 bg-danger/10 px-4 py-2 text-[11px] text-danger">
          {error}
        </p>
      ) : null}
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        {htmlUrl ? (
          <a
            href={htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <ExternalLink size={12} />
            {dt(t, "dialogs.whatsNew.viewOnGithub")}
          </a>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          {dt(t, "dialogs.common.close")}
        </button>
        {showInstall && onInstall ? (
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            <Download size={12} />
            <TextSwap>
              {busy
                ? dt(t, "dialogs.whatsNew.installing")
                : dt(t, "dialogs.whatsNew.installRelaunch")}
            </TextSwap>
          </button>
        ) : null}
      </footer>
    </Modal>
  );
}
