import { normalizeShellCommandWhitespace } from "./shellCommandWhitespace";

/** Choseong/jungseong/jongseong and compatibility jamo (ㅇ, ㄱ, ㅏ, …). */
const JAMO_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xd7b0, 0xd7ff],
];

/** Compatibility choseong in the same order as U+1100..U+1112. */
const COMPAT_CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

function codePointIsJamo(cp: number): boolean {
  return JAMO_RANGES.some(([start, end]) => cp >= start && cp <= end);
}

/**
 * True when every NFC character is a Hangul jamo, not a precomposed syllable.
 * NFD 안 (ᄋ+ᅡ+ᆫ) is a syllable after NFC and must not be treated as teardown.
 */
export function isHangulJamoOnly(text: string): boolean {
  if (text.length === 0) return false;
  return [...text.normalize("NFC")].every((char) => {
    const cp = char.codePointAt(0);
    return cp !== undefined && codePointIsJamo(cp);
  });
}

function choseongIndex(text: string): number | null {
  const chars = [...text.normalize("NFC")];
  const last = chars[chars.length - 1];
  if (!last) return null;
  const cp = last.codePointAt(0);
  if (cp === undefined) return null;
  if (cp >= 0xac00 && cp <= 0xd7a3) {
    return Math.floor((cp - 0xac00) / (21 * 28));
  }
  if (cp >= 0x1100 && cp <= 0x1112) return cp - 0x1100;
  const compat = COMPAT_CHOSEONG.indexOf(last);
  return compat >= 0 ? compat : null;
}

/**
 * True when `next` is the IME shrinking `previous` (있→이, 안→ㅇ), not a
 * fresh composition (ㅇ→아, 안→ㅋ). Backspace swallow must not apply to
 * the latter or the next syllable never reaches the PTY.
 */
export function isHangulDecomposition(previous: string, next: string): boolean {
  if (next.length === 0) return true;
  if (previous.length === 0) return false;
  const prevNfc = previous.normalize("NFC");
  const nextNfc = next.normalize("NFC");
  if (prevNfc === nextNfc) return true;
  const prevNfd = prevNfc.normalize("NFD");
  const nextNfd = nextNfc.normalize("NFD");
  if (nextNfd.length < prevNfd.length && prevNfd.startsWith(nextNfd)) {
    return true;
  }
  return (
    isHangulJamoOnly(nextNfc) &&
    !isHangulJamoOnly(prevNfc) &&
    choseongIndex(prevNfc) !== null &&
    choseongIndex(prevNfc) === choseongIndex(nextNfc)
  );
}

/** Precompose conjoining jamo so the PTY receives 안, not ᄋ+ᅡ+ᆫ. */
export function normalizeHangulCommit(text: string): string {
  if (/[\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF]/u.test(text)) {
    return text.normalize("NFC");
  }
  return text;
}

/** Text that should stay in the IME overlay after `committed` is flushed.
 *  WKWebView often starts the next Hangul syllable (and fires
 *  `insertCompositionText`) before `insertFromComposition` for the previous
 *  one. The textarea/`preview` then already hold `하` while we are still
 *  committing `녕` — that remainder must not be cleared. */
export function compositionRemainderAfterCommit(
  live: string,
  sentPrefix: string,
  committed: string,
  preview: string,
): string {
  if (!committed) return "";
  const afterPrefix = live.startsWith(sentPrefix)
    ? live.slice(sentPrefix.length)
    : live;
  const source = afterPrefix || preview;
  if (!source) return "";
  // `committed` reaches here already precomposed, while `live`/`preview` are
  // whatever WebKit left in the textarea — which differs for the same
  // character in two ways: it may be NFD (ᄋ+ᅡ+ᆫ vs 안), and a terminator the
  // IME folded into the composition comes through as a plain space here but a
  // NO-BREAK SPACE there. Compared raw, the committed text is simply not
  // found, the whole value reads as leftover, the composition never closes,
  // and the terminator keydown commits it a second time — 안녕하세요 요.
  //
  // Match on a canonical form of both. NFC changes lengths, so the remainder
  // is sliced out of the canonical source rather than the original; that is
  // the form the rest of the commit path wants anyway. A source that genuinely
  // does not contain the committed text is a different composition and is
  // handed back untouched.
  const haystack = canonical(source);
  const needle = canonical(committed);
  if (haystack === needle) return "";
  const at = haystack.lastIndexOf(needle);
  if (at >= 0) return haystack.slice(at + needle.length);
  return source;
}

/** Comparison form for textarea text vs. an already-committed syllable. */
function canonical(text: string): string {
  return normalizeShellCommandWhitespace(text).normalize("NFC");
}
