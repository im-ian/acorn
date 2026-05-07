import { useEffect, useMemo, useRef } from "react";
import {
  Panel,
  PanelGroup,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import type { Direction, LayoutNode } from "../lib/layout";
import { EQUALIZE_PANES_EVENT } from "../lib/layoutEvents";
import { Pane } from "./Pane";
import { ResizeHandle } from "./ResizeHandle";

/**
 * Count leaves that share the parent's split axis. When a child is a leaf
 * pane, or a split running perpendicular to `axis`, it contributes 1 — the
 * whole sub-tree reads as a single cell on this axis. When the child is a
 * split running along `axis`, recurse so chained same-direction splits
 * (like `B | C | D` rendered as nested horizontals) collapse into one
 * counter and the equalize call divides them evenly.
 *
 * Without this perpendicular-aware counting, a layout like
 *   vertical(A, horizontal(B, horizontal(C, D)))
 * would equalize to A=25% / B=25% / C=25% / D=25% along the vertical axis,
 * even though A is a single row and B/C/D share one row underneath. This
 * helper makes the vertical split count rows (1:1 → 50/50) and the
 * horizontal row count columns (1:2 → 33/67 → B=33%, C=33.5%, D=33.5%).
 */
function coAxialLeafCount(node: LayoutNode, axis: Direction): number {
  if (node.kind === "pane") return 1;
  if (node.direction !== axis) return 1;
  return coAxialLeafCount(node.a, axis) + coAxialLeafCount(node.b, axis);
}

interface LayoutRendererProps {
  node: LayoutNode;
}

/**
 * Recursively renders a workspace layout tree using react-resizable-panels.
 * Leaves render `<Pane>`; internal nodes render a nested `<PanelGroup>` with
 * a resize handle between the two children.
 */
export function LayoutRenderer({ node }: LayoutRendererProps) {
  if (node.kind === "pane") {
    return <Pane paneId={node.id} />;
  }
  // For react-resizable-panels, `direction="horizontal"` arranges children
  // side-by-side and the handle is a vertical bar (cursor-col-resize).
  // `direction="vertical"` stacks them and the handle is horizontal.
  const handleDirection =
    node.direction === "horizontal" ? "horizontal" : "vertical";
  // Weight by co-axial leaves so each row/column is divided evenly along
  // its own axis without inflating cross-axis subtrees.
  const leftLeaves = coAxialLeafCount(node.a, node.direction);
  const rightLeaves = coAxialLeafCount(node.b, node.direction);
  const total = leftLeaves + rightLeaves;
  const leftPct = (leftLeaves / total) * 100;
  const rightPct = 100 - leftPct;
  return (
    <EqualizablePanelGroup
      direction={node.direction}
      id={node.id}
      leftPct={leftPct}
      rightPct={rightPct}
    >
      <Panel id={`${node.id}:a`} order={1} defaultSize={leftPct} minSize={10}>
        <LayoutRenderer node={node.a} />
      </Panel>
      <ResizeHandle direction={handleDirection} />
      <Panel id={`${node.id}:b`} order={2} defaultSize={rightPct} minSize={10}>
        <LayoutRenderer node={node.b} />
      </Panel>
    </EqualizablePanelGroup>
  );
}

interface EqualizablePanelGroupProps {
  id: string;
  direction: "horizontal" | "vertical";
  leftPct: number;
  rightPct: number;
  children: React.ReactNode;
}

/** PanelGroup wrapper that listens for the equalize event and resets its own
 * children to leaf-count-weighted sizes. We attach per-group rather than
 * enumerating all groups from a parent because react-resizable-panels does
 * not expose a registry; the event-bus pattern keeps the recursion local. */
function EqualizablePanelGroup({
  id,
  direction,
  leftPct,
  rightPct,
  children,
}: EqualizablePanelGroupProps) {
  const ref = useRef<ImperativePanelGroupHandle | null>(null);
  const target = useMemo(() => [leftPct, rightPct], [leftPct, rightPct]);

  useEffect(() => {
    const onEqualize = () => {
      ref.current?.setLayout(target);
    };
    window.addEventListener(EQUALIZE_PANES_EVENT, onEqualize);
    return () => {
      window.removeEventListener(EQUALIZE_PANES_EVENT, onEqualize);
    };
  }, [target]);

  return (
    <PanelGroup ref={ref} direction={direction} id={id}>
      {children}
    </PanelGroup>
  );
}
