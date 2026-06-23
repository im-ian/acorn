import type { CSSProperties, HTMLAttributes } from "react";
import type { PullRequestLabel } from "../lib/types";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

interface GitHubLabelChipProps extends HTMLAttributes<HTMLSpanElement> {
  label: PullRequestLabel;
}

export function GitHubLabelChip({
  label,
  className,
  style,
  ...props
}: GitHubLabelChipProps) {
  const hex = label.color.replace(/^#/, "");
  const color = `#${hex}`;
  const labelStyle: CSSProperties = {
    backgroundColor: `${color}1f`,
    borderColor: `${color}40`,
    color,
    ...style,
  };

  return (
    <Tooltip label={label.name} side="top">
      <span
        className={cn(
          "inline-flex max-w-full shrink-0 items-center rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
          className,
        )}
        style={labelStyle}
        {...props}
      >
        <span className="truncate">{label.name}</span>
      </span>
    </Tooltip>
  );
}
