import { describe, expect, it } from "vitest";
import {
  getTerminalShortcutAction,
  isImeTerminatorKeydown,
  isImeTextData,
  isModifierOnlyKeydown,
  isPlainSpaceKeydown,
  isPlainSpaceText,
} from "./terminalInput";

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

  it("recognises plain space input text variants", () => {
    expect(isPlainSpaceText(" ")).toBe(true);
    expect(isPlainSpaceText("\u00a0")).toBe(true);
    expect(isPlainSpaceText("\u3000")).toBe(false);
    expect(isPlainSpaceText("  ")).toBe(false);
  });

  it("classifies IME terminator keydowns separately from IME text input", () => {
    expect(
      isImeTerminatorKeydown({
        key: "Process",
        code: "Space",
        keyCode: 229,
      }),
    ).toBe(true);
    expect(isImeTerminatorKeydown({ key: " ", keyCode: 229 })).toBe(true);
    expect(isImeTerminatorKeydown({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isImeTerminatorKeydown({ key: "Process", keyCode: 229 })).toBe(
      false,
    );
  });

  it("recognises CJK input text as IME data", () => {
    expect(isImeTextData("한")).toBe(true);
    expect(isImeTextData("あ")).toBe(true);
    expect(isImeTextData("中")).toBe(true);
    expect(isImeTextData("a")).toBe(false);
    expect(isImeTextData(null)).toBe(false);
  });

  it("classifies modifier-only keys", () => {
    expect(isModifierOnlyKeydown({ key: "Shift" })).toBe(true);
    expect(isModifierOnlyKeydown({ key: "Control" })).toBe(true);
    expect(isModifierOnlyKeydown({ key: "a" })).toBe(false);
  });

  it("maps terminal-owned shortcuts to explicit actions", () => {
    expect(getTerminalShortcutAction({ key: "Enter", shiftKey: true })).toEqual(
      { kind: "write", data: "\n" },
    );
    expect(getTerminalShortcutAction({ key: "ArrowLeft", metaKey: true }))
      .toEqual({ kind: "write", data: "\x01" });
    expect(getTerminalShortcutAction({ key: "ArrowRight", metaKey: true }))
      .toEqual({ kind: "write", data: "\x05" });
    expect(getTerminalShortcutAction({ key: "ArrowDown", metaKey: true }))
      .toEqual({ kind: "scrollToLiveTail" });
    expect(
      getTerminalShortcutAction({
        key: "ArrowLeft",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBeNull();
  });
});
