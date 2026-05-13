import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_THEMES,
  applyTheme,
  validateThemeCss,
  THEME_CSS_VARS,
} from "./themes";

afterEach(() => {
  document.getElementById("acorn-theme")?.remove();
  document.documentElement.removeAttribute("data-acorn-theme");
});

describe("BUILT_IN_THEMES", () => {
  it("ships an expanded set of built-in themes", () => {
    expect(BUILT_IN_THEMES.map((theme) => theme.id)).toEqual([
      "acorn-dark",
      "one-dark-pro",
      "tokyo-night",
      "dracula",
      "catppuccin-mocha",
      "gruvbox-dark",
      "nord",
      "rose-pine",
      "ayu-dark",
      "acorn-light",
      "github-light",
      "solarized-light",
      "catppuccin-latte",
      "one-light",
      "gruvbox-light",
    ]);
    expect(BUILT_IN_THEMES).toHaveLength(15);
    expect(BUILT_IN_THEMES.filter((theme) => theme.mode === "dark")).toHaveLength(9);
    expect(
      BUILT_IN_THEMES.filter((theme) => theme.mode === "light"),
    ).toHaveLength(6);
  });

  it("every built-in css passes validation", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(validateThemeCss(theme.css)).toEqual({ ok: true });
    }
  });
});

describe("validateThemeCss", () => {
  it("accepts css that declares every required variable", () => {
    const css = `:root[data-acorn-theme="x"] {\n${THEME_CSS_VARS.map(
      (variable) => `  ${variable}: #fff;`,
    ).join("\n")}\n}`;

    expect(validateThemeCss(css)).toEqual({ ok: true });
  });

  it("rejects css missing one or more required variables", () => {
    const result = validateThemeCss(
      `:root[data-acorn-theme="x"] {\n  --color-bg: #fff;\n}`,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("--color-fg");
    }
  });
});

describe("applyTheme", () => {
  it("injects a <style id='acorn-theme'> and sets the html attribute", () => {
    applyTheme("acorn-dark", BUILT_IN_THEMES[0].css);

    const styleEl = document.getElementById("acorn-theme");
    expect(styleEl?.tagName).toBe("STYLE");
    expect(styleEl?.textContent).toContain("--color-bg");
    expect(document.documentElement.getAttribute("data-acorn-theme")).toBe(
      "acorn-dark",
    );
  });

  it("replaces the previous theme on a second call", () => {
    applyTheme("acorn-dark", BUILT_IN_THEMES[0].css);
    applyTheme("acorn-light", BUILT_IN_THEMES[3].css);

    expect(document.querySelectorAll("style#acorn-theme")).toHaveLength(1);
    expect(document.documentElement.getAttribute("data-acorn-theme")).toBe(
      "acorn-light",
    );
  });
});
