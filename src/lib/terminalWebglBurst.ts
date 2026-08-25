/**
 * Swap xterm onto the WebGL renderer only while a wheel-driven TUI scroll
 * burst is in flight, and drop back to the DOM renderer the moment the burst
 * goes quiet or IME composition begins.
 *
 * Why not WebGL always: the DOM renderer anchors xterm's hidden textarea and
 * our composition view at the cursor cell, and the IME tail view clones the
 * DOM renderer's resolved spans — all broken or unavailable under WebGL.
 * Why not DOM always: a full-repaint TUI (Claude Code's Ink renderer) emits
 * a whole truecolor frame per scroll tick, and WKWebView's DOM renderer
 * consumes those at ~35fps while one wheel notch asks for up to 8 of them
 * (measured in tests/e2e/terminal-scroll-perf.spec.ts). Scrolling is the one
 * moment the user cannot be mid-composition, so the burst window gets the
 * GPU and every other moment keeps DOM-renderer correctness.
 */

export interface WebglAddonHandle {
  dispose(): void;
  onContextLoss(listener: () => void): { dispose(): void };
}

export interface WebglBurstController {
  /** Call for every wheel event aimed at a TUI that owns the wheel. */
  noteWheel(): void;
  /** Call when IME composition renders; forces the DOM renderer back. */
  noteComposition(): void;
  isActive(): boolean;
  dispose(): void;
}

export function createWebglBurstController({
  loadAddon,
  isEligible,
  afterSwap,
  quietMs = 1500,
  now = () => performance.now(),
  setTimeoutFn = (cb, ms) => window.setTimeout(cb, ms),
  clearTimeoutFn = (h) => window.clearTimeout(h),
}: {
  /** Create and attach the addon. Throw or return null when WebGL is unavailable. */
  loadAddon: () => WebglAddonHandle | null;
  /** Gate checked at activation time (app owns wheel, not composing, opaque bg). */
  isEligible: () => boolean;
  /** Runs after each renderer swap so the caller can force a full repaint. */
  afterSwap: (active: boolean) => void;
  quietMs?: number;
  now?: () => number;
  setTimeoutFn?: (cb: () => void, ms: number) => number;
  clearTimeoutFn?: (h: number) => void;
}): WebglBurstController {
  let addon: WebglAddonHandle | null = null;
  let contextLoss: { dispose(): void } | null = null;
  let timer: number | null = null;
  let lastWheelAt = -Infinity;
  // A failed activation (no GL context, context loss) disables the feature
  // for this terminal's lifetime instead of retrying on every wheel event.
  let unavailable = false;
  let disposed = false;

  const deactivate = (swap: boolean) => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (!addon) return;
    contextLoss?.dispose();
    contextLoss = null;
    const current = addon;
    addon = null;
    try {
      current.dispose();
    } catch {
      // renderer teardown races terminal disposal; the DOM renderer takes
      // over either way.
    }
    if (swap && !disposed) afterSwap(false);
  };

  const armQuietTimer = () => {
    if (timer !== null) return;
    const remaining = Math.max(0, quietMs - (now() - lastWheelAt));
    timer = setTimeoutFn(() => {
      timer = null;
      if (!addon) return;
      if (now() - lastWheelAt >= quietMs) {
        deactivate(true);
      } else {
        armQuietTimer();
      }
    }, remaining || quietMs);
  };

  return {
    noteWheel() {
      if (disposed || unavailable) return;
      lastWheelAt = now();
      if (!addon) {
        if (!isEligible()) return;
        try {
          addon = loadAddon();
        } catch {
          addon = null;
        }
        if (!addon) {
          unavailable = true;
          return;
        }
        contextLoss = addon.onContextLoss(() => {
          unavailable = true;
          deactivate(true);
        });
        afterSwap(true);
      }
      armQuietTimer();
    },
    noteComposition() {
      if (addon) deactivate(true);
    },
    isActive() {
      return addon !== null;
    },
    dispose() {
      disposed = true;
      deactivate(false);
    },
  };
}
