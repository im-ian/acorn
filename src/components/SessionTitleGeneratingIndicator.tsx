import { Sparkles } from "lucide-react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

interface SessionTitleGeneratingIndicatorProps {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  draggable?: boolean;
}

export function SessionTitleGeneratingIndicator({
  label,
  side = "bottom",
  className,
  draggable = false,
}: SessionTitleGeneratingIndicatorProps) {
  return (
    <Tooltip label={label} side={side} draggable={draggable}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          "pointer-events-none acorn-session-title-indicator",
          className,
        )}
      >
        <Sparkles
          size={9}
          aria-hidden="true"
          className="acorn-session-title-indicator-icon"
        />
      </span>
    </Tooltip>
  );
}
