export const CURATED_MONOSPACE_FONTS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "IBM Plex Mono",
  "Source Code Pro",
  "Hack",
] as const;

export type CuratedMonospaceFont = (typeof CURATED_MONOSPACE_FONTS)[number];

export type FontSlots = [string | null, string | null, string | null];

const GENERIC_FALLBACKS = new Set([
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
]);

function needsQuoting(name: string): boolean {
  return /\s/.test(name);
}

export function fontStackFromSlots(
  slots: Array<string | null | undefined>,
  fallback: string,
): string {
  const cleaned = slots
    .filter((slot): slot is string => !!slot && slot.trim().length > 0)
    .map((slot) => slot.trim());

  const parts = cleaned.map((name) =>
    needsQuoting(name) ? `"${name}"` : name,
  );
  parts.push(fallback);

  return parts.join(", ");
}

export function fontSlotsFromStack(stack: string): string[] {
  return stack
    .split(",")
    .map((token) => token.trim().replace(/^"(.*)"$/, "$1"))
    .filter((name) => name.length > 0 && !GENERIC_FALLBACKS.has(name))
    .slice(0, 3);
}
