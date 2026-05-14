import { useEffect } from "react";
// tinykeys@3 ships type declarations at `dist/tinykeys.d.ts` but its
// `package.json#exports` field omits a `types` condition, so TS's
// bundler resolver cannot pick them up. We work around this by
// importing the runtime module untyped and re-declaring the minimal
// surface we use locally.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- see note above
import { tinykeys as tinykeysRaw } from "tinykeys";

type KeyBindingMap = Record<string, (event: KeyboardEvent) => void>;
type Tinykeys = (
  target: Window | HTMLElement,
  keyBindingMap: KeyBindingMap,
) => () => void;

const tinykeys = tinykeysRaw as Tinykeys;

/**
 * Named keybinding constants used across the app. `$mod` resolves to
 * the platform-appropriate primary modifier (Cmd on macOS, Ctrl elsewhere).
 */
export const Hotkeys = {
  openPalette: "$mod+p",
  clearTerminal: "$mod+k",
  newSession: "$mod+t",
  newIsolatedSession: "$mod+Alt+t",
  // "Control session" — extends the new-session family. Future PRs add the
  // `acorn-ipc` CLI so this kind of session can drive sibling sessions; the
  // hotkey lives next to the other terminal-creation bindings for symmetry.
  newControlSession: "$mod+Alt+Shift+t",
  addProject: "$mod+Shift+n",
  focusSidebar: "$mod+1",
  focusMain: "$mod+2",
  focusRight: "$mod+3",
  toggleSidebar: "$mod+b",
  toggleRightPanel: "$mod+j",
  toggleTodos: "$mod+Shift+t",
  toggleCommits: "$mod+Shift+c",
  toggleStaged: "$mod+Shift+s",
  togglePrs: "$mod+Shift+p",
  uiScaleDown: "$mod+-",
  uiScaleDownShift: "$mod+Shift+Minus",
  uiScaleUp: "$mod+=",
  uiScaleUpShift: "$mod+Shift+Equal",
  uiScaleReset: "$mod+0",
  toggleMultiInput: "$mod+Alt+i",
  focusPaneLeft: "$mod+Alt+ArrowLeft",
  focusPaneRight: "$mod+Alt+ArrowRight",
  focusPaneUp: "$mod+Alt+ArrowUp",
  focusPaneDown: "$mod+Alt+ArrowDown",
  splitVertical: "$mod+d",
  splitHorizontal: "$mod+Shift+d",
  equalizePanes: "$mod+Alt+e",
  closeTab: "$mod+w",
  closeEmptyPane: "Escape",
  openSettings: "$mod+Comma",
  // Mirrors Ghostty's "Reload Config" gesture. Dotfile env values
  // (LANG, EDITOR, PAGER, …) are captured once on first PTY spawn and
  // cached; this shortcut invalidates the cache so the next session
  // picks up edits the user has made since.
  reloadShellEnv: "$mod+Shift+Comma",
  // Tab / project navigation. Use literal Control (not $mod) — Cmd+Tab is
  // reserved by macOS for OS-level app switching.
  nextTab: "Control+Tab",
  prevTab: "Control+Shift+Tab",
  nextProject: "Control+Alt+Tab",
  prevProject: "Control+Alt+Shift+Tab",
} as const;

export type HotkeyId = keyof typeof Hotkeys;

export type HotkeyHandler = (event: KeyboardEvent) => void;

export type HotkeyBindings = Record<string, HotkeyHandler>;

type TauriRuntimeWindow = Window & { __TAURI_INTERNALS__?: unknown };

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as TauriRuntimeWindow)
  );
}

export function shouldUseTinykeysToggleMultiInputFallback(): boolean {
  return !isTauriRuntime();
}

/**
 * Subscribes the given keybinding map to `window` for the lifetime of the
 * component. Bindings are re-attached whenever the map identity changes,
 * so callers should memoize their bindings (or rely on stable references)
 * to avoid unnecessary re-subscription.
 */
export function useHotkeys(bindings: HotkeyBindings): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const unsubscribe = tinykeys(window, bindings);
    return () => {
      unsubscribe();
    };
  }, [bindings]);
}
