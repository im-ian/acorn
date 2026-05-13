interface WidthCache {
  get(chars: string, bold: boolean | number, italic: boolean | number): number;
  clear?: () => void;
}

interface DomRenderer {
  _rowContainer?: HTMLElement;
  _rowElements?: HTMLElement[];
  _rowFactory?: { defaultSpacing?: number };
  _setDefaultSpacing?: () => void;
  _widthCache?: WidthCache;
  __acornCjkCellPatch?: {
    originalSetDefaultSpacing?: () => void;
    originalWidthGet?: WidthCache["get"];
  };
  dimensions?: {
    css?: {
      cell?: {
        width?: number;
      };
      canvas?: {
        width?: number;
      };
    };
  };
}

interface TerminalInternals {
  options: {
    fontFamily?: string;
  };
  cols?: number;
  rows?: number;
  refresh?: (start: number, end: number) => void;
  _core?: {
    _renderService?: {
      _renderer?: {
        value?: DomRenderer;
      };
    };
    _unicodeService?: {
      getStringCellWidth?: (text: string) => number;
    };
  };
}

const CJK_FONT_RE = /(?:D2Coding|Sarasa|CJK|Noto Sans Mono CJK)/i;
const CJK_OR_WIDE_RE =
  /[\u1100-\u11ff\u2e80-\u303f\u3130-\u318f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/;
const CJK_FONT_SAMPLES: Array<[RegExp, string]> = [
  [/(?:D2Coding|Sarasa\s+Mono\s+K|CJK\s+KR|Korean|Hangul|Malgun|Apple\s+SD\s+Gothic)/i, "가"],
  [/(?:CJK\s+JP|Japanese|Hiragino|Yu\s+Gothic|Meiryo)/i, "あ"],
  [/(?:CJK\s+SC|CJK\s+CN|Simplified|PingFang\s+SC|Microsoft\s+YaHei)/i, "汉"],
  [/(?:CJK\s+TC|CJK\s+HK|Traditional|PingFang\s+TC|MingLiU)/i, "漢"],
  [/(?:Sarasa|CJK|Chinese)/i, "漢"],
];

export function shouldPatchTerminalCellMeasurements(
  fontFamily: string | undefined,
): boolean {
  return !!fontFamily && CJK_FONT_RE.test(fontFamily);
}

export function selectCjkMeasurementSample(
  fontFamily: string | undefined,
): string | null {
  if (!fontFamily) return null;
  for (const [pattern, sample] of CJK_FONT_SAMPLES) {
    if (pattern.test(fontFamily)) return sample;
  }
  return null;
}

export function shouldClampMeasuredWidth(chars: string): boolean {
  return CJK_OR_WIDE_RE.test(chars);
}

export function calculateDefaultSpacingFromSample(
  measuredSampleWidth: number,
  sampleCells: number,
  cellWidth: number,
): number | null {
  if (measuredSampleWidth <= 0 || sampleCells <= 0 || cellWidth <= 0) {
    return null;
  }
  const expectedSampleWidth = sampleCells * cellWidth;
  return expectedSampleWidth - measuredSampleWidth;
}

export function calculateCellWidthFromSample(
  measuredSampleWidth: number,
  sampleCells: number,
): number | null {
  if (measuredSampleWidth <= 0 || sampleCells <= 0) {
    return null;
  }
  return measuredSampleWidth / sampleCells;
}

export function clampMeasuredWidth(
  measuredWidth: number,
  expectedCells: number,
  cellWidth: number,
): number {
  if (expectedCells <= 0 || cellWidth <= 0) return measuredWidth;
  const expectedWidth = expectedCells * cellWidth;
  return measuredWidth < expectedWidth ? expectedWidth : measuredWidth;
}

export function patchTerminalCellMeasurements(term: TerminalInternals): void {
  const renderer = term._core?._renderService?._renderer?.value;
  const widthCache = renderer?._widthCache;
  if (!renderer || !widthCache || typeof widthCache.get !== "function") {
    return;
  }

  if (!shouldPatchTerminalCellMeasurements(term.options.fontFamily)) {
    restoreTerminalCellMeasurements(renderer, widthCache);
    return;
  }

  if (!renderer.__acornCjkCellPatch) {
    renderer.__acornCjkCellPatch = {
      originalSetDefaultSpacing: renderer._setDefaultSpacing?.bind(renderer),
    };
    renderer._setDefaultSpacing = () =>
      recalibrateDefaultSpacing(term, renderer, widthCache);
  }

  widthCache.clear?.();
  recalibrateDefaultSpacing(term, renderer, widthCache);

  if (typeof term.rows === "number" && term.rows > 0) {
    term.refresh?.(0, term.rows - 1);
  }
}

function restoreTerminalCellMeasurements(
  renderer: DomRenderer,
  widthCache: WidthCache,
): void {
  const patch = renderer.__acornCjkCellPatch;
  if (!patch) return;

  if (patch.originalWidthGet) {
    widthCache.get = patch.originalWidthGet;
  }
  if (patch.originalSetDefaultSpacing) {
    renderer._setDefaultSpacing = patch.originalSetDefaultSpacing;
  }
  widthCache.clear?.();
  renderer._setDefaultSpacing?.();
  delete renderer.__acornCjkCellPatch;
}

function getCellWidth(renderer: DomRenderer): number {
  return renderer.dimensions?.css?.cell?.width ?? 0;
}

function getStringCellWidth(term: TerminalInternals, text: string): number {
  const width = term._core?._unicodeService?.getStringCellWidth?.(text);
  if (typeof width === "number" && width > 0) return width;

  let fallback = 0;
  for (const char of text) {
    fallback += CJK_OR_WIDE_RE.test(char) ? 2 : 1;
  }
  return fallback;
}

function applyCellWidth(
  term: TerminalInternals,
  renderer: DomRenderer,
  cellWidth: number,
): void {
  const css = renderer.dimensions?.css;
  if (!css?.cell || cellWidth <= 0) return;

  css.cell.width = cellWidth;
  if (css.canvas && typeof term.cols === "number" && term.cols > 0) {
    css.canvas.width = cellWidth * term.cols;
    for (const rowElement of renderer._rowElements ?? []) {
      rowElement.style.width = `${css.canvas.width}px`;
    }
  }
}

function recalibrateDefaultSpacing(
  term: TerminalInternals,
  renderer: DomRenderer,
  widthCache: WidthCache,
): void {
  const sample = selectCjkMeasurementSample(term.options.fontFamily);
  const measuredSampleWidth =
    sample === null ? 0 : widthCache.get(sample, false, false);
  const sampleCells = sample === null ? 0 : getStringCellWidth(term, sample);
  const cellWidth =
    calculateCellWidthFromSample(measuredSampleWidth, sampleCells) ??
    getCellWidth(renderer);
  applyCellWidth(term, renderer, cellWidth);

  const spacing = cellWidth - widthCache.get("W", false, false);
  if (renderer._rowContainer) {
    renderer._rowContainer.style.letterSpacing = `${spacing}px`;
  }
  if (renderer._rowFactory) {
    renderer._rowFactory.defaultSpacing = spacing;
  }
}
