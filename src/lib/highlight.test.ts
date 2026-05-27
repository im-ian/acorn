import { describe, expect, it } from "vitest";
import { highlightThemeForMode } from "./highlight";

describe("highlightThemeForMode", () => {
  it("uses a high-contrast light syntax theme for light app themes", () => {
    expect(highlightThemeForMode("light")).toBe("github-light-high-contrast");
  });

  it("keeps the dark syntax theme for dark app themes", () => {
    expect(highlightThemeForMode("dark")).toBe("github-dark");
  });
});
