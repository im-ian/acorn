import {
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Separator } from "react-resizable-panels";
import { cn } from "../lib/cn";
import {
  EXPAND_PANEL_EVENT,
  type ExpandPanelDetail,
} from "../lib/layoutEvents";

interface ResizeHandleProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  mode?: "panel" | "manual";
  direction?: "horizontal" | "vertical";
  showDivider?: boolean;
  thin?: boolean;
  /**
   * Floating-card gap: the handle becomes a transparent ~6px gutter so the
   * darker canvas shows through between pane cards. Distinct from `thin`
   * (a 1px divider reused by modals/diff views) — only the app layout opts
   * into `gap` so those other surfaces stay unaffected.
   */
  gap?: boolean;
  manualDragging?: boolean;
}

/**
 * Resize handle behaviour:
 *
 * 1. Open state: the handle is visually quiet at rest unless its caller
 *    opts into a divider. Thin handles render as 1px and the library's
 *    default `resizeTargetMinimumSize` (20px coarse / 10px fine, set on the
 *    parent `Group`) keeps the resize target forgiving. The cursor flips
 *    to col/row resize on hover, and a 1px accent line appears during drag.
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

export function ResizeHandle({
  mode = "panel",
  direction = "horizontal",
  showDivider = false,
  thin = false,
  gap = false,
  manualDragging = false,
  className,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  role,
  tabIndex,
  ...rest
}: ResizeHandleProps) {
  const isHorizontal = direction === "horizontal";
  const handleId = useId();
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [manualHovered, setManualHovered] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<DOMRect | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const [collapsedPanelId, setCollapsedPanelId] = useState<string | null>(null);
  const effectiveDragging = mode === "manual" ? manualDragging : dragging;
  const effectiveHovered = mode === "manual" ? manualHovered : hovered;

  // Mirror the lib's `data-separator` state into React state. CSS arbitrary
  // variants (`data-[separator=hover]:...`) compiled unreliably in this
  // project's Tailwind 4 setup, so drive visibility off React state instead.
  // v4 folds the old `onDragging` callback into this same attribute:
  // "inactive" | "hover" | "active" | "focus" | "disabled".
  useEffect(() => {
    const handle = findHandle(handleId);
    if (!handle) return;
    const read = () => {
      const state = handle.getAttribute("data-separator");
      setHovered(state === "hover" || state === "active");
      setDragging(state === "active");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(handle, {
      attributes: true,
      attributeFilter: ["data-separator"],
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
      const collapsed = gatherAdjacents(handle).find((a) => a.isCollapsed);
      setCollapsedPanelId(collapsed?.panel.getAttribute("id") ?? null);
    };
    recompute();
    const observer = new MutationObserver(recompute);
    for (const panel of adjacents) {
      observer.observe(panel, {
        attributes: true,
        attributeFilter: ["style"],
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
  // Floating-card gutter with both neighbours open: there's no border to
  // grab, so hovering the transparent gap surfaces a faint grip to hint the
  // resize affordance. (A collapsed neighbour uses `showHandleVisual` for
  // the louder re-expand grip instead.)
  const showGapHint = gap && !showHandleVisual;
  const handleClassName = cn(
    "relative flex shrink-0 items-center justify-center bg-transparent transition-colors duration-150",
    isHorizontal
      ? gap
        ? "w-1.5 cursor-col-resize"
        : thin
          ? "w-px cursor-col-resize"
          : "w-3 cursor-col-resize"
      : gap
        ? "h-1.5 cursor-row-resize"
        : thin
          ? "h-px cursor-row-resize"
          : "h-3 cursor-row-resize",
    className,
  );
  const handleContent = (
    <>
      {(showHandleVisual || showGapHint) &&
      (effectiveHovered || effectiveDragging) ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-opacity duration-150"
          style={{
            // Gradient sits behind the grip in the gutter: keep the state
            // color (white on hover, accent on drag) but fade the top and
            // bottom ends to transparent.
            backgroundImage: `linear-gradient(${
              isHorizontal ? "to bottom" : "to right"
            }, transparent, ${
              effectiveDragging
                ? "color-mix(in oklab, var(--color-accent) 65%, transparent)"
                : "color-mix(in oklab, #ffffff 15%, transparent)"
            }, transparent)`,
          }}
        />
      ) : null}
      {showDivider || (effectiveDragging && !showHandleVisual && !gap) ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute transition-colors duration-150",
            effectiveDragging && !showHandleVisual
              ? "bg-accent"
              : "bg-border/80",
            isHorizontal ? "h-full w-px" : "h-px w-full",
          )}
        />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none rounded-full transition duration-150",
          // Fixed mid-size grip; only opacity/color changes between
          // hover/drag so the user gets a steady rounded visual. For a gap
          // gutter the grip turns accent on drag, replacing the square line.
          isHorizontal ? "h-10 w-[2px]" : "h-[2px] w-10",
          showGapHint && effectiveDragging ? "bg-accent" : "bg-white",
          showHandleVisual
            ? effectiveDragging
              ? "opacity-100"
              : effectiveHovered
                ? "opacity-70"
                : "opacity-0"
            : showGapHint
              ? effectiveDragging
                ? "opacity-100"
                : effectiveHovered
                  ? "opacity-60"
                  : "opacity-0"
              : "opacity-0",
        )}
      />
    </>
  );

  if (mode === "manual") {
    return (
      <div
        {...rest}
        role={role ?? "separator"}
        tabIndex={tabIndex ?? 0}
        aria-orientation={
          rest["aria-orientation"] ?? (isHorizontal ? "vertical" : "horizontal")
        }
        onMouseEnter={(event) => {
          setManualHovered(true);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setManualHovered(false);
          onMouseLeave?.(event);
        }}
        onFocus={(event) => {
          setManualHovered(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setManualHovered(false);
          onBlur?.(event);
        }}
        className={handleClassName}
      >
        {handleContent}
      </div>
    );
  }

  return (
    <>
      <Separator
        id={handleId}
        // v4 resets the neighbouring panel to its `defaultSize` on
        // double-click. Acorn binds that gesture to re-expanding a collapsed
        // panel instead, so the built-in behaviour is turned off.
        disableDoubleClick
        onDoubleClick={handleDoubleClick}
        className={handleClassName}
      >
        {handleContent}
      </Separator>
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
    `[data-testid="${cssEscape(handleId)}"][data-separator]`,
  );
}

/**
 * Panels and separators are siblings inside their Group, so walking the DOM in
 * both directions finds the pair this handle sits between. v3 resolved the
 * leading panel through `aria-controls`; v4 keeps that attribute but sibling
 * walking covers both sides with one code path.
 */
function findAdjacentPanels(
  handle: HTMLElement,
): [HTMLElement | null, HTMLElement | null] {
  return [
    findSiblingPanel(handle, "previousElementSibling"),
    findSiblingPanel(handle, "nextElementSibling"),
  ];
}

function findSiblingPanel(
  handle: HTMLElement,
  direction: "previousElementSibling" | "nextElementSibling",
): HTMLElement | null {
  let cursor =
    direction === "previousElementSibling"
      ? handle.previousElementSibling
      : handle.nextElementSibling;
  while (cursor) {
    if (cursor instanceof HTMLElement && cursor.hasAttribute("data-panel")) {
      return cursor;
    }
    cursor =
      direction === "previousElementSibling"
        ? cursor.previousElementSibling
        : cursor.nextElementSibling;
  }
  return null;
}

interface AdjacentInfo {
  panel: HTMLElement;
  isCollapsed: boolean;
}

/**
 * v4 dropped the `data-panel-size` and `data-panel-collapsible` attributes
 * this used to read, so collapse is inferred from the flex-grow the library
 * writes inline instead. Non-collapsible panels never reach zero — every
 * Acorn panel declares a `minSize` — so a zero-ish grow means a collapsible
 * neighbour actually collapsed.
 */
function gatherAdjacents(handle: HTMLElement): AdjacentInfo[] {
  return findAdjacentPanels(handle)
    .filter((panel): panel is HTMLElement => panel !== null)
    .map((panel) => ({
      panel,
      isCollapsed: Number(panel.style.flexGrow || "0") < 0.005,
    }));
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
