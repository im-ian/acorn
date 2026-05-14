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
    // Legacy fields from the previous CJK-basis implementation. Keep reading
    // them so dev/HMR sessions can recover without recreating the terminal.
    originalCellWidth?: number;
    originalCanvasWidth?: number;
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

const CELL_WIDTH_EPSILON = 0.25;

export function patchTerminalCellMeasurements(term: TerminalInternals): void {
  const renderer = term._core?._renderService?._renderer?.value;
  const widthCache = renderer?._widthCache;
  if (!renderer || !widthCache || typeof widthCache.get !== "function") {
    return;
  }

  restoreLegacyCellWidthPatch(renderer);
  const targetCellWidth = measureTargetCellWidth(renderer, widthCache);
  if (targetCellWidth === null) {
    restoreTerminalCellMeasurements(renderer, widthCache);
    return;
  }

  const originalCellWidth =
    renderer.__acornCjkCellPatch?.originalCellWidth ?? getCellWidth(renderer);
  if (
    renderer.__acornCjkCellPatch &&
    !widthsDiffer(targetCellWidth, originalCellWidth)
  ) {
    restoreTerminalCellMeasurements(renderer, widthCache);
    return;
  }

  if (
    !renderer.__acornCjkCellPatch &&
    !widthsDiffer(targetCellWidth, getCellWidth(renderer))
  ) {
    return;
  }

  if (!renderer.__acornCjkCellPatch) {
    renderer.__acornCjkCellPatch = {
      originalSetDefaultSpacing: renderer._setDefaultSpacing?.bind(renderer),
      originalCellWidth: getCellWidth(renderer),
      originalCanvasWidth: renderer.dimensions?.css?.canvas?.width,
    };
    renderer._setDefaultSpacing = () => {
      restoreLegacyCellWidthPatch(renderer);
      const targetCellWidth = measureTargetCellWidth(renderer, widthCache);
      if (targetCellWidth === null) {
        restoreTerminalCellMeasurements(renderer, widthCache);
        return;
      }
      recalibrateDefaultSpacing(term, renderer, widthCache, targetCellWidth);
    };
  }

  widthCache.clear?.();
  recalibrateDefaultSpacing(term, renderer, widthCache, targetCellWidth);

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

  const originalSetDefaultSpacing = patch.originalSetDefaultSpacing;
  restoreLegacyCellWidthPatch(renderer);
  delete renderer.__acornCjkCellPatch;

  if (originalSetDefaultSpacing) {
    renderer._setDefaultSpacing = originalSetDefaultSpacing;
  } else {
    delete renderer._setDefaultSpacing;
    if (renderer._rowContainer) {
      renderer._rowContainer.style.letterSpacing = "";
    }
    if (renderer._rowFactory) {
      delete renderer._rowFactory.defaultSpacing;
    }
  }

  widthCache.clear?.();
  originalSetDefaultSpacing?.();
}

function restoreLegacyCellWidthPatch(renderer: DomRenderer): void {
  const patch = renderer.__acornCjkCellPatch;
  const css = renderer.dimensions?.css;
  if (
    typeof patch?.originalCellWidth === "number" &&
    Number.isFinite(patch.originalCellWidth) &&
    css?.cell
  ) {
    css.cell.width = patch.originalCellWidth;
  }
  if (
    typeof patch?.originalCanvasWidth === "number" &&
    Number.isFinite(patch.originalCanvasWidth) &&
    css?.canvas
  ) {
    css.canvas.width = patch.originalCanvasWidth;
    for (const rowElement of renderer._rowElements ?? []) {
      rowElement.style.width = `${css.canvas.width}px`;
    }
  }
}

function getCellWidth(renderer: DomRenderer): number {
  return renderer.dimensions?.css?.cell?.width ?? 0;
}

function widthsDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > CELL_WIDTH_EPSILON;
}

function measureTargetCellWidth(
  renderer: DomRenderer,
  widthCache: WidthCache,
): number | null {
  if (renderer._rowContainer) {
    renderer._rowContainer.style.letterSpacing = "";
  }
  widthCache.clear?.();

  const asciiWidth = widthCache.get("W", false, false);
  const hangulWidth = widthCache.get("가", false, false);
  if (asciiWidth <= 0 || hangulWidth <= 0) return null;

  return widthsDiffer(asciiWidth, hangulWidth) ? asciiWidth : asciiWidth / 2;
}

function recalibrateDefaultSpacing(
  term: TerminalInternals,
  renderer: DomRenderer,
  widthCache: WidthCache,
  cellWidth: number,
): void {
  if (renderer._rowContainer) {
    renderer._rowContainer.style.letterSpacing = "";
  }

  applyCellWidth(term, renderer, cellWidth);

  const spacing = cellWidth - widthCache.get("W", false, false);
  if (!Number.isFinite(spacing)) return;

  if (renderer._rowContainer) {
    renderer._rowContainer.style.letterSpacing = `${spacing}px`;
  }
  if (renderer._rowFactory) {
    renderer._rowFactory.defaultSpacing = spacing;
  }
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
