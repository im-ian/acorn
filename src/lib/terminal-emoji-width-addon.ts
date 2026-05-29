interface WidthCache {
  get(chars: string, bold: boolean | number, italic: boolean | number): number;
  clear?: () => void;
  __acornEmojiWidthPatch?: {
    originalGet: WidthCache["get"];
  };
}

interface DomRenderer {
  _widthCache?: WidthCache;
  dimensions?: {
    css?: {
      cell?: {
        width?: number;
      };
    };
  };
}

interface TerminalInternals {
  cols?: number;
  rows?: number;
  refresh?: (start: number, end: number) => void;
  _core?: {
    _renderService?: {
      _renderer?: {
        value?: DomRenderer;
      };
    };
    unicodeService?: {
      getStringCellWidth?: (text: string) => number;
    };
    _unicodeService?: {
      getStringCellWidth?: (text: string) => number;
    };
  };
}

export function patchTerminalEmojiWidthMeasurements(
  term: TerminalInternals,
): void {
  const renderer = term._core?._renderService?._renderer?.value;
  const widthCache = renderer?._widthCache;
  const unicodeService = term._core?.unicodeService ?? term._core?._unicodeService;
  if (
    !renderer ||
    !widthCache ||
    typeof widthCache.get !== "function" ||
    widthCache.__acornEmojiWidthPatch
  ) {
    return;
  }

  const patch = { originalGet: widthCache.get };
  widthCache.__acornEmojiWidthPatch = patch;
  widthCache.get = (chars, bold, italic) => {
    const measuredWidth = patch.originalGet.call(widthCache, chars, bold, italic);
    if (!isEmojiLikeTerminalCluster(chars) || measuredWidth <= 0) {
      return measuredWidth;
    }

    const cellWidth = renderer.dimensions?.css?.cell?.width;
    const cellCount = unicodeService?.getStringCellWidth?.(chars);
    if (
      typeof cellWidth !== "number" ||
      !Number.isFinite(cellWidth) ||
      cellWidth <= 0 ||
      typeof cellCount !== "number" ||
      !Number.isFinite(cellCount) ||
      cellCount < 2
    ) {
      return measuredWidth;
    }

    const gridWidth = cellWidth * cellCount;
    return Number.isFinite(gridWidth) && gridWidth > 0
      ? Math.min(measuredWidth, gridWidth)
      : measuredWidth;
  };
  widthCache.clear?.();
}

export function unpatchTerminalEmojiWidthMeasurements(
  term: TerminalInternals,
): void {
  const widthCache =
    term._core?._renderService?._renderer?.value?._widthCache;
  const patch = widthCache?.__acornEmojiWidthPatch;
  if (!widthCache || !patch) return;

  widthCache.get = patch.originalGet;
  delete widthCache.__acornEmojiWidthPatch;
  widthCache.clear?.();
}

function isEmojiLikeTerminalCluster(chars: string): boolean {
  for (const char of chars) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint === 0x200d ||
      codePoint === 0x20e3 ||
      codePoint === 0xfe0f ||
      (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    ) {
      return true;
    }
  }
  return false;
}
