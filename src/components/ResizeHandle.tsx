import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "../lib/cn";

interface ResizeHandleProps {
  direction?: "horizontal" | "vertical";
}

export function ResizeHandle({ direction = "horizontal" }: ResizeHandleProps) {
  const isHorizontal = direction === "horizontal";
  return (
    <PanelResizeHandle
      className={cn(
        "group relative flex shrink-0 items-center justify-center bg-border/40 transition",
        "hover:bg-accent/40 data-[resize-handle-state=drag]:bg-accent/60",
        isHorizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <span
        className={cn(
          "absolute rounded-full bg-fg-muted/0 transition group-hover:bg-fg-muted/30",
          isHorizontal ? "h-8 w-0.5" : "h-0.5 w-8",
        )}
      />
    </PanelResizeHandle>
  );
}
