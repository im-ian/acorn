import { describe, expect, it } from "vitest";

import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  buildXtermTheme,
} from "./terminalTheme";

function emptyReader(): null {
  return null;
}

describe("buildXtermTheme", () => {
  it("falls back to the dark palette when no CSS vars are set", () => {
    const theme = buildXtermTheme({ mode: "dark", readVar: emptyReader });
    expect(theme.background).toBe(DARK_PALETTE.background);
    expect(theme.foreground).toBe(DARK_PALETTE.foreground);
    expect(theme.yellow).toBe(DARK_PALETTE.ansi.yellow);
    expect(theme.brightWhite).toBe(DARK_PALETTE.ansi.brightWhite);
    expect(theme.selectionBackground).toBe(DARK_PALETTE.selectionBackground);
  });

  it("falls back to the light palette when no CSS vars are set", () => {
    const theme = buildXtermTheme({ mode: "light", readVar: emptyReader });
    expect(theme.background).toBe(LIGHT_PALETTE.background);
    expect(theme.foreground).toBe(LIGHT_PALETTE.foreground);
    expect(theme.yellow).toBe(LIGHT_PALETTE.ansi.yellow);
    expect(theme.brightWhite).toBe(LIGHT_PALETTE.ansi.brightWhite);
    expect(theme.selectionBackground).toBe(LIGHT_PALETTE.selectionBackground);
  });

  it("keeps dark and light defaults visually distinct on a white background", () => {
    // brightWhite on white background = invisible. Light palette must avoid that.
    expect(LIGHT_PALETTE.ansi.brightWhite.toLowerCase()).not.toBe("#ffffff");
    // Yellow in light mode needs to be readable on white, not the pastel
    // dark-mode tone.
    expect(LIGHT_PALETTE.ansi.yellow).not.toBe(DARK_PALETTE.ansi.yellow);
  });

  it("reads --color-terminal-bg/-fg overrides", () => {
    const overrides: Record<string, string> = {
      "--color-terminal-bg": "#101010",
      "--color-terminal-fg": "#fafafa",
    };
    const theme = buildXtermTheme({
      mode: "dark",
      readVar: (name) => overrides[name] ?? null,
    });
    expect(theme.background).toBe("#101010");
    expect(theme.foreground).toBe("#fafafa");
    expect(theme.cursor).toBe("#fafafa");
    expect(theme.cursorAccent).toBe("#101010");
  });

  it("lets a theme override individual ANSI slots while inheriting the rest", () => {
    const overrides: Record<string, string> = {
      "--color-term-yellow": "#b58900",
      "--color-term-bright-white": "#000000",
    };
    const theme = buildXtermTheme({
      mode: "light",
      readVar: (name) => overrides[name] ?? null,
    });
    expect(theme.yellow).toBe("#b58900");
    expect(theme.brightWhite).toBe("#000000");
    // Untouched slots fall back to the light palette default.
    expect(theme.red).toBe(LIGHT_PALETTE.ansi.red);
    expect(theme.blue).toBe(LIGHT_PALETTE.ansi.blue);
  });

  it("trims whitespace from CSS variable values", () => {
    const theme = buildXtermTheme({
      mode: "dark",
      readVar: (name) => (name === "--color-terminal-bg" ? "  #222  " : null),
    });
    expect(theme.background).toBe("#222");
  });

  it("treats empty string CSS vars as unset", () => {
    const theme = buildXtermTheme({
      mode: "light",
      readVar: (name) => (name === "--color-terminal-bg" ? "   " : null),
    });
    expect(theme.background).toBe(LIGHT_PALETTE.background);
  });

  it("forces a transparent xterm background when requested", () => {
    const theme = buildXtermTheme({
      mode: "dark",
      readVar: emptyReader,
      useTransparentBackground: true,
    });
    expect(theme.background).toBe("rgba(0, 0, 0, 0)");
    // Cursor accent still uses the real background so the cursor remains visible.
    expect(theme.cursorAccent).toBe(DARK_PALETTE.background);
  });

  it("overrides selection and scrollbar slots via CSS vars", () => {
    const overrides: Record<string, string> = {
      "--color-term-selection": "#abcdef",
      "--color-term-scrollbar": "rgba(10, 10, 10, 0.2)",
      "--color-term-scrollbar-hover": "rgba(10, 10, 10, 0.4)",
      "--color-term-scrollbar-active": "rgba(10, 10, 10, 0.6)",
    };
    const theme = buildXtermTheme({
      mode: "light",
      readVar: (name) => overrides[name] ?? null,
    });
    expect(theme.selectionBackground).toBe("#abcdef");
    expect(theme.scrollbarSliderBackground).toBe("rgba(10, 10, 10, 0.2)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(10, 10, 10, 0.4)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(10, 10, 10, 0.6)");
  });
});
