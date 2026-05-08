import { Download, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { selectShouldNotify, useUpdater } from "../lib/updater-store";
import { TextSwap } from "./ui/TextSwap";
import { WhatsNewModal } from "./WhatsNewModal";

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
  const should = useUpdater(selectShouldNotify);
  const update = useUpdater((s) => s.available);
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
              is available. The app will relaunch after install.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setWhatsNewOpen(true)}
            className="rounded px-2 py-1 text-[11px] text-fg-muted underline-offset-2 transition hover:text-fg hover:underline"
          >
            What&apos;s new
          </button>
          <button
            type="button"
            onClick={() => void install()}
            disabled={busy}
            className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            <TextSwap>{busy ? "Installing…" : "Install & relaunch"}</TextSwap>
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            title="Hide until next version"
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>
        {error ? (
          <div className="flex items-start gap-2 border-t border-danger/30 bg-danger/10 px-4 py-1.5 text-[11px] text-danger">
            <span className="flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 rounded p-0.5 text-danger/80 transition hover:bg-danger/20 hover:text-danger"
              aria-label="Dismiss error"
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
      </div>
      <WhatsNewModal
        open={whatsNewOpen}
        onClose={() => setWhatsNewOpen(false)}
      />
    </>
  );
}
