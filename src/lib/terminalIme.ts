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

/**
 * True when `next` is the same composition growing (ㅎ→하→한, ㅇ→아→안).
 * Production WKWebView delivers that as `insertReplacementText` and must
 * not flush the previous preview.
 */
export function isHangulCompositionAdvance(previous: string, next: string): boolean {
  if (!previous || !next) return false;
  const prevNfc = previous.normalize("NFC");
  const nextNfc = next.normalize("NFC");
  if (prevNfc === nextNfc) return true;
  const prevNfd = prevNfc.normalize("NFD");
  const nextNfd = nextNfc.normalize("NFD");
  if (nextNfd.startsWith(prevNfd) && nextNfd.length > prevNfd.length) {
    return true;
  }
  return (
    isHangulJamoOnly(prevNfc) &&
    !isHangulJamoOnly(nextNfc) &&
    choseongIndex(prevNfc) !== null &&
    choseongIndex(prevNfc) === choseongIndex(nextNfc)
  );
}

/**
 * True when WKWebView replaced the helper textarea with a new Hangul
 * composition and the previous preview is a finished syllable that never
 * got `insertFromComposition`. Custom-protocol production builds often
 * skip that event; HTTP `tauri dev` usually does not.
 */
export function shouldFlushReplacedHangul(previous: string, next: string): boolean {
  if (!previous || previous === next) return false;
  if (isHangulCompositionAdvance(previous, next)) return false;
  if (next.length === 0) {
    // Finished syllable being cleared (next composition's
    // deleteCompositionText). Incomplete jamo is teardown, not a commit.
    // Backspace vs next-syllable delete is the caller's imeDeleting check.
    return !isHangulJamoOnly(previous);
  }
  if (isHangulDecomposition(previous, next)) return false;
  return true;
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
  if (!source || source === committed) return "";
  const at = source.lastIndexOf(committed);
  if (at >= 0) return source.slice(at + committed.length);
  return source;
}
