import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

export type GraphFlowEdgeData = {
  removable: boolean;
  removeLabel: string;
  label: string | null;
  state: "idle" | "active" | "traversed" | "failed";
};

export type GraphFlowEdge = Edge<GraphFlowEdgeData, "graphFlow">;

export function GraphFlowEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<GraphFlowEdge>) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={32}
      />
      {data?.label || (selected && data?.removable) ? (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute flex items-center gap-1"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.label ? (
              <span className="rounded-full border border-border bg-bg-elevated/95 px-2 py-0.5 text-[9px] font-medium text-fg-muted shadow-sm">
                {data.label}
              </span>
            ) : null}
            {selected && data.removable ? (
              <button
                type="button"
                aria-label={data.removeLabel}
                className={cn(
                  "nodrag nopan pointer-events-auto grid size-6 place-items-center rounded-full",
                  "border border-danger/45 bg-bg-elevated text-danger shadow-lg",
                  "transition hover:border-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/35",
                )}
                onClick={() => void deleteElements({ edges: [{ id }] })}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
