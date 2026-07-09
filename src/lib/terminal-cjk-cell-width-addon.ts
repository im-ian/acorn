interface WidthCache {
  get(chars: string, bold: boolean | number, italic: boolean | number): number;
  clear?: () => void;
}

interface DomRenderer {
  _rowContainer?: HTMLElement;
  _rowElements?: HTMLElement[];
  _rowFactory?: { defaultSpacing?: number };
  _setDefaultSpacing?: () => void;
  handleResize?: (cols: number, rows: number) => void;
  _widthCache?: WidthCache;
  __acornCjkCellPatch?: {
    originalSetDefaultSpacing?: () => void;
    originalHandleResize?: (cols: number, rows: number) => void;
    cjkCellWidthHeuristic?: boolean;
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
  options?: {
    letterSpacing?: number;
  };
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
const PATCH_WIDTH_EPSILON = 0.001;

interface CellMeasurementPatchOptions {
  cjkCellWidthHeuristic?: boolean;
}

export function patchTerminalCellMeasurements(
  term: TerminalInternals,
  options: CellMeasurementPatchOptions = {},
): void {
  const renderer = term._core?._renderService?._renderer?.value;
  const widthCache = renderer?._widthCache;
  if (!renderer || !widthCache || typeof widthCache.get !== "function") {
    return;
  }

  restoreLegacyCellWidthPatch(renderer);
  const patchOptions = normalizePatchOptions(options);
  if (renderer.__acornCjkCellPatch) {
    renderer.__acornCjkCellPatch.cjkCellWidthHeuristic =
      patchOptions.cjkCellWidthHeuristic;
  }
  const targetCellWidth = measureTargetCellWidth(
    term,
    renderer,
    widthCache,
    patchOptions,
  );
  if (targetCellWidth === null) {
    restoreTerminalCellMeasurements(renderer, widthCache);
    restoreDefaultSpacing(renderer);
    return;
  }

  const originalCellWidth =
    renderer.__acornCjkCellPatch?.originalCellWidth ?? getCellWidth(renderer);
  if (
    renderer.__acornCjkCellPatch &&
    !patchWidthsDiffer(targetCellWidth, originalCellWidth)
  ) {
    restoreTerminalCellMeasurements(renderer, widthCache);
    return;
  }

  if (
    !renderer.__acornCjkCellPatch &&
    !patchWidthsDiffer(targetCellWidth, getCellWidth(renderer))
  ) {
    restoreDefaultSpacing(renderer);
    return;
  }

  if (!renderer.__acornCjkCellPatch) {
    renderer.__acornCjkCellPatch = {
      originalSetDefaultSpacing: renderer._setDefaultSpacing?.bind(renderer),
      originalHandleResize: renderer.handleResize?.bind(renderer),
      cjkCellWidthHeuristic: patchOptions.cjkCellWidthHeuristic,
      originalCellWidth: getCellWidth(renderer),
      originalCanvasWidth: renderer.dimensions?.css?.canvas?.width,
    };
    renderer._setDefaultSpacing = () => {
      restoreLegacyCellWidthPatch(renderer);
      const patchOptions = currentPatchOptions(renderer);
      const targetCellWidth = measureTargetCellWidth(
        term,
        renderer,
        widthCache,
        patchOptions,
      );
      if (targetCellWidth === null) {
        restoreTerminalCellMeasurements(renderer, widthCache);
        restoreDefaultSpacing(renderer);
        return;
      }
      recalibrateDefaultSpacing(term, renderer, widthCache, targetCellWidth);
    };
    if (renderer.handleResize) {
      renderer.handleResize = (cols: number, rows: number) => {
        renderer.__acornCjkCellPatch?.originalHandleResize?.(cols, rows);
        rememberCurrentRendererMetrics(renderer);
        patchTerminalCellMeasurements(term, currentPatchOptions(renderer));
      };
    }
  }

  widthCache.clear?.();
  recalibrateDefaultSpacing(term, renderer, widthCache, targetCellWidth);

  if (typeof term.rows === "number" && term.rows > 0) {
    term.refresh?.(0, term.rows - 1);
  }
}

export function unpatchTerminalCellMeasurements(term: TerminalInternals): void {
  const renderer = term._core?._renderService?._renderer?.value;
  const widthCache = renderer?._widthCache;
  if (!renderer || !widthCache || typeof widthCache.get !== "function") {
    return;
  }
  if (!renderer.__acornCjkCellPatch) return;

  restoreTerminalCellMeasurements(renderer, widthCache);
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
  const originalHandleResize = patch.originalHandleResize;
  restoreLegacyCellWidthPatch(renderer);
  delete renderer.__acornCjkCellPatch;

  if (originalHandleResize) {
    renderer.handleResize = originalHandleResize;
  }
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

function rememberCurrentRendererMetrics(renderer: DomRenderer): void {
  const patch = renderer.__acornCjkCellPatch;
  const css = renderer.dimensions?.css;
  if (!patch || !css) return;

  const cellWidth = css.cell?.width;
  if (typeof cellWidth === "number" && Number.isFinite(cellWidth)) {
    patch.originalCellWidth = cellWidth;
  }

  const canvasWidth = css.canvas?.width;
  if (typeof canvasWidth === "number" && Number.isFinite(canvasWidth)) {
    patch.originalCanvasWidth = canvasWidth;
  }
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

function patchWidthsDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > PATCH_WIDTH_EPSILON;
}

function normalizePatchOptions(
  options: CellMeasurementPatchOptions,
): Required<CellMeasurementPatchOptions> {
  return {
    cjkCellWidthHeuristic: options.cjkCellWidthHeuristic ?? true,
  };
}

function currentPatchOptions(
  renderer: DomRenderer,
): Required<CellMeasurementPatchOptions> {
  return {
    cjkCellWidthHeuristic:
      renderer.__acornCjkCellPatch?.cjkCellWidthHeuristic ?? true,
  };
}

function configuredLetterSpacing(term: TerminalInternals): number {
  const letterSpacing = term.options?.letterSpacing;
  if (typeof letterSpacing !== "number" || !Number.isFinite(letterSpacing)) {
    return 0;
  }
  return letterSpacing;
}

function measureTargetCellWidth(
  term: TerminalInternals,
  renderer: DomRenderer,
  widthCache: WidthCache,
  options: CellMeasurementPatchOptions,
): number | null {
  if (renderer._rowContainer) {
    renderer._rowContainer.style.letterSpacing = "";
  }
  widthCache.clear?.();

  const asciiWidth = widthCache.get("W", false, false);
  if (asciiWidth <= 0) return null;

  const letterSpacing = configuredLetterSpacing(term);
  if (options.cjkCellWidthHeuristic ?? true) {
    const hangulWidth = widthCache.get("가", false, false);
    if (hangulWidth <= 0) return null;
    if (!widthsDiffer(asciiWidth, hangulWidth)) {
      return asciiWidth / 2 + letterSpacing;
    }
  }
  return getCellWidth(renderer) + fractionalLetterSpacingDelta(letterSpacing);
}

function restoreDefaultSpacing(renderer: DomRenderer): void {
  renderer._setDefaultSpacing?.();
}

function fractionalLetterSpacingDelta(letterSpacing: number): number {
  return letterSpacing - Math.round(letterSpacing);
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
