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
export type FontOptionScope = "mono" | "all";

const GENERIC_FALLBACKS = new Set([
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
]);

const FONT_STYLE_SUFFIXES = new Set([
  "black",
  "bold",
  "book",
  "condensed",
  "demi",
  "demibold",
  "expanded",
  "extra",
  "extrabold",
  "extralight",
  "heavy",
  "italic",
  "light",
  "medium",
  "oblique",
  "regular",
  "roman",
  "semi",
  "semibold",
  "thin",
  "ultra",
  "ultrabold",
  "ultralight",
]);

const MONO_FAMILY_HINTS = [
  "mono",
  "code",
  "console",
  "consolas",
  "courier",
  "fixed",
  "hack",
  "inconsolata",
  "iosevka",
  "menlo",
  "monaco",
  "terminal",
];

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

function isStyleSuffix(word: string): boolean {
  const normalized = word.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  if (FONT_STYLE_SUFFIXES.has(normalized)) return true;
  return /^(extra|semi|demi|ultra)?(bold|light)(italic|oblique)?$/.test(
    normalized,
  );
}

function stripStyleSuffixes(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  while (words.length > 1 && isStyleSuffix(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

function normalizeFontFamilyOption(value: unknown): string | null {
  const sanitized = sanitizeFontFamilyName(value);
  if (!sanitized) return null;
  return stripStyleSuffixes(sanitized.replace(/[-_]+/g, " "));
}

function isLikelyMonospaceFamily(name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return MONO_FAMILY_HINTS.some((hint) => lower.includes(hint));
}

export function fontFamilyOptions(
  fonts: ReadonlyArray<string>,
  scope: FontOptionScope,
): string[] {
  const normalized = fonts
    .map(normalizeFontFamilyOption)
    .filter((font): font is string => !!font);
  const filtered =
    scope === "mono" ? normalized.filter(isLikelyMonospaceFamily) : normalized;
  return Array.from(new Set(filtered)).sort((a, b) => a.localeCompare(b));
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
