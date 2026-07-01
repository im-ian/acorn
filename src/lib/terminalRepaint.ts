interface RepaintTerminal {
  rows: number;
  refresh(start: number, end: number): void;
  scrollToBottom?(): void;
}

export function repaintTerminalViewport({
  container,
  fit,
  term,
  scrollToBottom = false,
}: {
  container: HTMLElement;
  fit: () => void;
  term: RepaintTerminal;
  scrollToBottom?: boolean;
}): void {
  // Force layout reflow so pending visibility/size changes commit before
  // xterm queries container dimensions or rebuilds visible rows.
  void container.offsetHeight;
  try {
    fit();
  } catch {
    // A hidden or zero-sized terminal can make FitAddon throw. The buffer can
    // still be repainted, so do not let a fit miss block the refresh.
  }
  try {
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    // Terminal may be disposed between scheduling and execution.
  }
  if (scrollToBottom) {
    try {
      term.scrollToBottom?.();
    } catch {
      // Best-effort; repaint is the important part.
    }
  }
}

export function createTerminalRepaintScheduler(
  repaint: () => void,
  delayMs = 50,
): { schedule: () => void; dispose: () => void } {
  let raf: number | null = null;
  let timeout: number | null = null;

  const dispose = () => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (timeout !== null) {
      window.clearTimeout(timeout);
      timeout = null;
    }
  };

  const schedule = () => {
    dispose();
    repaint();
    raf = requestAnimationFrame(() => {
      raf = null;
      repaint();
    });
    timeout = window.setTimeout(() => {
      timeout = null;
      repaint();
    }, delayMs);
  };

  return { schedule, dispose };
}

/**
 * Whether a repaint is needed for a visibility transition. xterm's DOM renderer
 * skips row paints while its element has no layout box (background tab, hidden
 * kanban view, split/merge remount), so it must be forced to rebuild only when
 * the terminal comes back on-screen — not while it stays visible or hidden.
 */
export function shouldRepaintForVisibility(
  wasVisible: boolean,
  isVisible: boolean,
): boolean {
  return !wasVisible && isVisible;
}

/**
 * Repaint the terminal whenever it transitions from hidden to on-screen.
 *
 * The isActive and window-`focus` repaint effects miss the common case of
 * switching between in-app tabs while the window stays focused: no focus event
 * fires, and a long output burst accumulated while the tab was hidden leaves
 * the DOM renderer blank until the user scrolls. An IntersectionObserver reacts
 * to genuine on-screen visibility, so the forced repaint runs once the element
 * actually has a box.
 */
export function createTerminalVisibilityRepaintObserver(
  element: Element,
  repaint: () => void,
): { dispose: () => void } {
  if (typeof IntersectionObserver === "undefined") {
    return { dispose: () => {} };
  }
  let wasVisible = false;
  const observer = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const isVisible = entry.isIntersecting && entry.intersectionRatio > 0;
    if (shouldRepaintForVisibility(wasVisible, isVisible)) repaint();
    wasVisible = isVisible;
  });
  observer.observe(element);
  return {
    dispose: () => observer.disconnect(),
  };
}
