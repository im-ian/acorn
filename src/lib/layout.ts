/**
 * Layout tree for split panes in the main workspace.
 *
 * The tree is a binary tree where leaves are panes (identified by `PaneId`)
 * and internal nodes are splits with a direction. The tree shape mirrors what
 * `react-resizable-panels` will render.
 *
 * `direction` matches `PanelGroup`'s prop:
 * - "horizontal" → side-by-side (left/right) split
 * - "vertical"   → stacked (top/bottom) split
 *
 * All operations are pure: they return new trees and never mutate the input.
 */

export type Direction = "horizontal" | "vertical";
export type PaneId = string;
export type PaneFocusDirection = "left" | "right" | "up" | "down";

export interface PaneNode {
  kind: "pane";
  id: PaneId;
}

export interface SplitNode {
  kind: "split";
  id: string;
  direction: Direction;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export type SplitSide = "before" | "after";

export function makePaneNode(id: PaneId): PaneNode {
  return { kind: "pane", id };
}

export function listPaneIds(layout: LayoutNode): PaneId[] {
  if (layout.kind === "pane") return [layout.id];
  return [...listPaneIds(layout.a), ...listPaneIds(layout.b)];
}

export function findPaneNode(
  layout: LayoutNode,
  paneId: PaneId,
): PaneNode | null {
  if (layout.kind === "pane") {
    return layout.id === paneId ? layout : null;
  }
  return findPaneNode(layout.a, paneId) ?? findPaneNode(layout.b, paneId);
}

interface PaneBounds {
  id: PaneId;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function collectPaneBounds(
  layout: LayoutNode,
  left: number,
  top: number,
  right: number,
  bottom: number,
  out: PaneBounds[],
): void {
  if (layout.kind === "pane") {
    out.push({ id: layout.id, left, top, right, bottom });
    return;
  }

  if (layout.direction === "horizontal") {
    const mid = (left + right) / 2;
    collectPaneBounds(layout.a, left, top, mid, bottom, out);
    collectPaneBounds(layout.b, mid, top, right, bottom, out);
    return;
  }

  const mid = (top + bottom) / 2;
  collectPaneBounds(layout.a, left, top, right, mid, out);
  collectPaneBounds(layout.b, left, mid, right, bottom, out);
}

function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.max(a1, b1) < Math.min(a2, b2);
}

export function findAdjacentPaneId(
  layout: LayoutNode,
  fromPaneId: PaneId,
  direction: PaneFocusDirection,
): PaneId | null {
  const bounds: PaneBounds[] = [];
  collectPaneBounds(layout, 0, 0, 1, 1, bounds);
  const current = bounds.find((b) => b.id === fromPaneId);
  if (!current) return null;

  let best: { id: PaneId; distance: number; offset: number } | null = null;
  const currentX = (current.left + current.right) / 2;
  const currentY = (current.top + current.bottom) / 2;

  for (const candidate of bounds) {
    if (candidate.id === current.id) continue;
    let distance: number | null = null;
    let offset = 0;

    if (direction === "left" && candidate.right <= current.left) {
      if (!overlaps(current.top, current.bottom, candidate.top, candidate.bottom)) {
        continue;
      }
      distance = current.left - candidate.right;
      offset = Math.abs(currentY - (candidate.top + candidate.bottom) / 2);
    } else if (direction === "right" && candidate.left >= current.right) {
      if (!overlaps(current.top, current.bottom, candidate.top, candidate.bottom)) {
        continue;
      }
      distance = candidate.left - current.right;
      offset = Math.abs(currentY - (candidate.top + candidate.bottom) / 2);
    } else if (direction === "up" && candidate.bottom <= current.top) {
      if (!overlaps(current.left, current.right, candidate.left, candidate.right)) {
        continue;
      }
      distance = current.top - candidate.bottom;
      offset = Math.abs(currentX - (candidate.left + candidate.right) / 2);
    } else if (direction === "down" && candidate.top >= current.bottom) {
      if (!overlaps(current.left, current.right, candidate.left, candidate.right)) {
        continue;
      }
      distance = candidate.top - current.bottom;
      offset = Math.abs(currentX - (candidate.left + candidate.right) / 2);
    }

    if (distance === null) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && offset < best.offset)
    ) {
      best = { id: candidate.id, distance, offset };
    }
  }

  return best?.id ?? null;
}

/**
 * Replace the pane with id `targetPaneId` with a new split that contains the
 * existing pane and a new pane, in the given direction. `side` says where the
 * new pane goes relative to the existing one.
 */
export function splitPaneInLayout(
  layout: LayoutNode,
  targetPaneId: PaneId,
  direction: Direction,
  newPaneId: PaneId,
  side: SplitSide,
  splitId: string,
): LayoutNode {
  if (layout.kind === "pane") {
    if (layout.id !== targetPaneId) return layout;
    const newPane: PaneNode = makePaneNode(newPaneId);
    const a = side === "before" ? newPane : layout;
    const b = side === "before" ? layout : newPane;
    return { kind: "split", id: splitId, direction, a, b };
  }
  return {
    ...layout,
    a: splitPaneInLayout(
      layout.a,
      targetPaneId,
      direction,
      newPaneId,
      side,
      splitId,
    ),
    b: splitPaneInLayout(
      layout.b,
      targetPaneId,
      direction,
      newPaneId,
      side,
      splitId,
    ),
  };
}

/**
 * Remove the pane with id `paneId`. The surviving sibling collapses up into
 * the parent's slot. Returns `null` if the layout becomes empty (i.e. caller
 * tried to remove the only pane).
 */
export function removePaneFromLayout(
  layout: LayoutNode,
  paneId: PaneId,
): LayoutNode | null {
  if (layout.kind === "pane") {
    return layout.id === paneId ? null : layout;
  }
  const aResult = removePaneFromLayout(layout.a, paneId);
  const bResult = removePaneFromLayout(layout.b, paneId);
  if (aResult === null) return bResult;
  if (bResult === null) return aResult;
  if (aResult === layout.a && bResult === layout.b) return layout;
  return { ...layout, a: aResult, b: bResult };
}
