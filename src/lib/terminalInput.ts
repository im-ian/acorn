interface TerminalKeyEventLike {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

const SPACE_KEY_VALUES = new Set([" ", "Spacebar", "\u00a0"]);

export function isPlainSpaceKeydown(event: TerminalKeyEventLike): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.code === "Space" || SPACE_KEY_VALUES.has(event.key);
}
