export const ACORN_FLOATING_LAYER_SELECTOR = "[data-acorn-floating-layer]";

export function isInAcornFloatingLayer(target: EventTarget | null): boolean {
  if (target instanceof Element) {
    return target.closest(ACORN_FLOATING_LAYER_SELECTOR) !== null;
  }
  if (target instanceof Node) {
    return (
      target.parentElement?.closest(ACORN_FLOATING_LAYER_SELECTOR) !== null
    );
  }
  return false;
}
