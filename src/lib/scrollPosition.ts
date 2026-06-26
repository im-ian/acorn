export interface ScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

export type PartialScrollPosition = Partial<ScrollPosition>;

export function currentScrollPosition(element: HTMLElement): ScrollPosition {
  return {
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
  };
}

export function restoreScrollPosition(
  element: HTMLElement,
  position: PartialScrollPosition | undefined,
): void {
  if (!position) return;
  const scrollTop = finiteScrollValue(position.scrollTop);
  const scrollLeft = finiteScrollValue(position.scrollLeft);
  element.scrollTop = scrollTop;
  element.scrollLeft = scrollLeft;

  // Some scroll surfaces get their real dimensions after a virtualizer or
  // image has measured. A second frame keeps restoration deterministic without
  // depending on the child implementation's mount order.
  requestAnimationFrame(() => {
    element.scrollTop = scrollTop;
    element.scrollLeft = scrollLeft;
  });
}

function finiteScrollValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}
