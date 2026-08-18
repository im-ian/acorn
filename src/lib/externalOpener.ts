import { openSafeUrl } from "./safeOpenUrl";
import { showTranslatedErrorToast, showTranslatedToast } from "./operationToasts";

/**
 * Open an external link through the URL policy gate and keep failures visible.
 *
 * This wraps `openSafeUrl` rather than the opener plugin directly so the policy
 * check — and the matching one the Rust command applies — stays on the path.
 * Callers that already surface the outcome themselves (the updater's canonical
 * release page, the commit view's inline error) should keep calling
 * `openSafeUrl` so a failure is not reported twice.
 */
export async function openExternalUrlWithFeedback(url: string): Promise<boolean> {
  try {
    const opened = await openSafeUrl(url);
    if (!opened) {
      showTranslatedToast("toasts.opener.urlBlocked");
    }
    return opened;
  } catch (error) {
    showTranslatedErrorToast("toasts.opener.urlFailed", error);
    return false;
  }
}
