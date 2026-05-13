import type { ITheme } from "@xterm/xterm";

import type { ThemeMode } from "./themes";

export type AnsiName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export interface TerminalPalette {
  background: string;
  foreground: string;
  selectionBackground: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
  ansi: Record<AnsiName, string>;
}

// Default xterm ANSI palette for dark themes. Mirrors the One Dark family the
// stock Acorn Dark theme is tuned for, so a stream of ANSI-coloured output
// from claude/codex/shells stays readable on the default background.
export const DARK_PALETTE: TerminalPalette = {
  background: "#1f2326",
  foreground: "#ededed",
  selectionBackground: "#3a3f44",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.08)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.16)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.24)",
  ansi: {
    black: "#1f2326",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#ededed",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
};

// Default xterm ANSI palette for light themes. The dark palette's pastel
// yellow / pale-green / `brightWhite: #ffffff` become invisible on a white
// terminal background, so light mode gets a higher-contrast set tuned for
// near-white surfaces. Individual themes can still override any colour via
// the `--color-term-*` CSS variables read in buildXtermTheme.
export const LIGHT_PALETTE: TerminalPalette = {
  background: "#ffffff",
  foreground: "#1a1d20",
  selectionBackground: "#bcd6f7",
  scrollbarSliderBackground: "rgba(0, 0, 0, 0.10)",
  scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.18)",
  scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.26)",
  ansi: {
    black: "#1a1d20",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0550ae",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

const ANSI_NAMES: ReadonlyArray<AnsiName> = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

// Map from ANSI slot to the CSS variable a theme can use to override it. The
// kebab-case names line up with the existing `--color-*` convention so theme
// authors can override only the slots they care about and inherit the rest
// from the mode default.
const ANSI_CSS_VARS: Record<AnsiName, string> = {
  black: "--color-term-black",
  red: "--color-term-red",
  green: "--color-term-green",
  yellow: "--color-term-yellow",
  blue: "--color-term-blue",
  magenta: "--color-term-magenta",
  cyan: "--color-term-cyan",
  white: "--color-term-white",
  brightBlack: "--color-term-bright-black",
  brightRed: "--color-term-bright-red",
  brightGreen: "--color-term-bright-green",
  brightYellow: "--color-term-bright-yellow",
  brightBlue: "--color-term-bright-blue",
  brightMagenta: "--color-term-bright-magenta",
  brightCyan: "--color-term-bright-cyan",
  brightWhite: "--color-term-bright-white",
};

const SELECTION_VAR = "--color-term-selection";
const SCROLLBAR_VAR = "--color-term-scrollbar";
const SCROLLBAR_HOVER_VAR = "--color-term-scrollbar-hover";
const SCROLLBAR_ACTIVE_VAR = "--color-term-scrollbar-active";
const BG_VAR = "--color-terminal-bg";
const FG_VAR = "--color-terminal-fg";

export function defaultPaletteFor(mode: ThemeMode): TerminalPalette {
  return mode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

export interface BuildXtermThemeOptions {
  mode: ThemeMode;
  /** Reads a CSS custom property by name; returns null/empty for unset. */
  readVar: (name: string) => string | null | undefined;
  /** When true, force the xterm background to fully transparent so an underlying image shows through. */
  useTransparentBackground?: boolean;
}

export function buildXtermTheme({
  mode,
  readVar,
  useTransparentBackground = false,
}: BuildXtermThemeOptions): ITheme {
  const palette = defaultPaletteFor(mode);
  const pick = (varName: string, fallback: string): string => {
    const value = readVar(varName);
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  };

  const background = pick(BG_VAR, palette.background);
  const foreground = pick(FG_VAR, palette.foreground);

  const ansi = {} as Record<AnsiName, string>;
  for (const name of ANSI_NAMES) {
    ansi[name] = pick(ANSI_CSS_VARS[name], palette.ansi[name]);
  }

  return {
    background: useTransparentBackground ? "rgba(0, 0, 0, 0)" : background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: pick(SELECTION_VAR, palette.selectionBackground),
    scrollbarSliderBackground: pick(
      SCROLLBAR_VAR,
      palette.scrollbarSliderBackground,
    ),
    scrollbarSliderHoverBackground: pick(
      SCROLLBAR_HOVER_VAR,
      palette.scrollbarSliderHoverBackground,
    ),
    scrollbarSliderActiveBackground: pick(
      SCROLLBAR_ACTIVE_VAR,
      palette.scrollbarSliderActiveBackground,
    ),
    ...ansi,
  };
}
