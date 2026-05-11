import { useEffect } from "react";

interface DialogShortcutOptions {
  onCancel?: () => void;
  onConfirm?: () => void;
}

/**
 * Wires Escape (cancel) and Enter (confirm) shortcuts for a modal dialog.
 *
 * The handlers are attached in the capture phase and call
 * `stopImmediatePropagation` so they preempt window-level shortcut bindings
 * (e.g. the pane-collapse Escape binding) while a dialog is open.
 *
 * Enter is suppressed while focus is inside a text input, textarea, select,
 * or contenteditable element so existing form interactions (cmdk palette,
 * inline rename, etc.) keep working.
 */
export function useDialogShortcuts(
  open: boolean,
  { onCancel, onConfirm }: DialogShortcutOptions,
): void {
  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      // A higher overlay (e.g. ImageLightbox) is on top — let it own the
      // keyboard shortcuts until it dismisses.
      if (document.body.dataset.acornImagePreviewOpen === "1") return;

      if (e.key === "Escape") {
        if (!onCancel) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        if (!onConfirm) return;
        if (isTextEditingTarget(e.target)) return;
        if (e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onConfirm();
      }
    }

    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open, onCancel, onConfirm]);
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}
