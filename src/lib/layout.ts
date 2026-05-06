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
