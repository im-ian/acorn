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
 * Named keybinding defaults used across the app. `$mod` resolves to
 * the platform-appropriate primary modifier (Cmd on macOS, Ctrl elsewhere).
 */
export const DEFAULT_HOTKEYS = {
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
  uiScaleUp: "$mod+=",
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

export type HotkeyId = keyof typeof DEFAULT_HOTKEYS;
export type HotkeyConfig = Record<HotkeyId, string>;

export const HOTKEY_IDS = Object.keys(DEFAULT_HOTKEYS) as HotkeyId[];

const HOTKEY_ALIASES: Partial<Record<HotkeyId, string[]>> = {
  uiScaleDown: ["$mod+Shift+Minus"],
  uiScaleUp: ["$mod+Shift+Equal"],
};

export const Hotkeys = {
  ...DEFAULT_HOTKEYS,
  uiScaleDownShift: "$mod+Shift+Minus",
  uiScaleUpShift: "$mod+Shift+Equal",
} as const;

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

const MODIFIER_ALIASES: Record<string, string> = {
  $mod: "$mod",
  Meta: "Meta",
  Cmd: "$mod",
  Command: "$mod",
  Control: "Control",
  Ctrl: "Control",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
};

const BINDING_MODIFIER_ORDER = ["$mod", "Control", "Alt", "Shift", "Meta"];

const NAMED_KEY_TOKENS = new Set([
  "Enter",
  "Return",
  "Escape",
  "Esc",
  "Backspace",
  "Delete",
  "Tab",
  "Space",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Minus",
  "Equal",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Backquote",
]);

const EVENT_CODE_KEY_TOKENS: Record<string, string> = {
  Enter: "Enter",
  Return: "Return",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Space: "Space",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  Minus: "Minus",
  Equal: "Equal",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Backslash: "Backslash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backquote: "Backquote",
};

const MODIFIER_EVENT_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "OS",
]);

let shortcutRecordingActive = false;

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

function normalizeModifierToken(token: string): string | null {
  return MODIFIER_ALIASES[token] ?? null;
}

function normalizeKeyToken(token: string): string | null {
  if (/^[a-zA-Z]$/.test(token)) return token.toLowerCase();
  if (/^[0-9]$/.test(token)) return token;
  const keyMatch = /^Key([A-Z])$/.exec(token);
  if (keyMatch) return token;
  const digitMatch = /^Digit([0-9])$/.exec(token);
  if (digitMatch) return token;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(token)) return token;
  if (NAMED_KEY_TOKENS.has(token)) {
    if (token === "Esc") return "Escape";
    if (token === "Return") return "Enter";
    return token;
  }
  if (token === " ") return "Space";
  return null;
}

function canonicalizeHotkeyBinding(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const rawParts = trimmed.split("+");
  if (rawParts.length === 0 || rawParts.some((part) => part.trim() === "")) {
    return null;
  }

  const key = normalizeKeyToken(rawParts[rawParts.length - 1].trim());
  if (!key || normalizeModifierToken(key)) return null;

  const modifiers = new Set<string>();
  for (const rawPart of rawParts.slice(0, -1)) {
    const modifier = normalizeModifierToken(rawPart.trim());
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }

  const orderedModifiers = BINDING_MODIFIER_ORDER.filter((modifier) =>
    modifiers.has(modifier),
  );
  return [...orderedModifiers, key].join("+");
}

export function normalizeHotkeyBinding(
  value: unknown,
  fallback: string,
): string {
  return canonicalizeHotkeyBinding(value) ?? fallback;
}

export function resolveHotkeys(
  value?: Partial<Record<HotkeyId, unknown>> | null,
): HotkeyConfig {
  const custom = new Map<HotkeyId, string>();
  const defaultOwnerByBinding = new Map<string, HotkeyId>();

  for (const id of HOTKEY_IDS) {
    defaultOwnerByBinding.set(DEFAULT_HOTKEYS[id], id);
  }

  for (const id of HOTKEY_IDS) {
    const candidate = canonicalizeHotkeyBinding(value?.[id]);
    if (candidate && candidate !== DEFAULT_HOTKEYS[id]) {
      custom.set(id, candidate);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;

    const duplicateBindings = new Set<string>();
    const seenBindings = new Set<string>();
    for (const binding of custom.values()) {
      if (seenBindings.has(binding)) {
        duplicateBindings.add(binding);
      } else {
        seenBindings.add(binding);
      }
    }

    if (duplicateBindings.size > 0) {
      for (const [id, binding] of custom) {
        if (duplicateBindings.has(binding)) {
          custom.delete(id);
          changed = true;
        }
      }
    }

    for (const [id, binding] of custom) {
      const defaultOwner = defaultOwnerByBinding.get(binding);
      if (defaultOwner && defaultOwner !== id && !custom.has(defaultOwner)) {
        custom.delete(id);
        changed = true;
      }
    }
  }

  const resolved = { ...DEFAULT_HOTKEYS } as HotkeyConfig;
  for (const [id, binding] of custom) {
    resolved[id] = binding;
  }

  return resolved;
}

export function hotkeyBindingsFor(
  hotkeys: HotkeyConfig,
  id: HotkeyId,
): string[] {
  const bindings = [hotkeys[id]];
  if (hotkeys[id] === DEFAULT_HOTKEYS[id]) {
    bindings.push(...(HOTKEY_ALIASES[id] ?? []));
  }
  return Array.from(new Set(bindings));
}

function keyTokenFromEvent(event: KeyboardEvent): string | null {
  if (
    event.isComposing ||
    MODIFIER_EVENT_KEYS.has(event.key) ||
    event.key === "Dead"
  ) {
    return null;
  }

  if (/^Key[A-Z]$/.test(event.code)) {
    if (event.altKey || !/^[a-zA-Z]$/.test(event.key)) return event.code;
    return event.key.toLowerCase();
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    if (event.altKey || !/^[0-9]$/.test(event.key)) return event.code;
    return event.key;
  }
  if (EVENT_CODE_KEY_TOKENS[event.code]) {
    return EVENT_CODE_KEY_TOKENS[event.code];
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key;
  if (event.key === " ") return "Space";
  return normalizeKeyToken(event.key);
}

export function recordHotkeyFromEvent(event: KeyboardEvent): string | null {
  const key = keyTokenFromEvent(event);
  if (!key) return null;

  const mac = isMacPlatform();
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push(mac ? "$mod" : "Meta");
  if (event.ctrlKey) modifiers.push(mac ? "Control" : "$mod");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  return canonicalizeHotkeyBinding([...modifiers, key].join("+"));
}

export function setShortcutRecordingActive(active: boolean): void {
  shortcutRecordingActive = active;
}

export function isShortcutRecordingActive(): boolean {
  return shortcutRecordingActive;
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
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
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
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
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
        if (isShortcutRecordingActive()) return;
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

function skipWhileRecording(bindings: HotkeyBindings): HotkeyBindings {
  return Object.fromEntries(
    Object.entries(bindings).map(([binding, handler]) => [
      binding,
      (event: KeyboardEvent) => {
        if (isShortcutRecordingActive()) return;
        handler(event);
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
      unsubscribes.push(tinykeys(window, skipWhileRecording(bubbleBindings)));
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [bindings]);
}
