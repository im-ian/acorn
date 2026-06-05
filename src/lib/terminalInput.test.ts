import { describe, expect, it } from "vitest";
import { isPlainSpaceKeydown } from "./terminalInput";

describe("terminal input", () => {
  it("recognises unmodified physical space variants", () => {
    expect(isPlainSpaceKeydown({ key: " ", code: "Space" })).toBe(true);
    expect(isPlainSpaceKeydown({ key: "Spacebar" })).toBe(true);
    expect(isPlainSpaceKeydown({ key: "\u00a0", code: "Space" })).toBe(true);
    expect(isPlainSpaceKeydown({ key: "Process", code: "Space" })).toBe(true);
  });

  it("leaves modified spaces to xterm", () => {
    expect(
      isPlainSpaceKeydown({ key: "\u00a0", code: "Space", altKey: true }),
    ).toBe(false);
    expect(
      isPlainSpaceKeydown({ key: " ", code: "Space", ctrlKey: true }),
    ).toBe(false);
    expect(
      isPlainSpaceKeydown({ key: " ", code: "Space", metaKey: true }),
    ).toBe(false);
  });

  it("ignores non-space keys", () => {
    expect(isPlainSpaceKeydown({ key: "a", code: "KeyA" })).toBe(false);
    expect(isPlainSpaceKeydown({ key: "Enter", code: "Enter" })).toBe(false);
  });
});
