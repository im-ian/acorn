import { createTranslator, type TranslationKey } from "./i18n";
import { useSettings } from "./settings";
import { useToasts } from "./toasts";
import { useAppStore } from "../store";

export function currentText(
  key: TranslationKey,
  values?: Record<string, string | number>,
): string {
  const t = createTranslator(useSettings.getState().settings.language);
  const template = t(key);
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

export function showTranslatedToast(
  key: TranslationKey,
  values?: Record<string, string | number>,
): void {
  useToasts.getState().show(currentText(key, values));
}

export function showTranslatedErrorToast(
  key: TranslationKey,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  useToasts.getState().show(`${currentText(key)} ${message}`);
}

export function showStoreResultToast(
  successKey: TranslationKey | null,
  failureKey: TranslationKey,
): void {
  const error = useAppStore.getState().consumeError();
  if (error) {
    showTranslatedErrorToast(failureKey, error);
    return;
  }
  if (successKey) {
    showTranslatedToast(successKey);
  }
}
