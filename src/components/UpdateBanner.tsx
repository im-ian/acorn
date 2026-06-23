import { Download, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { selectShouldNotify, useUpdater } from "../lib/updater-store";
import { useTranslation } from "../lib/useTranslation";
import { Tooltip } from "./Tooltip";
import { WhatsNewModal } from "./WhatsNewModal";
import { Button, IconButton, Notice } from "./ui";

/**
 * Top-of-app non-blocking banner that surfaces an available update.
 * "Install" calls into the updater store to download + relaunch;
 * "What's new" opens a dedicated release-notes dialog (same one the
 * Settings → About panel uses); "Later" dismisses the banner for the
 * current version only — the same update remains reachable from
 * Settings.
 *
 * The banner also shows a single-line error if `install()` fails (e.g.
 * "signature verification failed", network drops) so users aren't left
 * wondering why the click did nothing.
 */
export function UpdateBanner(): ReactElement | null {
  const t = useTranslation();
  const should = useUpdater(selectShouldNotify);
  const update = useUpdater((s) => s.available);
  const currentVersion = useUpdater((s) => s.currentVersion);
  const busy = useUpdater((s) => s.busy);
  const error = useUpdater((s) => s.error);
  const install = useUpdater((s) => s.install);
  const dismiss = useUpdater((s) => s.dismiss);
  const clearError = useUpdater((s) => s.clearError);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  if (!should || !update) return null;

  return (
    <>
      <div className="border-b border-border bg-accent/10 text-xs">
        <div className="flex items-center gap-3 px-4 py-2">
          <Download size={14} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-fg">Acorn {update.version}</span>
            <span className="ml-2 text-fg-muted">
              {t("updateBanner.available")}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setWhatsNewOpen(true)}
            className="rounded px-2 py-1 text-[11px] text-fg-muted underline-offset-2 transition hover:text-fg hover:underline"
          >
            {t("updateBanner.whatsNew")}
          </button>
          <Button
            onClick={() => void install()}
            disabled={busy}
            variant="primary"
            size="xs"
            className="text-[11px] disabled:opacity-50"
          >
            {busy
              ? t("updateBanner.installing")
              : t("updateBanner.installRelaunch")}
          </Button>
          <Tooltip label={t("updateBanner.hideUntilNextVersion")} side="bottom">
            <IconButton
              onClick={dismiss}
              disabled={busy}
              aria-label={t("updateBanner.hideUntilNextVersion")}
              size="sm"
              className="disabled:opacity-50"
            >
              <X size={14} />
            </IconButton>
          </Tooltip>
        </div>
        {error ? (
          <Notice
            tone="danger"
            density="compact"
            className="flex items-start gap-2 rounded-none border-x-0 border-b-0 border-danger/30 px-4 py-1.5"
          >
            <span className="flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 rounded p-0.5 text-danger/80 transition hover:bg-danger/20 hover:text-danger"
              aria-label={t("updateBanner.dismissError")}
            >
              <X size={12} />
            </button>
          </Notice>
        ) : null}
      </div>
      <WhatsNewModal
        open={whatsNewOpen}
        onClose={() => setWhatsNewOpen(false)}
        version={update.version}
        body={update.body ?? ""}
        currentVersion={currentVersion}
        showInstall
        busy={busy}
        error={error}
        onInstall={() => void install()}
      />
    </>
  );
}
