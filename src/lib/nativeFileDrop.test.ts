import { describe, expect, it } from "vitest";
import { resolveNativeDropScaleFactor } from "./nativeFileDrop";

describe("resolveNativeDropScaleFactor", () => {
  it("accepts positive monitor scale changes", () => {
    expect(resolveNativeDropScaleFactor(1.5, 1)).toBe(1.5);
    expect(resolveNativeDropScaleFactor(2, 1.5)).toBe(2);
  });

  it("retains the last usable scale for invalid events", () => {
    expect(resolveNativeDropScaleFactor(0, 1.5)).toBe(1.5);
    expect(resolveNativeDropScaleFactor(Number.NaN, 2)).toBe(2);
  });
});
