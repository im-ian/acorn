import { createTranslator, type TranslationKey } from "./i18n";
import { useSettings } from "./settings";
import { TOAST_TTL_MS, useToasts } from "./toasts";
import { useAppStore } from "../store";
import { api, type SessionRemoval, type WorktreeRemoval } from "./api";

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

function sessionRemovalToastValues(
  removals: SessionRemoval[],
  remainingSeconds: number,
): Record<string, string | number> {
  return {
    count: removals.length,
    seconds: remainingSeconds,
  };
}

async function discardWithRetry<T>(
  items: readonly T[],
  discard: (item: T) => Promise<void>,
  failureKey: TranslationKey,
): Promise<void> {
  const failures = (
    await Promise.all(
      items.map(async (item) => {
        try {
          await discard(item);
          return null;
        } catch (reason) {
          return { item, reason };
        }
      }),
    )
  ).filter(
    (failure): failure is { item: T; reason: unknown } => failure !== null,
  );
  if (failures.length === 0) return;

  const error = failures
    .map(({ reason }) =>
      reason instanceof Error ? reason.message : String(reason),
    )
    .join("; ");
  useToasts.getState().show(currentText(failureKey, { error }), {
    action: () =>
      discardWithRetry(
        failures.map(({ item }) => item),
        discard,
        failureKey,
      ),
  });
}

export function discardRemovedWorktreesWithRetry(
  removals: WorktreeRemoval | readonly WorktreeRemoval[] | null | undefined,
): Promise<void> {
  const list = Array.isArray(removals)
    ? removals.filter(Boolean)
    : removals
      ? [removals]
      : [];
  return discardWithRetry(
    list,
    (removal) => api.discardRemovedWorktree(removal),
    "toasts.session.worktreeDiscardFailedRetry",
  );
}

export function discardRemovedSessionsWithRetry(
  removals: SessionRemoval | readonly SessionRemoval[] | null | undefined,
): Promise<void> {
  const list = Array.isArray(removals)
    ? removals.filter(Boolean)
    : removals
      ? [removals]
      : [];
  return discardWithRetry(
    list,
    (removal) => api.discardRemovedSession(removal),
    "toasts.session.sessionWorktreeDiscardFailedRetry",
  );
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
        await discardRemovedWorktreesWithRetry(list);
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

export function showSessionRemovalToast(
  removals: SessionRemoval | SessionRemoval[] | null | undefined,
  successKey: TranslationKey,
  undoKey: TranslationKey,
  restoredKey: TranslationKey,
  restoreFailedKey: TranslationKey,
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
      sessionRemovalToastValues(list, initialSeconds),
    ),
    {
      formatMessage: (remainingSeconds) =>
        currentText(
          undoKey,
          sessionRemovalToastValues(list, remainingSeconds),
        ),
      action: async () => {
        try {
          await Promise.all(
            list.map((removal) => api.restoreRemovedSession(removal)),
          );
          await useAppStore.getState().refreshAll();
          const restoredSessionId = list[0]?.sessionIds[0];
          if (restoredSessionId) {
            useAppStore.getState().selectSession(restoredSessionId);
          }
          showTranslatedToast(restoredKey);
        } catch (error) {
          showTranslatedErrorToast(restoreFailedKey, error);
        }
      },
      onDismiss: async () => {
        await discardRemovedSessionsWithRetry(list);
      },
    },
  );
}

export function showStoreSessionRemovalToast(
  removals: SessionRemoval | SessionRemoval[] | null | undefined,
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
  showSessionRemovalToast(
    removals,
    successKey,
    undoKey,
    restoredKey,
    restoreFailedKey,
  );
}
