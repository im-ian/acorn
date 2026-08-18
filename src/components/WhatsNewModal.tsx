import { ExternalLink, Sparkles } from "lucide-react";
import type { ReactElement } from "react";
import type { TranslationKey, Translator } from "../lib/i18n";
import { isSafeOpenUrl } from "../lib/safeOpenUrl";
import { openExternalUrlWithFeedback } from "../lib/externalOpener";
import { useTranslation } from "../lib/useTranslation";
import {
  Button,
  Markdown,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  SkeletonBlock,
} from "./ui";

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
   * When true, the modal renders the manual download-page action — used
   * by the update banner / settings update row. Omit (or set false) for
   * the "browse current version's notes" flow on the About tab.
   */
  showDownload?: boolean;
  /** Disables the action while the release page is being opened. */
  busy?: boolean;
  /** Shows a skeleton while release notes are being fetched. */
  loading?: boolean;
  /** Error message shown above the footer. */
  error?: string | null;
  /** Invoked when the download-page action is clicked. */
  onOpenDownload?: () => void;
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

function ReleaseNotesSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="space-y-4"
    >
      <div className="space-y-2">
        <SkeletonBlock className="h-4 w-40 bg-bg-sidebar" />
        <SkeletonBlock className="h-3 w-full bg-bg-sidebar" />
        <SkeletonBlock className="h-3 w-5/6 bg-bg-sidebar" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-4 w-28 bg-bg-sidebar" />
        <SkeletonBlock className="h-3 w-11/12 bg-bg-sidebar" />
        <SkeletonBlock className="h-3 w-2/3 bg-bg-sidebar" />
      </div>
    </div>
  );
}

/**
 * Standalone release-notes dialog. Fed from two surfaces:
 *
 *   1. The pending-update flow (UpdateBanner + the inline button on the
 *      Settings → About update row) — passes validated release metadata
 *      and `showDownload=true` to expose the manual download action.
 *   2. The browse-current-version flow on the Settings → About tab —
 *      passes notes fetched from GitHub Releases for the running
 *      version, with `showDownload=false`.
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
  showDownload = false,
  busy = false,
  loading = false,
  error,
  onOpenDownload,
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
        {loading ? (
          <ReleaseNotesSkeleton
            label={dt(t, "dialogs.whatsNew.loadingReleaseNotes")}
          />
        ) : trimmedBody.length > 0 ? (
          <Markdown content={trimmedBody} className="text-xs" softBreaks />
        ) : error ? null : (
          <p className="text-xs text-fg-muted">
            {dt(t, "dialogs.whatsNew.noReleaseNotes")}
          </p>
        )}
      </div>
      {error ? (
        <Notice
          tone="danger"
          density="compact"
          className="rounded-none border-x-0 border-b-0 px-4 py-2"
        >
          {error}
        </Notice>
      ) : null}
      <ModalFooter>
        {htmlUrl && isSafeOpenUrl(htmlUrl) ? (
          <Button
            onClick={() => void openExternalUrlWithFeedback(htmlUrl)}
          >
            <ExternalLink size={12} />
            {dt(t, "dialogs.whatsNew.viewOnGithub")}
          </Button>
        ) : null}
        <Button
          onClick={onClose}
        >
          {dt(t, "dialogs.common.close")}
        </Button>
        {showDownload && onOpenDownload ? (
          <Button
            onClick={onOpenDownload}
            disabled={busy}
            variant="primary"
            className="disabled:opacity-50"
          >
            <ExternalLink size={12} />
            {busy
              ? dt(t, "dialogs.whatsNew.installing")
              : dt(t, "dialogs.whatsNew.installRelaunch")}
          </Button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}
