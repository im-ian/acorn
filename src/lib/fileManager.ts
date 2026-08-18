import { api } from "./api";
import type { Translator } from "./i18n";
import { showTranslatedErrorToast } from "./operationToasts";

export function revealInFileManagerText(
  t: Translator,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return platform.startsWith("Mac")
    ? t("ui.revealInFinder")
    : t("ui.revealInFileManager");
}

/** Reveal a user-selected path and keep launcher/access failures visible. */
export async function revealPathWithFeedback(path: string): Promise<boolean> {
  try {
    await api.fsReveal(path);
    return true;
  } catch (error) {
    showTranslatedErrorToast("toasts.files.revealFailed", error);
    return false;
  }
}
