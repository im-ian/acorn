import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_THEMES,
  applyTheme,
  resolveThemeMode,
  validateThemeCss,
  THEME_CSS_VARS,
} from "./themes";

afterEach(() => {
  document.getElementById("acorn-theme")?.remove();
  document.documentElement.removeAttribute("data-acorn-theme");
});

describe("BUILT_IN_THEMES", () => {
  it("bundles only the four core Acorn themes", () => {
    expect(BUILT_IN_THEMES.map((theme) => theme.id)).toEqual([
      "acorn-dark",
      "acorn-pink",
      "acorn-light",
      "acorn-light-pink",
    ]);
    expect(BUILT_IN_THEMES).toHaveLength(4);
    expect(
      BUILT_IN_THEMES.filter((theme) => theme.mode === "dark"),
    ).toHaveLength(2);
    expect(
      BUILT_IN_THEMES.filter((theme) => theme.mode === "light"),
    ).toHaveLength(2);
  });

  it("keeps Acorn built-in theme ids and labels stable", () => {
    expect(
      BUILT_IN_THEMES.map((theme) => ({
        id: theme.id,
        label: theme.label,
      })),
    ).toEqual([
      { id: "acorn-dark", label: "Acorn Dark Green" },
      { id: "acorn-pink", label: "Acorn Dark Pink" },
      { id: "acorn-light", label: "Acorn Light Green" },
      { id: "acorn-light-pink", label: "Acorn Light Pink" },
    ]);
  });

  it("every built-in css passes validation", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(validateThemeCss(theme.css)).toEqual({ ok: true });
    }
  });

  it("gives every built-in dark theme an explicit terminal selection color", () => {
    for (const theme of BUILT_IN_THEMES.filter(
      (candidate) => candidate.mode === "dark",
    )) {
      expect(theme.css, theme.id).toMatch(/--color-term-selection\s*:/);
    }
  });

  it("gives every built-in theme an explicit UI selection color", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.css, theme.id).toMatch(/--color-selection\s*:/);
    }
  });

  it("gives every built-in theme an explicit input surface", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.css, theme.id).toMatch(/--color-input\s*:/);
      expect(theme.css, theme.id).toMatch(/--color-input-hover\s*:/);
      expect(theme.css, theme.id).toMatch(/--color-input-border\s*:/);
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

describe("resolveThemeMode", () => {
  it("returns the matching theme mode", () => {
    expect(resolveThemeMode("acorn-light", BUILT_IN_THEMES)).toBe("light");
    expect(resolveThemeMode("acorn-dark", BUILT_IN_THEMES)).toBe("dark");
  });

  it("falls back to the first theme mode when the id is unknown", () => {
    expect(resolveThemeMode("custom-missing", BUILT_IN_THEMES)).toBe("dark");
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
    applyTheme(
      "acorn-light",
      BUILT_IN_THEMES.find((theme) => theme.id === "acorn-light")?.css ?? "",
    );

    expect(document.querySelectorAll("style#acorn-theme")).toHaveLength(1);
    expect(document.documentElement.getAttribute("data-acorn-theme")).toBe(
      "acorn-light",
    );
  });
});
