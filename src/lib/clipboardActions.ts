import { writeClipboardText } from "./clipboardText";
import { showTranslatedErrorToast } from "./operationToasts";

/**
 * Copy user-requested text and surface native/browser clipboard failures.
 *
 * Callers with operation-specific error UI should keep using
 * `writeClipboardText` directly. This helper is for fire-and-forget copy
 * actions that would otherwise turn a permission denial into an unhandled or
 * console-only rejection.
 */
export async function copyTextWithFeedback(text: string): Promise<boolean> {
  try {
    await writeClipboardText(text);
    return true;
  } catch (error) {
    showTranslatedErrorToast("toasts.clipboard.writeFailed", error);
    return false;
  }
}
