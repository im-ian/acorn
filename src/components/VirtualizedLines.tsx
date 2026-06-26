import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ClipboardEvent,
  type Key,
  type RefObject,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  currentScrollPosition,
  restoreScrollPosition,
  type PartialScrollPosition,
  type ScrollPosition,
} from "../lib/scrollPosition";

export const VIRTUALIZED_LINE_THRESHOLD = 500;

const DEFAULT_OVERSCAN = 12;
const INITIAL_VIEWPORT_ROWS = 36;
const SHOW_TEXT = 4;
const ELEMENT_NODE = 1;

interface VirtualizedLineListProps {
  as?: "div" | "pre";
  count: number;
  className?: string;
  innerClassName?: string;
  estimateSize: (index: number) => number;
  getLineText: (index: number) => string;
  renderLine: (index: number) => ReactNode;
  minWidthCh?: number;
  overscan?: number;
  threshold?: number;
  restoreScrollPosition?: PartialScrollPosition;
  onScrollPositionChange?: (position: ScrollPosition) => void;
}

export interface VirtualizedLineListHandle {
  scrollToIndex: (index: number, align?: "start" | "center" | "end") => void;
}

interface SelectionEndpoint {
  index: number;
  offset: number;
  insideContent: boolean;
}

interface RenderedVirtualItem {
  key: Key;
  index: number;
  start: number;
  size: number;
}

export const VirtualizedLineList = forwardRef<
  VirtualizedLineListHandle,
  VirtualizedLineListProps
>(function VirtualizedLineList(
  {
    as = "div",
    count,
    className,
    innerClassName,
    estimateSize,
    getLineText,
    renderLine,
    minWidthCh,
    overscan = DEFAULT_OVERSCAN,
    threshold = VIRTUALIZED_LINE_THRESHOLD,
    restoreScrollPosition: restoredScrollPosition,
    onScrollPositionChange,
  },
  ref,
) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const restoredScrollPositionRef = useRef(restoredScrollPosition);
  const onScrollPositionChangeRef = useRef(onScrollPositionChange);
  const didRestoreScrollRef = useRef(false);
  const virtualized = count > threshold;
  const averageInitialSize = useMemo(() => {
    if (count === 0) return 1;
    const sample = Math.min(count, INITIAL_VIEWPORT_ROWS);
    let total = 0;
    for (let i = 0; i < sample; i++) total += estimateSize(i);
    return Math.max(1, total / sample);
  }, [count, estimateSize]);
  const fallbackItems = useMemo(
    () =>
      buildFallbackItems(count, estimateSize, INITIAL_VIEWPORT_ROWS + overscan),
    [count, estimateSize, overscan],
  );

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan,
    initialRect: {
      width: 0,
      height: averageInitialSize * INITIAL_VIEWPORT_ROWS,
    },
  });
  // Only needed while the virtualizer has not produced a total yet (no
  // scroll element measured). Skipping the O(n) scan once measurements
  // exist keeps large lists from re-summing every line each render.
  const measuredTotalSize = virtualized ? virtualizer.getTotalSize() : 0;
  const estimatedTotalSize = useMemo(() => {
    if (!virtualized || measuredTotalSize > 0) return 0;
    let total = 0;
    for (let i = 0; i < count; i++) total += estimateSize(i);
    return total;
  }, [virtualized, measuredTotalSize, count, estimateSize]);
  const virtualItems = virtualizer.getVirtualItems();
  const renderedItems: RenderedVirtualItem[] =
    virtualItems.length > 0 ? virtualItems : fallbackItems;

  useEffect(() => {
    restoredScrollPositionRef.current = restoredScrollPosition;
  }, [restoredScrollPosition?.scrollLeft, restoredScrollPosition?.scrollTop]);

  useEffect(() => {
    onScrollPositionChangeRef.current = onScrollPositionChange;
  }, [onScrollPositionChange]);

  const setScrollRef = useCallback((node: HTMLElement | null) => {
    scrollRef.current = node;
    if (!node) {
      didRestoreScrollRef.current = false;
      return;
    }
    if (didRestoreScrollRef.current) return;
    didRestoreScrollRef.current = true;
    restoreScrollPosition(node, restoredScrollPositionRef.current);
  }, []);

  const handleScroll = useCallback((event: UIEvent<HTMLElement>) => {
    onScrollPositionChangeRef.current?.(
      currentScrollPosition(event.currentTarget),
    );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, align = "center") {
        if (index < 0 || index >= count) return;
        if (virtualized) {
          virtualizer.scrollToIndex(index, { align });
          return;
        }
        const line = scrollRef.current?.querySelector<HTMLElement>(
          `[data-line-index="${index}"]`,
        );
        line?.scrollIntoView?.({ block: align, inline: "nearest" });
      },
    }),
    [count, virtualized, virtualizer],
  );

  const onCopy = useVirtualizedCopy({
    enabled: virtualized,
    scrollRef,
    getLineText,
  });

  const props = {
    ref: setScrollRef,
    className,
    onScroll: handleScroll,
    onCopy,
    "data-virtualized": virtualized ? "true" : "false",
  };

  const content = virtualized ? (
    <div
      className={innerClassName}
      style={{
        height: measuredTotalSize || estimatedTotalSize,
        minWidth:
          minWidthCh === undefined ? undefined : `max(100%, ${minWidthCh}ch)`,
        position: "relative",
      }}
    >
      {renderedItems.map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          style={{
            height: item.size,
            left: 0,
            position: "absolute",
            right: 0,
            top: 0,
            transform: `translateY(${item.start}px)`,
          }}
        >
          {renderLine(item.index)}
        </div>
      ))}
    </div>
  ) : (
    <div className={innerClassName}>
      {Array.from({ length: count }, (_, index) => renderLine(index))}
    </div>
  );

  return as === "pre" ? (
    <pre {...props}>{content}</pre>
  ) : (
    <div {...props}>{content}</div>
  );
});

function buildFallbackItems(
  count: number,
  estimateSize: (index: number) => number,
  visibleCount: number,
): RenderedVirtualItem[] {
  const items: RenderedVirtualItem[] = [];
  let start = 0;
  const limit = Math.min(count, visibleCount);
  for (let index = 0; index < limit; index++) {
    const size = estimateSize(index);
    items.push({ key: index, index, start, size });
    start += size;
  }
  return items;
}

export function lineIndexProps(index: number) {
  return {
    "data-line-index": index,
  };
}

export function lineTextContentProps() {
  return {
    "data-line-content": "true",
  };
}

export function estimateMonospaceWidthCh(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === "\t") {
      width += 8 - (width % 8);
    } else {
      width += 1;
    }
  }
  return width;
}

export function estimateMaxLineWidthCh(
  lines: readonly string[],
  extraCh = 0,
): number {
  let max = 0;
  for (const line of lines) {
    max = Math.max(max, estimateMonospaceWidthCh(line));
  }
  return max + extraCh;
}

function useVirtualizedCopy({
  enabled,
  scrollRef,
  getLineText,
}: {
  enabled: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  getLineText: (index: number) => string;
}) {
  return useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const root = scrollRef.current;
      const selection = root?.ownerDocument.getSelection();
      if (
        !root ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        return;
      }
      const range = selection.getRangeAt(0);

      const rawStart = resolveEndpoint(
        root,
        range.startContainer,
        range.startOffset,
        getLineText,
      );
      const rawEnd = resolveEndpoint(
        root,
        range.endContainer,
        range.endOffset,
        getLineText,
      );
      if (!rawStart || !rawEnd) return;
      if (rawStart.index === rawEnd.index) return;

      const start = rawStart.insideContent
        ? rawStart
        : { ...rawStart, offset: 0 };
      const end = rawEnd.insideContent
        ? rawEnd
        : { ...rawEnd, offset: getLineText(rawEnd.index).length };
      event.clipboardData.setData(
        "text/plain",
        selectedLineText(start, end, getLineText),
      );
      event.preventDefault();
    },
    [enabled, getLineText, scrollRef],
  );
}

function resolveEndpoint(
  root: HTMLElement,
  node: Node | null,
  offset: number,
  getLineText: (index: number) => string,
): SelectionEndpoint | null {
  if (!node) return null;
  const element =
    node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
  const line = element?.closest<HTMLElement>("[data-line-index]");
  if (!line || !root.contains(line)) return null;
  const rawIndex = line.dataset.lineIndex;
  if (rawIndex === undefined) return null;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return null;

  const lineText = getLineText(index);
  const content = line.querySelector<HTMLElement>("[data-line-content]");
  const insideContent = content ? nodeWithin(content, node) : false;
  const textOffset = content
    ? offsetWithinContent(content, node, offset, 0)
    : 0;
  return {
    index,
    offset: clamp(textOffset, 0, lineText.length),
    insideContent,
  };
}

function offsetWithinContent(
  content: HTMLElement,
  node: Node,
  offset: number,
  fallback: number,
): number {
  if (!nodeWithin(content, node)) return fallback;
  if (node === content && node.nodeType === ELEMENT_NODE) {
    let total = 0;
    const childNodes = Array.from(node.childNodes);
    for (let i = 0; i < Math.min(offset, childNodes.length); i++) {
      total += childNodes[i]?.textContent?.length ?? 0;
    }
    return total;
  }

  const walker = content.ownerDocument.createTreeWalker(content, SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    const text = current.textContent ?? "";
    if (current === node) {
      return total + Math.min(offset, text.length);
    }
    total += text.length;
    current = walker.nextNode();
  }
  return fallback;
}

function nodeWithin(parent: Node, node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current === parent) return true;
    current = current.parentNode;
  }
  return false;
}

function selectedLineText(
  start: SelectionEndpoint,
  end: SelectionEndpoint,
  getLineText: (index: number) => string,
): string {
  const parts: string[] = [];
  for (let index = start.index; index <= end.index; index++) {
    const line = getLineText(index);
    if (index === start.index) {
      parts.push(line.slice(start.offset));
    } else if (index === end.index) {
      parts.push(line.slice(0, end.offset));
    } else {
      parts.push(line);
    }
  }
  return parts.join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
