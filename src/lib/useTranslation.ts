import { useMemo } from "react";
import { createTranslator } from "./i18n";
import { useSettings } from "./settings";

export function useTranslation() {
  const language = useSettings((s) => s.settings.language);
  return useMemo(() => createTranslator(language), [language]);
}
