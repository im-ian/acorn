import { describe, expect, it } from "vitest";
import { globMatches } from "./FileExplorer";

describe("FileExplorer glob matching", () => {
  it.each([
    ["src/main.ts", "*.ts", false, true],
    ["src/main.ts", "src/?ain.ts", true, true],
    ["src/generated/client.ts", "src/**/client.?s", true, true],
    ["README.MD", "*.md", false, true],
    ["README.MD", "*.md", true, false],
    ["src/main.ts", "tests/*", false, false],
    ["abc", "**a**b**c**", true, true],
  ])(
    "matches %s against %s",
    (value, glob, caseSensitive, expected) => {
      expect(globMatches(value, glob, caseSensitive)).toBe(expected);
    },
  );

  it("handles long hostile wildcard input without regex backtracking", () => {
    const value = `${"a".repeat(4_096)}b`;
    const glob = `${"*a".repeat(256)}c`;
    expect(globMatches(value, glob, true)).toBe(false);
  });
});
