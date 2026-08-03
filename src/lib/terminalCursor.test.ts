import { describe, expect, it } from "vitest";

import {
  nextCursorApplicationOverride,
  xtermCursorStyle,
} from "./terminalCursor";

describe("xtermCursorStyle", () => {
  it.each([
    ["block", "block"],
    ["bar", "bar"],
    ["underline", "underline"],
    ["outline", "block"],
    ["pill", "bar"],
  ] as const)("maps %s to %s", (preset, expected) => {
    expect(xtermCursorStyle(preset)).toBe(expected);
  });
});

describe("nextCursorApplicationOverride", () => {
  it("treats an omitted parameter and supported DECSCUSR values as overrides", () => {
    expect(nextCursorApplicationOverride(false, undefined)).toBe(true);
    for (let value = 1; value <= 6; value += 1) {
      expect(nextCursorApplicationOverride(false, value)).toBe(true);
    }
  });

  it("returns control to the user preset for DECSCUSR reset", () => {
    expect(nextCursorApplicationOverride(true, 0)).toBe(false);
  });

  it("preserves the current state for unsupported values", () => {
    expect(nextCursorApplicationOverride(false, 7)).toBe(false);
    expect(nextCursorApplicationOverride(true, 7)).toBe(true);
    expect(nextCursorApplicationOverride(true, 1.5)).toBe(true);
  });
});
