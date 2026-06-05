interface TerminalKeyEventLike {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  keyCode?: number;
}

export type TerminalShortcutAction =
  | { kind: "write"; data: string }
  | { kind: "scrollToLiveTail" };

const SPACE_KEY_VALUES = new Set([" ", "Spacebar", "\u00a0"]);
const SPACE_INPUT_VALUES = new Set([" ", "\u00a0"]);
const IME_TERMINATOR_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", " ", "Spacebar",
]);
const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "CapsLock",
]);

// Hangul jamo, Hangul syllables, Hiragana, Katakana, CJK ideographs.
const CJK_DATA_RE =
  /[ᄀ-ᇿ㄰-㆏가-힯぀-ゟ゠-ヿ一-鿿]/;

export function isPlainSpaceKeydown(event: TerminalKeyEventLike): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.code === "Space" || SPACE_KEY_VALUES.has(event.key);
}

export function isPlainSpaceText(text: string): boolean {
  return SPACE_INPUT_VALUES.has(text);
}

export function isImeTextData(text: string | null | undefined): boolean {
  return !!text && CJK_DATA_RE.test(text);
}

export function isImeTerminatorKeydown(event: TerminalKeyEventLike): boolean {
  return (
    event.keyCode === 229 &&
    (IME_TERMINATOR_KEYS.has(event.key) || isPlainSpaceKeydown(event))
  );
}

export function isModifierOnlyKeydown(event: TerminalKeyEventLike): boolean {
  return MODIFIER_KEYS.has(event.key);
}

export function getTerminalShortcutAction(
  event: TerminalKeyEventLike,
): TerminalShortcutAction | null {
  if (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    return { kind: "write", data: "\n" };
  }

  if (
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    if (event.key === "ArrowLeft") return { kind: "write", data: "\x01" };
    if (event.key === "ArrowRight") return { kind: "write", data: "\x05" };
    if (event.key === "ArrowDown") return { kind: "scrollToLiveTail" };
  }

  return null;
}
