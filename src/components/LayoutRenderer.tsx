import { Panel, PanelGroup } from "react-resizable-panels";
import type { LayoutNode } from "../lib/layout";
import { Pane } from "./Pane";
import { ResizeHandle } from "./ResizeHandle";

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
  return (
    <PanelGroup direction={node.direction} id={node.id}>
      <Panel id={`${node.id}:a`} order={1} defaultSize={50} minSize={10}>
        <LayoutRenderer node={node.a} />
      </Panel>
      <ResizeHandle direction={handleDirection} />
      <Panel id={`${node.id}:b`} order={2} defaultSize={50} minSize={10}>
        <LayoutRenderer node={node.b} />
      </Panel>
    </PanelGroup>
  );
}
