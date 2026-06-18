import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";
import { highlightDiff, highlightThemeForMode } from "./highlight";

describe("highlightThemeForMode", () => {
  it("uses a high-contrast light syntax theme for light app themes", () => {
    expect(highlightThemeForMode("light")).toBe("github-light-high-contrast");
  });

  it("keeps the dark syntax theme for dark app themes", () => {
    expect(highlightThemeForMode("dark")).toBe("github-dark");
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
