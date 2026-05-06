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
