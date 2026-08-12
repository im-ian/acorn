import type { Translator } from "./i18n";

export function revealInFileManagerText(
  t: Translator,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return platform.startsWith("Mac")
    ? t("ui.revealInFinder")
    : t("ui.revealInFileManager");
}
