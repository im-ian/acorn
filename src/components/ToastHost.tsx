import type { ReactElement } from "react";
import { useToasts } from "../lib/toasts";

/**
 * Renders the active toast (if any) above the bottom status bar.
 * Pointer-events disabled so the toast never blocks clicks on the
 * underlying UI. Auto-dismisses via the store's TTL — there is no manual
 * close affordance because every existing trigger is a deliberate user
 * action whose feedback is fine to fade.
 */
export function ToastHost(): ReactElement | null {
  const message = useToasts((s) => s.message);
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(1.5rem+var(--acorn-status-bar-height))] z-50 flex justify-center">
      <div
        role="status"
        aria-live="polite"
        className="rounded border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg shadow-md"
      >
        {message}
      </div>
    </div>
  );
}
