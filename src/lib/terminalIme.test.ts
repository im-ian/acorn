import { describe, expect, it } from "vitest";
import {
  compositionRemainderAfterCommit,
  isHangulCompositionAdvance,
  isHangulDecomposition,
  isHangulJamoOnly,
  normalizeHangulCommit,
  shouldFlushReplacedHangul,
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

describe("isHangulCompositionAdvance", () => {
  it("treats jamo growing into a syllable as the same composition", () => {
    expect(isHangulCompositionAdvance("ㅎ", "하")).toBe(true);
    expect(isHangulCompositionAdvance("하", "한")).toBe(true);
    expect(isHangulCompositionAdvance("ㅇ", "아")).toBe(true);
    expect(isHangulCompositionAdvance("아", "안")).toBe(true);
  });

  it("rejects a new syllable or a different jamo", () => {
    expect(isHangulCompositionAdvance("안", "녕")).toBe(false);
    expect(isHangulCompositionAdvance("ㅋ", "ㅎ")).toBe(false);
    expect(isHangulCompositionAdvance("안", "ㅋ")).toBe(false);
  });
});

describe("shouldFlushReplacedHangul", () => {
  it("flushes a finished syllable replaced by the next one", () => {
    expect(shouldFlushReplacedHangul("안", "녕")).toBe(true);
    expect(shouldFlushReplacedHangul("안", "ㄴ")).toBe(true);
    expect(shouldFlushReplacedHangul("ㅋ", "ㅎ")).toBe(true);
  });

  it("does not flush in-composition growth or backspace", () => {
    expect(shouldFlushReplacedHangul("ㅎ", "하")).toBe(false);
    expect(shouldFlushReplacedHangul("하", "한")).toBe(false);
    expect(shouldFlushReplacedHangul("한", "하")).toBe(false);
    expect(shouldFlushReplacedHangul("안", "ㅇ")).toBe(false);
    expect(shouldFlushReplacedHangul("안", "안")).toBe(false);
    expect(shouldFlushReplacedHangul("", "안")).toBe(false);
    expect(shouldFlushReplacedHangul("ㅎ", "")).toBe(false);
  });

  it("flushes a finished syllable when the textarea is cleared", () => {
    expect(shouldFlushReplacedHangul("사", "")).toBe(true);
    expect(shouldFlushReplacedHangul("랑", "")).toBe(true);
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
});
