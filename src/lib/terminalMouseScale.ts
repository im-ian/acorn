import type { Terminal as XTerm } from "@xterm/xterm";

interface MousePosition {
  clientX: number;
  clientY: number;
}

interface XtermMouseService {
  getCoords(
    event: MousePosition,
    element: HTMLElement,
    colCount: number,
    rowCount: number,
    isSelection?: boolean,
  ): [number, number] | undefined;
  getMouseReportCoords?(
    event: MouseEvent,
    element: HTMLElement,
  ): { col: number; row: number; x: number; y: number } | undefined;
}

interface XtermSelectionService {
  _screenElement?: HTMLElement;
  _getMouseEventScrollAmount?(event: MouseEvent): number;
}

interface XtermMouseInternals {
  _core?: {
    screenElement?: HTMLElement;
    _mouseService?: XtermMouseService;
    _selectionService?: XtermSelectionService;
  };
}

export function scaledMousePositionForElement<T extends MousePosition>(
  event: T,
  element: HTMLElement,
): MousePosition {
  const rect = element.getBoundingClientRect();
  const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
  const scaleY =
    element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001)
  ) {
    return event;
  }

  return {
    clientX: rect.left + (event.clientX - rect.left) / scaleX,
    clientY: rect.top + (event.clientY - rect.top) / scaleY,
  };
}

export function patchTerminalMouseCoordinateScale(term: XTerm): () => void {
  const core = (term as unknown as XtermMouseInternals)._core;
  const mouseService = core?._mouseService;
  if (!mouseService) return () => {};

  const originalGetCoords = mouseService.getCoords;
  const originalGetMouseReportCoords = mouseService.getMouseReportCoords;
  const selectionService = core?._selectionService;
  const originalGetMouseEventScrollAmount =
    selectionService?._getMouseEventScrollAmount;

  mouseService.getCoords = (event, element, colCount, rowCount, isSelection) =>
    originalGetCoords.call(
      mouseService,
      scaledMousePositionForElement(event, element),
      element,
      colCount,
      rowCount,
      isSelection,
    );

  if (originalGetMouseReportCoords) {
    mouseService.getMouseReportCoords = (event, element) =>
      originalGetMouseReportCoords.call(
        mouseService,
        scaledMousePositionForElement(event, element) as MouseEvent,
        element,
      );
  }

  if (selectionService && originalGetMouseEventScrollAmount) {
    selectionService._getMouseEventScrollAmount = (event) => {
      const element = selectionService._screenElement ?? core?.screenElement;
      if (!element) {
        return originalGetMouseEventScrollAmount.call(selectionService, event);
      }
      return originalGetMouseEventScrollAmount.call(
        selectionService,
        scaledMousePositionForElement(event, element) as MouseEvent,
      );
    };
  }

  return () => {
    mouseService.getCoords = originalGetCoords;
    if (originalGetMouseReportCoords) {
      mouseService.getMouseReportCoords = originalGetMouseReportCoords;
    }
    if (selectionService && originalGetMouseEventScrollAmount) {
      selectionService._getMouseEventScrollAmount =
        originalGetMouseEventScrollAmount;
    }
  };
}
