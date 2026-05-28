export type ConversationNavigationDirection = "previous" | "next";

export const TERMINAL_CONVERSATION_NAV_EVENT =
  "acorn:terminal-conversation-nav";

export interface TerminalBufferLineLike {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface TerminalBufferLike {
  baseY: number;
  length: number;
  viewportY: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
}

export interface ContextPrompt {
  markerRow: number;
  prompt: string;
}

// Markers Claude TUI uses to introduce a user turn. v2.1.x renders `›`
// (U+203A); older versions used `>`; `❯` shows up in some shell-prompt
// theming. Matching any of these lets prompt navigation cope with
// claude version churn without code changes.
const PROMPT_MARKER_RE = /^[›>❯]\s+/u;
const TURN_BOUNDARY_RE = /^[●○*✱⏺·]\s/u;
const BOX_DRAWING_RE = /^[\s│╭╮╰╯─┃┏┓┗┛━]+/u;
const MAX_CONTEXT_WALK = 5000;
const MAX_NAVIGATION_WALK = 5000;
const MAX_CONTINUATION = 200;

function promptAtRow(buf: TerminalBufferLike, y: number): ContextPrompt | null {
  const line = buf.getLine(y);
  if (!line) return null;
  const raw = line.translateToString(true);
  const stripped = raw.replace(BOX_DRAWING_RE, "");
  const match = stripped.match(PROMPT_MARKER_RE);
  if (!match) return null;
  const headBody = stripped
    .slice(match[0].length)
    .replace(/\s*[│┃]?\s*$/u, "")
    .trim();
  if (headBody.length === 0) return null;
  const parts: string[] = [headBody];
  for (let yy = y + 1; yy <= y + MAX_CONTINUATION; yy++) {
    const cont = buf.getLine(yy);
    if (!cont) break;
    const contRaw = cont.translateToString(true);
    const trimmedTail = contRaw.replace(/\s+$/u, "");
    const contStripped = trimmedTail.replace(BOX_DRAWING_RE, "");
    if (PROMPT_MARKER_RE.test(contStripped)) break;
    if (TURN_BOUNDARY_RE.test(contStripped)) break;
    if (cont.isWrapped) {
      const wrapBody = contStripped.replace(/\s*[│┃]?\s*$/u, "");
      if (wrapBody.length > 0) parts.push(wrapBody);
      continue;
    }
    if (trimmedTail.length === 0) {
      parts.push("");
      continue;
    }
    if (/^\s{2,}/u.test(contRaw) && contStripped.length > 0) {
      parts.push(contStripped.replace(/\s*[│┃]?\s*$/u, ""));
      continue;
    }
    break;
  }
  while (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return { markerRow: y, prompt: parts.join("\n") };
}

/**
 * Walk xterm buffer rows upwards from `startY` to find the nearest
 * user-prompt marker, then collect continuation rows that belong to it.
 */
export function scanForContextPrompt(
  buf: TerminalBufferLike,
  startY: number,
): ContextPrompt | null {
  const from = Math.min(Math.max(0, Math.floor(startY)), buf.length - 1);
  const limit = Math.max(0, from - MAX_CONTEXT_WALK);
  for (let y = from; y >= limit; y--) {
    const prompt = promptAtRow(buf, y);
    if (prompt) return prompt;
  }
  return null;
}

/**
 * Finds the prompt marker that should anchor previous/next conversation
 * navigation relative to the current viewport's top buffer row.
 */
export function findConversationPromptTarget(
  buf: TerminalBufferLike,
  direction: ConversationNavigationDirection,
  fromY = buf.viewportY,
): ContextPrompt | null {
  const from = Math.min(Math.max(0, Math.floor(fromY)), buf.length - 1);
  if (direction === "previous") {
    const limit = Math.max(0, from - MAX_NAVIGATION_WALK);
    for (let y = from - 1; y >= limit; y--) {
      const prompt = promptAtRow(buf, y);
      if (prompt) return prompt;
    }
    return null;
  }

  const limit = Math.min(buf.length - 1, from + MAX_NAVIGATION_WALK);
  for (let y = from + 1; y <= limit; y++) {
    const prompt = promptAtRow(buf, y);
    if (prompt) return prompt;
  }
  return null;
}
