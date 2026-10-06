/**
 * Off-screen "limbo" container used to keep terminal portal targets attached
 * to the document while no pane is currently displaying their session.
 *
 * The portal target div for each session must live in the document for
 * `createPortal` to render into it. When a session is not visible (other
 * workspace, or no pane has it active), we park its target div here. Moving
 * the div between this limbo and a pane body via `appendChild` does not
 * change the div's identity, which is what lets the portal preserve the
 * Terminal subtree across pane / project switches.
 */
let limboEl: HTMLDivElement | null = null;

export function getTerminalLimbo(): HTMLDivElement {
  if (limboEl && limboEl.isConnected) return limboEl;
  const el = document.createElement("div");
  el.dataset.acornTerminalLimbo = "true";
  // Keep non-zero dimensions so xterm's fit() can produce sensible cell
  // counts for terminals that haven't yet been displayed.
  el.style.position = "fixed";
  el.style.left = "-99999px";
  el.style.top = "0";
  el.style.width = "800px";
  el.style.height = "600px";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  limboEl = el;
  return el;
}

/**
 * True while `el` is parked in the off-screen limbo host. The limbo box is a
 * fixed 800x600, so fitting a terminal there resizes it (and SIGWINCHes the
 * PTY) to a geometry the user never sees; a live TUI redraws at that size and
 * xterm reflows the buffer again on the way back, shredding the frame.
 */
export function isParkedInTerminalLimbo(el: Element | null): boolean {
  return Boolean(el?.closest("[data-acorn-terminal-limbo]"));
}

/**
 * True when `el` has a non-zero CSS layout box. `display: none` ancestors
 * (the pane layout kept mounted in kanban and canvas) produce none, and a
 * flex child that has not been laid out yet can report a 0×0 rect.
 */
export function terminalElementHasLayoutBox(el: Element | null): boolean {
  if (!el) return false;
  const rects = el.getClientRects();
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects.item(index);
    if (rect && rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

/**
 * Whether FitAddon may measure this container and resize the PTY.
 *
 * A 0px parent becomes a 2×1 terminal, which SIGWINCHes the PTY and reflows
 * the scrollback. Limbo is the opposite: a real 800×600 box, measured once
 * before the terminal has ever been fitted on screen, then held.
 */
export function shouldFitTerminal(input: {
  parkedInLimbo: boolean;
  hasLayoutBox: boolean;
  fittedOnScreen: boolean;
}): boolean {
  if (!input.hasLayoutBox) return false;
  if (input.parkedInLimbo && input.fittedOnScreen) return false;
  return true;
}
