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
