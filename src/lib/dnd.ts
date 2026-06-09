import type { Direction, SplitSide } from "./layout";

/**
 * Drop zone classification based on pointer position relative to a rectangle.
 * Edge zones occupy a pixel-based band on each side (clamped so they never
 * exceed ~40% of the smaller pane dimension); the center zone is everything
 * else. Pixel-based thresholds feel consistent across narrow split panes and
 * wide single panes — a fixed percentage made narrow panes nearly all-center.
 */
export type DropZone =
  | { kind: "center" }
  | { kind: "edge"; direction: Direction; side: SplitSide };

const EDGE_PX = 64;
const EDGE_MAX_FRACTION = 0.4;

export function classifyDropZone(
  pointer: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
): DropZone {
  const distLeft = pointer.x - rect.left;
  const distRight = rect.left + rect.width - pointer.x;
  const distTop = pointer.y - rect.top;
  const distBottom = rect.top + rect.height - pointer.y;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);

  const thresholdX = Math.min(EDGE_PX, rect.width * EDGE_MAX_FRACTION);
  const thresholdY = Math.min(EDGE_PX, rect.height * EDGE_MAX_FRACTION);

  const isHorizontalEdge =
    (minDist === distLeft || minDist === distRight) && minDist < thresholdX;
  const isVerticalEdge =
    (minDist === distTop || minDist === distBottom) && minDist < thresholdY;

  if (!isHorizontalEdge && !isVerticalEdge) return { kind: "center" };

  if (minDist === distLeft) {
    return { kind: "edge", direction: "horizontal", side: "before" };
  }
  if (minDist === distRight) {
    return { kind: "edge", direction: "horizontal", side: "after" };
  }
  if (minDist === distTop) {
    return { kind: "edge", direction: "vertical", side: "before" };
  }
  return { kind: "edge", direction: "vertical", side: "after" };
}
