import { useCallback, useEffect, useRef } from "react";
import {
  currentScrollPosition,
  restoreScrollPosition,
  type PartialScrollPosition,
  type ScrollPosition,
} from "../lib/scrollPosition";

const SCROLL_REPORT_DELAY_MS = 80;

export function useRestoredScrollRef<T extends HTMLElement>(
  position: PartialScrollPosition | undefined,
) {
  const positionRef = useRef(position);
  const restoredRef = useRef(false);

  useEffect(() => {
    positionRef.current = position;
  }, [position?.scrollLeft, position?.scrollTop]);

  return useCallback((node: T | null) => {
    if (!node) {
      restoredRef.current = false;
      return;
    }
    if (restoredRef.current) return;
    restoredRef.current = true;
    restoreScrollPosition(node, positionRef.current);
  }, []);
}

export function useDeferredScrollReporter(
  onChange: ((position: ScrollPosition) => void) | undefined,
) {
  const onChangeRef = useRef(onChange);
  const latestRef = useRef<ScrollPosition | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const flush = useCallback(() => {
    timeoutRef.current = null;
    const latest = latestRef.current;
    if (latest) onChangeRef.current?.(latest);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      const latest = latestRef.current;
      if (latest) {
        window.setTimeout(() => onChangeRef.current?.(latest), 0);
      }
    };
  }, []);

  return useCallback(
    (position: ScrollPosition) => {
      latestRef.current = position;
      if (timeoutRef.current !== null) return;
      timeoutRef.current = window.setTimeout(flush, SCROLL_REPORT_DELAY_MS);
    },
    [flush],
  );
}

export function scrollPositionFromEventTarget(
  target: EventTarget & HTMLElement,
): ScrollPosition {
  return currentScrollPosition(target);
}
