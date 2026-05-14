import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "../lib/cn";
import {
  EXPAND_PANEL_EVENT,
  type ExpandPanelDetail,
} from "../lib/layoutEvents";

interface ResizeHandleProps {
  direction?: "horizontal" | "vertical";
}

/**
 * Resize handle behaviour:
 *
 * 1. Open state: the 12px bar is fully invisible at rest. The cursor
 *    flips to col/row resize on hover, and a 1px accent line appears
 *    centred during drag — visually equivalent to the original 1px
 *    border between panels.
 * 2. Closed state (an adjacent collapsible panel is collapsed): the bar
 *    fades to a faint white tint on hover and shows a fixed-size white
 *    grip pill so the user knows where to grab to re-expand.
 * 3. Closing: lib-native — drag the handle to the edge and the panel
 *    snaps to collapsed.
 * 4. Re-opening: hover surfaces a tooltip ("Double-click to expand")
 *    when an adjacent panel is collapsed. Double-click dispatches
 *    `acorn:expand-panel`; App.tsx maps the panel id to the matching
 *    imperative ref and restores it to its minSize.
 */
const TOOLTIP_DELAY_MS = 250;
const TOOLTIP_TEXT = "Double-click to expand";

export function ResizeHandle({ direction = "horizontal" }: ResizeHandleProps) {
  const isHorizontal = direction === "horizontal";
  const handleId = useId();
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<DOMRect | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const [collapsedPanelId, setCollapsedPanelId] = useState<string | null>(null);

  // Mirror the lib's `data-resize-handle-state` into React state. CSS
  // arbitrary variants (`data-[resize-handle-state=hover]:...`) compiled
  // unreliably in this project's Tailwind 4 setup, so drive visibility
  // off React state instead.
  useEffect(() => {
    const handle = findHandle(handleId);
    if (!handle) return;
    const read = () => {
      const state = handle.getAttribute("data-resize-handle-state");
      setHovered(state === "hover" || state === "drag");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(handle, {
      attributes: true,
      attributeFilter: ["data-resize-handle-state"],
    });
    return () => observer.disconnect();
  }, [handleId]);

  // Track whether an adjacent collapsible panel is currently collapsed.
  // Drives the double-click action and the tooltip — both only make
  // sense when there's a collapsed neighbour to expand.
  useEffect(() => {
    const handle = findHandle(handleId);
    if (!handle) return;
    const adjacents = findAdjacentPanels(handle).filter(
      (p): p is HTMLElement => p !== null,
    );
    if (adjacents.length === 0) return;
    const recompute = () => {
      const collapsed = gatherAdjacents(handle).find((a) => a.sizePct < 0.5);
      setCollapsedPanelId(
        collapsed?.panel.getAttribute("data-panel-id") ?? null,
      );
    };
    recompute();
    const observer = new MutationObserver(recompute);
    for (const panel of adjacents) {
      observer.observe(panel, {
        attributes: true,
        attributeFilter: ["data-panel-size", "data-panel-collapsible"],
      });
    }
    return () => observer.disconnect();
  }, [handleId]);

  // Tooltip: hover delay, hide on drag, only when collapsed.
  useEffect(() => {
    if (!hovered || dragging || !collapsedPanelId) {
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
      setTooltipAnchor(null);
      return;
    }
    tooltipTimerRef.current = window.setTimeout(() => {
      const handle = findHandle(handleId);
      if (!handle) return;
      setTooltipAnchor(handle.getBoundingClientRect());
    }, TOOLTIP_DELAY_MS);
    return () => {
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
    };
  }, [hovered, dragging, collapsedPanelId, handleId]);

  const handleDoubleClick = () => {
    if (!collapsedPanelId) return;
    const detail: ExpandPanelDetail = { panelId: collapsedPanelId };
    window.dispatchEvent(new CustomEvent(EXPAND_PANEL_EVENT, { detail }));
  };

  // Visual handle (bg tint + grip) only surfaces while an adjacent panel
  // is collapsed — that's the only state where the user needs an obvious
  // affordance for re-expand. While both neighbours are open we expect
  // the user to grab the panel border directly; the cursor still flips
  // to col/row resize so the resize action is discoverable without any
  // chrome of our own.
  const showHandleVisual = collapsedPanelId !== null;

  return (
    <>
      <PanelResizeHandle
        id={handleId}
        hitAreaMargins={{ coarse: 0, fine: 0 }}
        onDragging={setDragging}
        onDoubleClick={handleDoubleClick}
        className={cn(
          "relative flex shrink-0 items-center justify-center transition-colors duration-150",
          // Closed state: faint white tint on hover (re-expand affordance).
          // Open state stays transparent — the thin accent line below
          // surfaces during drag instead of a full-bar fill.
          showHandleVisual && hovered && !dragging
            ? "bg-white/5"
            : "bg-transparent",
          isHorizontal ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize",
        )}
      >
        {/* Open-state drag indicator: 1px accent line in the centre of
            the hit area, mimicking the original border-style separator. */}
        {dragging && !showHandleVisual ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute bg-accent",
              isHorizontal ? "h-full w-px" : "h-px w-full",
            )}
          />
        ) : null}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none rounded-full bg-white transition-opacity duration-150",
            // Fixed mid-size grip; only opacity changes between hover/drag
            // so the user gets a steady visual instead of a resizing pill.
            isHorizontal ? "h-10 w-[3px]" : "h-[3px] w-10",
            showHandleVisual
              ? dragging
                ? "opacity-100"
                : hovered
                  ? "opacity-70"
                  : "opacity-0"
              : "opacity-0",
          )}
        />
      </PanelResizeHandle>
      {tooltipAnchor && !dragging
        ? createPortal(
            <HandleTooltip
              anchor={tooltipAnchor}
              isHorizontal={isHorizontal}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/(["\\\]\[:])/g, "\\$1");
}

function findHandle(handleId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-panel-resize-handle-id="${cssEscape(handleId)}"]`,
  );
}

function findAdjacentPanels(
  handle: HTMLElement,
): [HTMLElement | null, HTMLElement | null] {
  const beforeId = handle.getAttribute("aria-controls");
  const before = beforeId
    ? document.querySelector<HTMLElement>(
        `[data-panel-id="${cssEscape(beforeId)}"]`,
      )
    : null;

  let after: HTMLElement | null = null;
  let cursor = handle.nextElementSibling;
  while (cursor) {
    if (cursor instanceof HTMLElement && cursor.hasAttribute("data-panel-id")) {
      after = cursor;
      break;
    }
    cursor = cursor.nextElementSibling;
  }
  return [before, after];
}

interface AdjacentInfo {
  panel: HTMLElement;
  sizePct: number;
}

function gatherAdjacents(handle: HTMLElement): AdjacentInfo[] {
  const [before, after] = findAdjacentPanels(handle);
  const out: AdjacentInfo[] = [];
  if (before && before.getAttribute("data-panel-collapsible") === "true") {
    out.push({
      panel: before,
      sizePct: Number(before.getAttribute("data-panel-size") ?? "0"),
    });
  }
  if (after && after.getAttribute("data-panel-collapsible") === "true") {
    out.push({
      panel: after,
      sizePct: Number(after.getAttribute("data-panel-size") ?? "0"),
    });
  }
  return out;
}

function HandleTooltip({
  anchor,
  isHorizontal,
}: {
  anchor: DOMRect;
  isHorizontal: boolean;
}) {
  // Flip side when no breathing room — keeps the right handle's tooltip
  // on-screen.
  const TOOLTIP_GAP = 6;
  const ESTIMATED_W = 180;
  const ESTIMATED_H = 24;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top: number;
  let left: number;
  let transform: string;

  if (isHorizontal) {
    const placeRight = anchor.right + TOOLTIP_GAP + ESTIMATED_W < vw;
    if (placeRight) {
      left = anchor.right + TOOLTIP_GAP;
      transform = "translate(0, -50%)";
    } else {
      left = anchor.left - TOOLTIP_GAP;
      transform = "translate(-100%, -50%)";
    }
    top = anchor.top + anchor.height / 2;
  } else {
    const placeBelow = anchor.bottom + TOOLTIP_GAP + ESTIMATED_H < vh;
    if (placeBelow) {
      top = anchor.bottom + TOOLTIP_GAP;
      transform = "translate(-50%, 0)";
    } else {
      top = anchor.top - TOOLTIP_GAP;
      transform = "translate(-50%, -100%)";
    }
    left = anchor.left + anchor.width / 2;
  }

  return (
    <span
      role="tooltip"
      style={{
        position: "fixed",
        top,
        left,
        transform,
        zIndex: 9999,
      }}
      className="pointer-events-none whitespace-nowrap rounded border border-border bg-bg-elevated px-2 py-0.5 text-[11px] font-normal text-fg shadow-md"
    >
      {TOOLTIP_TEXT}
    </span>
  );
}
