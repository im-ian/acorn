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
interface TinykeysOptions {
  capture?: boolean;
  timeout?: number;
}

type Tinykeys = (
  target: Window | HTMLElement,
  keyBindingMap: KeyBindingMap,
  options?: TinykeysOptions,
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
  // tinykeys matches `event.key` OR `event.code`. On macOS, Option as
  // modifier rewrites `event.key` to a dead-key glyph (Option+T → "†"),
  // so the literal-letter form never fires. The `KeyT` form falls back
  // to `event.code`, which Option does not perturb.
  newIsolatedSession: "$mod+Alt+KeyT",
  // "Control session" — extends the new-session family. Future PRs add the
  // `acorn-ipc` CLI so this kind of session can drive sibling sessions; the
  // hotkey lives next to the other terminal-creation bindings for symmetry.
  newControlSession: "$mod+Alt+Shift+KeyT",
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
  toggleFiles: "$mod+Shift+e",
  uiScaleDown: "$mod+-",
  uiScaleDownShift: "$mod+Shift+Minus",
  uiScaleUp: "$mod+=",
  uiScaleUpShift: "$mod+Shift+Equal",
  uiScaleReset: "$mod+0",
  previousConversation: "$mod+ArrowLeft",
  nextConversation: "$mod+ArrowRight",
  toggleMultiInput: "$mod+Alt+KeyI",
  focusPaneLeft: "$mod+Alt+ArrowLeft",
  focusPaneRight: "$mod+Alt+ArrowRight",
  focusPaneUp: "$mod+Alt+ArrowUp",
  focusPaneDown: "$mod+Alt+ArrowDown",
  splitVertical: "$mod+d",
  splitHorizontal: "$mod+Shift+d",
  equalizePanes: "$mod+Alt+KeyE",
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

const MODIFIER_TOKENS = new Set([
  "$mod",
  "Meta",
  "Cmd",
  "Command",
  "Control",
  "Ctrl",
  "Alt",
  "Option",
  "Shift",
]);

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

function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iP(hone|od|ad)/.test(navigator.platform)
  );
}

const MAC_KEY_SYMBOL: Record<string, string> = {
  $mod: "⌘",
  Meta: "⌘",
  Cmd: "⌘",
  Command: "⌘",
  Control: "⌃",
  Ctrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Enter: "↵",
  Return: "↵",
  Escape: "⎋",
  Esc: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Space: "␣",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
};

const NON_MAC_KEY_LABEL: Record<string, string> = {
  $mod: "Ctrl",
  Meta: "Meta",
  Cmd: "Ctrl",
  Command: "Ctrl",
  Control: "Ctrl",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
  Enter: "Enter",
  Return: "Enter",
  Escape: "Esc",
  Esc: "Esc",
  Backspace: "Backspace",
  Delete: "Del",
  Tab: "Tab",
  Space: "Space",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

// Modifier order matches Apple HIG / Windows convention so the rendered
// string reads naturally even when the tinykeys source list differs.
const MAC_MODIFIER_ORDER = ["⌃", "⌥", "⇧", "⌘"];
const NON_MAC_MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

// `KeyboardEvent.code` tokens (`KeyT`, `Digit3`, …) are used in binding
// strings to bypass macOS Option dead-keys. Strip the prefix for display
// so users see the natural letter/digit, not the raw code name.
function stripCodePrefix(part: string): string {
  const keyMatch = /^Key([A-Z])$/.exec(part);
  if (keyMatch) return keyMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(part);
  if (digitMatch) return digitMatch[1];
  return part;
}

function formatKey(part: string, mac: boolean): string {
  const normalized = stripCodePrefix(part);
  if (mac) {
    return MAC_KEY_SYMBOL[normalized] ?? normalized.toUpperCase();
  }
  return NON_MAC_KEY_LABEL[normalized] ?? normalized.toUpperCase();
}

function bindingUsesModifier(binding: string): boolean {
  return binding
    .trim()
    .split(/\s+/)
    .some((chord) => {
      const parts = chord.split(/\b\+/);
      const modifiers = parts.slice(0, -1);
      return modifiers.some((part) => MODIFIER_TOKENS.has(part));
    });
}

function stopPropagationAfterHandling(
  bindings: HotkeyBindings,
): HotkeyBindings {
  return Object.fromEntries(
    Object.entries(bindings).map(([binding, handler]) => [
      binding,
      (event: KeyboardEvent) => {
        handler(event);
        // App-level shortcuts that handled the key must own it before focused
        // surfaces like xterm also interpret the same chord.
        if (event.defaultPrevented) {
          event.stopImmediatePropagation();
        }
      },
    ]),
  );
}

/**
 * Render a tinykeys binding string (e.g. `$mod+Shift+t`) as a
 * platform-appropriate label suitable for context-menu shortcut hints.
 */
export function formatHotkey(binding: string): string {
  const mac = isMacPlatform();
  const parts = binding.split("+").map((p) => formatKey(p, mac));
  const order = mac ? MAC_MODIFIER_ORDER : NON_MAC_MODIFIER_ORDER;
  const modifiers: string[] = [];
  const rest: string[] = [];
  for (const p of parts) {
    if (order.includes(p)) modifiers.push(p);
    else rest.push(p);
  }
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (mac) return [...modifiers, ...rest].join("");
  return [...modifiers, ...rest].join("+");
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

    const captureBindings: HotkeyBindings = {};
    const bubbleBindings: HotkeyBindings = {};
    for (const [binding, handler] of Object.entries(bindings)) {
      if (bindingUsesModifier(binding)) {
        captureBindings[binding] = handler;
      } else {
        bubbleBindings[binding] = handler;
      }
    }

    const unsubscribes: Array<() => void> = [];
    if (Object.keys(captureBindings).length > 0) {
      unsubscribes.push(
        tinykeys(window, stopPropagationAfterHandling(captureBindings), {
          capture: true,
        }),
      );
    }
    if (Object.keys(bubbleBindings).length > 0) {
      unsubscribes.push(tinykeys(window, bubbleBindings));
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [bindings]);
}
