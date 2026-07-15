import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";
import {
  compileGrammarRegex,
  highlightDiff,
  highlightThemeForMode,
} from "./highlight";

// The TextMate line-comment rule shared by the JS/TS grammars.
const COMMENT_PATTERN = "(^[\\t ]+)?((//)(?:\\s*((@)internal)(?=\\s|$))?)";

describe("highlightThemeForMode", () => {
  it("uses a high-contrast light syntax theme for light app themes", () => {
    expect(highlightThemeForMode("light")).toBe("github-light-high-contrast");
  });

  it("keeps the dark syntax theme for dark app themes", () => {
    expect(highlightThemeForMode("dark")).toBe("github-dark");
  });
});

describe("compileGrammarRegex", () => {
  // JavaScriptCore start-anchors any pattern containing a bare `^`, even inside
  // an optional group, so it never finds a trailing `//`. Vitest runs on V8 and
  // cannot observe that, so assert the shape that keeps WKWebView correct.
  it("compiles a leading optional `^` group without a bare start anchor", () => {
    const compiled = compileGrammarRegex(COMMENT_PATTERN);

    expect(compiled.source).not.toMatch(/^\(\^/);
    expect(compiled.source).toContain("(?<=");
  });

  it("still matches a comment that does not start the line", () => {
    const compiled = compileGrammarRegex(COMMENT_PATTERN);

    expect(compiled.exec("const a = []; // hi")?.index).toBe(14);
  });
});

describe("highlightDiff", () => {
  it("does not carry unterminated block comment state across hunk gaps", async () => {
    const lines = parseDiff(
      [
        "@@ -1,2 +1,2 @@",
        " /**",
        "  * Starts a doc comment outside the changed range",
        "@@ -20,2 +20,2 @@",
        " export function run() {",
        "   return 1;",
      ].join("\n"),
    );

    const highlighted = await highlightDiff(lines, "typescript");
    const secondHunkCode = highlighted[4] ?? "";

    expect(secondHunkCode).toContain(">export</span>");
    expect(secondHunkCode).toContain(">function</span>");
    expect(secondHunkCode).not.toContain(">export function run() {</span>");
  });
});
