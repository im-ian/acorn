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
  return /[\s"'\\]/.test(name);
}

function quoteFontName(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function sanitizeFontFamilyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .replace(/^["'](.+)["']$/, "$1")
    .trim();

  if (!trimmed || trimmed.length > 80) return null;
  if (/[,;\n\r\t]/.test(trimmed)) return null;
  if (GENERIC_FALLBACKS.has(trimmed)) return null;

  return trimmed;
}

export function fontStackFromSlots(
  slots: Array<string | null | undefined>,
  fallback: string,
): string {
  const cleaned = slots
    .map(sanitizeFontFamilyName)
    .filter((slot): slot is string => slot !== null);

  const parts = cleaned.map((name) =>
    needsQuoting(name) ? quoteFontName(name) : name,
  );
  parts.push(fallback);

  return parts.join(", ");
}

export function fontSlotsFromStack(stack: string): string[] {
  return stack
    .split(",")
    .map(sanitizeFontFamilyName)
    .filter((name): name is string => name !== null)
    .slice(0, 3);
}
