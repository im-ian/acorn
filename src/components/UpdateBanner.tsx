import { Download, X } from "lucide-react";
import type { ReactElement } from "react";
import { selectShouldNotify, useUpdater } from "../lib/updater-store";

/**
 * Top-of-app non-blocking banner that surfaces an available update.
 * "Install" calls into the updater store to download + relaunch;
 * "Later" dismisses the banner for the current version only.
 *
 * Deliberately not a modal: the user is never blocked from working;
 * the same update remains accessible via Settings → Storage if they
 * want to revisit it.
 */
export function UpdateBanner(): ReactElement | null {
  const should = useUpdater(selectShouldNotify);
  const update = useUpdater((s) => s.available);
  const busy = useUpdater((s) => s.busy);
  const install = useUpdater((s) => s.install);
  const dismiss = useUpdater((s) => s.dismiss);

  if (!should || !update) return null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-accent/10 px-4 py-2 text-xs">
      <Download size={14} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-fg">Acorn {update.version}</span>
        <span className="ml-2 text-fg-muted">
          is available. The app will relaunch after install.
        </span>
      </div>
      <button
        type="button"
        onClick={() => void install()}
        disabled={busy}
        className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
      >
        {busy ? "Installing…" : "Install & relaunch"}
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
  );
}
