import { describe, expect, it } from "vitest";
import {
  compositionRemainderAfterCommit,
  isHangulDecomposition,
  isHangulJamoOnly,
  normalizeHangulCommit,
} from "./terminalIme";

describe("isHangulJamoOnly", () => {
  it("rejects precomposed syllables and NFD syllables", () => {
    expect(isHangulJamoOnly("안")).toBe(false);
    expect(isHangulJamoOnly("안".normalize("NFD"))).toBe(false);
    expect(isHangulJamoOnly("안녕")).toBe(false);
  });

  it("accepts compatibility and conjoining jamo", () => {
    expect(isHangulJamoOnly("ㅇ")).toBe(true);
    expect(isHangulJamoOnly("ㅋ")).toBe(true);
    expect(isHangulJamoOnly("ㅋㅋ")).toBe(true);
    expect(isHangulJamoOnly("\u110B")).toBe(true);
  });

  it("rejects empty text", () => {
    expect(isHangulJamoOnly("")).toBe(false);
  });
});

describe("isHangulDecomposition", () => {
  it("treats in-syllable backspace as decomposition", () => {
    expect(isHangulDecomposition("있", "이")).toBe(true);
    expect(isHangulDecomposition("안", "아")).toBe(true);
    expect(isHangulDecomposition("안", "ㅇ")).toBe(true);
  });

  it("does not treat a new composition as decomposition", () => {
    expect(isHangulDecomposition("ㅇ", "아")).toBe(false);
    expect(isHangulDecomposition("안", "ㅋ")).toBe(false);
    expect(isHangulDecomposition("ㅇ", "ㅋ")).toBe(false);
    expect(isHangulDecomposition("", "아")).toBe(false);
  });

  it("treats emptying the preview as decomposition", () => {
    expect(isHangulDecomposition("ㅇ", "")).toBe(true);
  });
});

describe("normalizeHangulCommit", () => {
  it("precomposes NFD syllables", () => {
    expect(normalizeHangulCommit("안".normalize("NFD"))).toBe("안");
    expect(normalizeHangulCommit("안")).toBe("안");
  });

  it("leaves compatibility jamo and latin alone", () => {
    expect(normalizeHangulCommit("ㅋ")).toBe("ㅋ");
    expect(normalizeHangulCommit("ok")).toBe("ok");
  });
});

describe("compositionRemainderAfterCommit", () => {
  it("keeps the next syllable already in the textarea", () => {
    expect(compositionRemainderAfterCommit("하", "녕", "녕", "하")).toBe("하");
    expect(compositionRemainderAfterCommit("하", "", "녕", "하")).toBe("하");
  });

  it("clears when the committed text is the whole preview", () => {
    expect(compositionRemainderAfterCommit("안", "", "안", "안")).toBe("");
  });

  it("matches a NO-BREAK SPACE textarea against a plain-space commit", () => {
    // The IME folds the terminator into the composition and
    // `insertFromComposition` delivers it as U+0020, while WebKit leaves
    // U+00A0 in the helper textarea for the same character. Comparing raw
    // leaves the whole value as "remainder", so the composition never closes
    // and the terminator keydown commits it twice (안녕하세요 요).
    expect(compositionRemainderAfterCommit("요\u00a0", "", "요 ", "")).toBe("");
  });

  it("still reports a genuinely different trailing composition", () => {
    expect(compositionRemainderAfterCommit("안하", "", "안", "")).toBe("하");
  });
});
