import { describe, expect, it } from "vitest";
import {
  lineEditorAltArrowSequence,
  type AltArrowKey,
  type AltArrowScreen,
} from "./terminalAltArrow";

const shell: AltArrowScreen = {
  alternateScreen: false,
  mouseTracking: false,
  applicationCursor: false,
};

function alt(key: string, extra: Partial<AltArrowKey> = {}): AltArrowKey {
  return {
    key,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...extra,
  };
}

describe("lineEditorAltArrowSequence", () => {
  it("sends emacs word-motion and plain arrows at a shell prompt", () => {
    expect(lineEditorAltArrowSequence(alt("ArrowLeft"), shell)).toBe("\x1bb");
    expect(lineEditorAltArrowSequence(alt("ArrowRight"), shell)).toBe("\x1bf");
    expect(lineEditorAltArrowSequence(alt("ArrowUp"), shell)).toBe("\x1b[A");
    expect(lineEditorAltArrowSequence(alt("ArrowDown"), shell)).toBe("\x1b[B");
  });

  it("uses SS3 arrows when the shell has application cursor mode on", () => {
    const screen = { ...shell, applicationCursor: true };
    expect(lineEditorAltArrowSequence(alt("ArrowUp"), screen)).toBe("\x1bOA");
    expect(lineEditorAltArrowSequence(alt("ArrowDown"), screen)).toBe("\x1bOB");
    expect(lineEditorAltArrowSequence(alt("ArrowLeft"), screen)).toBe("\x1bb");
  });

  it("leaves the CSI form for an alternate-screen or mouse-tracking TUI", () => {
    expect(
      lineEditorAltArrowSequence(alt("ArrowLeft"), {
        ...shell,
        alternateScreen: true,
      }),
    ).toBeNull();
    expect(
      lineEditorAltArrowSequence(alt("ArrowLeft"), {
        ...shell,
        mouseTracking: true,
      }),
    ).toBeNull();
  });

  it("ignores chords and non-arrows", () => {
    expect(lineEditorAltArrowSequence(alt("ArrowLeft", { ctrlKey: true }), shell)).toBeNull();
    expect(lineEditorAltArrowSequence(alt("ArrowLeft", { metaKey: true }), shell)).toBeNull();
    expect(lineEditorAltArrowSequence(alt("ArrowLeft", { shiftKey: true }), shell)).toBeNull();
    expect(lineEditorAltArrowSequence(alt("ArrowLeft", { altKey: false }), shell)).toBeNull();
    expect(lineEditorAltArrowSequence(alt("a"), shell)).toBeNull();
  });
});
