import { createTranslator, type TranslationKey } from "./i18n";
import { useSettings } from "./settings";
import { TOAST_TTL_MS, useToasts } from "./toasts";
import { useAppStore } from "../store";
import { api, type WorktreeRemoval } from "./api";

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

function worktreeName(removal: WorktreeRemoval): string {
  const trimmed = removal.worktreePath.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || "worktree";
}

function worktreeRemovalToastValues(
  removals: WorktreeRemoval[],
  remainingSeconds: number,
): Record<string, string | number> {
  return {
    count: removals.length,
    name: removals.length === 1 ? worktreeName(removals[0]) : removals.length,
    seconds: remainingSeconds,
  };
}

export function showWorktreeRemovalToast(
  removals: WorktreeRemoval | WorktreeRemoval[] | null | undefined,
  successKey: TranslationKey,
  undoKey: TranslationKey,
  restoredKey: TranslationKey,
  restoreFailedKey: TranslationKey,
  options?: { onRestored?: () => void },
): void {
  const list = (Array.isArray(removals) ? removals : removals ? [removals] : [])
    .filter(Boolean);
  if (list.length === 0) {
    showTranslatedToast(successKey);
    return;
  }

  const initialSeconds = Math.ceil(TOAST_TTL_MS / 1000);
  useToasts.getState().show(
    currentText(
      undoKey,
      worktreeRemovalToastValues(list, initialSeconds),
    ),
    {
      formatMessage: (remainingSeconds) =>
        currentText(
          undoKey,
          worktreeRemovalToastValues(list, remainingSeconds),
        ),
      action: async () => {
        try {
          await Promise.all(
            list.map((removal) => api.restoreRemovedWorktree(removal)),
          );
          options?.onRestored?.();
          showTranslatedToast(restoredKey);
        } catch (error) {
          showTranslatedErrorToast(restoreFailedKey, error);
        }
      },
      onDismiss: async () => {
        await Promise.allSettled(
          list.map((removal) => api.discardRemovedWorktree(removal)),
        );
      },
    },
  );
}

export function showStoreWorktreeRemovalToast(
  removals: WorktreeRemoval | WorktreeRemoval[] | null | undefined,
  successKey: TranslationKey,
  undoKey: TranslationKey,
  failureKey: TranslationKey,
  restoredKey: TranslationKey,
  restoreFailedKey: TranslationKey,
): void {
  const error = useAppStore.getState().consumeError();
  if (error) {
    showTranslatedErrorToast(failureKey, error);
    return;
  }
  showWorktreeRemovalToast(
    removals,
    successKey,
    undoKey,
    restoredKey,
    restoreFailedKey,
  );
}
