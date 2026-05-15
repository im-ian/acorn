import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Terminal as XTerm,
  type IBuffer,
  type ITheme,
  type IViewportRange,
} from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import type { BackgroundState } from "../lib/background";
import { visibleMultiInputSessionIds } from "../lib/multiInput";
import { registerScrollbackFlusher } from "../lib/scrollback-coordinator";
import {
  patchTerminalCellMeasurements,
  unpatchTerminalCellMeasurements,
} from "../lib/terminal-cjk-cell-width-addon";
import {
  prepareScrollbackForSave,
  RESTORE_MARKER_TEXT,
  shouldRestoreScrollback,
  stripRestoreMarkers,
} from "../lib/terminalScrollback";
import {
  useSettings,
  type TerminalLinkActivation,
} from "../lib/settings";
import { buildXtermTheme } from "../lib/terminalTheme";
import { useThemes, type ThemeMode } from "../lib/themes";
import { useToasts } from "../lib/toasts";
import {
  chooseWorktreeToAdoptAfterExit,
  type WorktreeAdoptionIntent,
} from "../lib/worktreeAdoption";
import { useAppStore } from "../store";
import { StickyUserPrompt } from "./StickyUserPrompt";
import { FloatingTooltip, type TooltipAnchorRect } from "./Tooltip";

interface TerminalProps {
  sessionId: string;
  cwd: string;
  /**
   * When the terminal is hidden behind another tab in the same pane and then
   * made visible again, the DOM renderer can leave the rows blank because it
   * skipped paints while CSS visibility was `hidden`. Toggling this prop on
   * activate triggers a `fit()` + `refresh()` cycle so the buffer redraws.
   */
  isActive?: boolean;
  isFocusedPane?: boolean;
}

interface PtyOutputPayload {
  data: string;
}

function readCssVar(name: string): string | null {
  if (typeof window === "undefined") return null;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name) || null
  );
}

// Current theme's mode (dark/light) drives the default ANSI palette so a
// light terminal background doesn't render yellow/green/brightWhite as
// near-invisible smudges. Theme authors override individual slots via the
// --color-term-* CSS variables read inside buildXtermTheme.
function currentThemeMode(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  const id = document.documentElement.getAttribute("data-acorn-theme");
  if (!id) return "dark";
  return useThemes.getState().themes.find((t) => t.id === id)?.mode ?? "dark";
}

function terminalBackgroundActive(background: BackgroundState): boolean {
  return Boolean(background.relativePath && background.applyToTerminal);
}

function makeXtermTheme(useTransparentBackground = false): ITheme {
  return buildXtermTheme({
    mode: currentThemeMode(),
    readVar: readCssVar,
    useTransparentBackground,
  });
}

const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

// Custom event the sticky-prompt banner listens to. Fired whenever the user
// scrolls the terminal so the banner can swap to the prompt "in scope" at
// the top of the viewport, then revert to the JSONL-latest prompt when the
// user scrolls back to live tail.
const CONTEXT_PROMPT_EVENT = "acorn:context-prompt";

interface ContextPromptDetail {
  sessionId: string;
  /** Prompt text to pin, or `null` to revert to JSONL-latest. */
  prompt: string | null;
}

// Markers Claude TUI uses to introduce a user turn. v2.1.x renders `›`
// (U+203A); older versions used `>`; `❯` shows up in some shell-prompt
// theming. Matching any of these lets the scroll-aware banner cope with
// claude version churn without code changes.
const PROMPT_MARKER_RE = /^[›>❯]\s+/u;
// Lines that look like the *start* of an assistant turn or another
// claude UI element — used to bound the continuation walk so a long
// stream of assistant output doesn't get spliced into the pinned prompt.
const TURN_BOUNDARY_RE = /^[●○*✱⏺·]\s/u;
const BOX_DRAWING_RE = /^[\s│╭╮╰╯─┃┏┓┗┛━]+/u;

/**
 * Walk xterm buffer rows upwards from `startY` to find the nearest
 * user-prompt marker line, then walk down to collect the rest of the
 * prompt body (continuation rows are either xterm wrap-continuations
 * or indented rows beneath the marker). The result is the full prompt
 * text the user typed, joined with `\n` between hard-wrapped rows so
 * the banner's `whitespace-pre-wrap` styling preserves line breaks.
 *
 * Returns `null` when no prompt line is reachable above the start row —
 * e.g. user scrolled past the top of scrollback, or the buffer contains
 * raw shell output rather than a claude conversation.
 */
function scanForContextPrompt(buf: IBuffer, startY: number): string | null {
  // Max walk distance. Bounded so a terminal with a massive scrollback
  // (claude conversations easily push tens of thousands of rows) doesn't
  // freeze the UI on every scroll event. 5000 rows ≈ the default xterm
  // scrollback limit (`scrollback: 5000` in this file).
  const MAX_WALK = 5000;
  const MAX_CONTINUATION = 200;
  const limit = Math.max(0, startY - MAX_WALK);
  for (let y = startY; y >= limit; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const raw = line.translateToString(true);
    const stripped = raw.replace(BOX_DRAWING_RE, "");
    const match = stripped.match(PROMPT_MARKER_RE);
    if (!match) continue;
    const headBody = stripped
      .slice(match[0].length)
      .replace(/\s*[│┃]?\s*$/u, "")
      .trim();
    if (headBody.length === 0) continue;
    const parts: string[] = [headBody];
    for (let yy = y + 1; yy <= y + MAX_CONTINUATION; yy++) {
      const cont = buf.getLine(yy);
      if (!cont) break;
      const contRaw = cont.translateToString(true);
      // Use the raw line (not the box-stripped form) to detect "blank-ish"
      // continuation gutters that still belong to the same turn.
      const trimmedTail = contRaw.replace(/\s+$/u, "");
      const contStripped = trimmedTail.replace(BOX_DRAWING_RE, "");
      // Hit the next prompt marker → previous user turn ended.
      if (PROMPT_MARKER_RE.test(contStripped)) break;
      // Hit an assistant or other turn-class marker.
      if (TURN_BOUNDARY_RE.test(contStripped)) break;
      // An xterm wrap-continuation row is unambiguously the same logical
      // line, so always accept it.
      if (cont.isWrapped) {
        const wrapBody = contStripped.replace(/\s*[│┃]?\s*$/u, "");
        if (wrapBody.length > 0) parts.push(wrapBody);
        continue;
      }
      // Hard-wrapped continuation rows in claude's TUI keep a leading
      // indent (so the body lines up under the `> ` marker). Accept
      // rows whose first non-whitespace column matches the marker's,
      // and bail on anything that looks like a new gutter / divider.
      if (trimmedTail.length === 0) {
        // Single blank row inside a long pasted prompt is part of the
        // same turn (the user pressed Enter twice). Treat as line
        // break, keep collecting.
        parts.push("");
        continue;
      }
      if (/^\s{2,}/u.test(contRaw) && contStripped.length > 0) {
        parts.push(contStripped.replace(/\s*[│┃]?\s*$/u, ""));
        continue;
      }
      break;
    }
    // Strip trailing blank-string entries the loop may have collected
    // before hitting the boundary.
    while (parts.length > 0 && parts[parts.length - 1] === "") {
      parts.pop();
    }
    return parts.join("\n");
  }
  return null;
}

// macOS uses Cmd (metaKey); other platforms use Ctrl. Matches the
// platform-primary modifier `tinykeys` resolves `$mod` to.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|od|ad)/.test(navigator.platform);
const MODIFIER_LINK_LABEL = IS_MAC ? "Command-click" : "Ctrl-click";

interface TerminalRenderInternals {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            width: number;
            height: number;
          };
        };
      };
    };
  };
}

function modifierHeld(event: MouseEvent): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

function terminalCellDims(term: XTerm): { width: number; height: number } | null {
  const core = (term as unknown as TerminalRenderInternals)._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  return cell ? { width: cell.width, height: cell.height } : null;
}

function textRangeRectForColumns(
  rowElement: HTMLElement,
  startCol: number,
  endCol: number,
): DOMRect | null {
  const doc = rowElement.ownerDocument;
  const walker = doc.createTreeWalker(rowElement, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let offset = 0;
  let startSet = false;
  let endSet = false;

  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const textLength = node.textContent?.length ?? 0;
    const nextOffset = offset + textLength;
    if (!startSet && startCol <= nextOffset) {
      range.setStart(node, Math.max(0, startCol - offset));
      startSet = true;
    }
    if (startSet && endCol <= nextOffset) {
      range.setEnd(node, Math.max(0, endCol - offset));
      endSet = true;
      break;
    }
    offset = nextOffset;
  }

  if (!startSet || !endSet) {
    range.detach();
    return null;
  }

  const rect = range.getBoundingClientRect();
  range.detach();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function unionRects(rects: DOMRect[]): TooltipAnchorRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
  };
}

function hoveredLinkAnchorRect(container: HTMLElement): TooltipAnchorRect | null {
  const rects = Array.from(
    container.querySelectorAll<HTMLElement>(".xterm-rows span"),
  )
    .filter((el) => {
      const style = getComputedStyle(el);
      return style.textDecorationLine.includes("underline");
    })
    .map((el) => el.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  return unionRects(rects);
}

function linkRangeAnchorRect(
  container: HTMLElement,
  term: XTerm,
  range: IViewportRange,
): TooltipAnchorRect | null {
  const cell = terminalCellDims(term);
  if (!cell) return null;
  const viewportY = term.buffer.active.viewportY;

  const startViewportY = range.start.y - viewportY - 1;
  const endViewportY = range.end.y - viewportY - 1;
  if (endViewportY < 0 || startViewportY >= term.rows) return null;

  const row = Math.max(0, Math.min(term.rows - 1, startViewportY));
  const rowElements = Array.from(
    container.querySelectorAll<HTMLElement>(".xterm-rows > div"),
  );
  const textRects: DOMRect[] = [];
  const firstVisibleRow = Math.max(0, startViewportY);
  const lastVisibleRow = Math.min(term.rows - 1, endViewportY);
  for (let y = firstVisibleRow; y <= lastVisibleRow; y++) {
    const rowElement = rowElements[y];
    if (!rowElement) continue;
    const startCol = y === startViewportY ? Math.max(0, range.start.x - 1) : 0;
    const endCol =
      y === endViewportY
        ? Math.max(startCol + 1, Math.min(term.cols, range.end.x))
        : term.cols;
    const rect = textRangeRectForColumns(rowElement, startCol, endCol);
    if (rect) textRects.push(rect);
  }
  const textRect = unionRects(textRects);
  if (textRect) return textRect;

  const rowElement = rowElements[row];
  const rowRect =
    rowElement?.getBoundingClientRect() ??
    (
      container.querySelector<HTMLElement>(".xterm-screen") ?? container
    ).getBoundingClientRect();
  const startX = startViewportY < 0 ? 0 : Math.max(0, range.start.x - 1);
  const endX =
    row === endViewportY
      ? Math.max(startX + 1, Math.min(term.cols, range.end.x))
      : term.cols;
  const left = rowRect.left + startX * cell.width;
  const top = rowElement ? rowRect.top : rowRect.top + row * cell.height;
  const right = rowRect.left + endX * cell.width;
  const bottom = rowElement ? rowRect.bottom : top + cell.height;
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
  };
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeStringToBase64(input: string): string {
  // btoa expects latin-1; encode UTF-8 first to avoid loss for multi-byte input.
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function Terminal({
  sessionId,
  cwd,
  isActive = true,
  isFocusedPane = true,
}: TerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [linkTooltip, setLinkTooltip] = useState<{
    anchorRect: TooltipAnchorRect;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Snapshot terminal font preferences at mount; subsequent setting changes
    // are applied live via the subscription below.
    const initialSettings = useSettings.getState().settings;
    const term = new XTerm({
      theme: makeXtermTheme(
        terminalBackgroundActive(initialSettings.appearance.background),
      ),
      allowTransparency: true,
      fontFamily: initialSettings.terminal.fontFamily,
      fontSize: initialSettings.terminal.fontSize,
      fontWeight: initialSettings.terminal.fontWeight,
      fontWeightBold: initialSettings.terminal.fontWeightBold,
      lineHeight: initialSettings.terminal.lineHeight,
      cursorBlink: isFocusedPane,
      allowProposedApi: true,
      scrollback: 5000,
      // `convertEol` rewrites every bare `\n` from the PTY into `\r\n` before
      // the parser sees it. A real shell already emits `\r\n` for line
      // breaks, but interactive plugins (zsh-autosuggestions, prompt
      // redraws) also emit bare `\n` as "move cursor down one row, keep
      // column" — bracketed by `\e7`/`\e8` (DECSC/DECRC) save/restore. With
      // `convertEol: true` that bare LF gains a phantom CR, so the cursor
      // jumps to column 0 mid-redraw; the following save/restore pair lands
      // at the wrong x and subsequent shell echo overwrites previously
      // rendered cells (e.g. the prompt user "jthefloor" renders as
      // "rhefloor"). PTY output is the only writer here, so `false` is the
      // correct setting.
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    // Tracks the current link-activation setting so the addon callback below
    // sees live changes without rebuilding the terminal.
    let linkActivation: TerminalLinkActivation =
      initialSettings.terminal.linkActivation;
    // Hand link clicks to the OS so URLs open in the user's default browser
    // instead of trying to navigate the Tauri WebView (which is gated by the
    // app's CSP and would either fail or replace the app shell). When the user
    // opts into modifier-click activation, plain clicks are swallowed so a
    // stray click on a URL in shell output doesn't steal focus.
    let linkTooltipFrame: number | null = null;
    const showLinkTooltip = (range: IViewportRange) => {
      if (linkTooltipFrame !== null) {
        cancelAnimationFrame(linkTooltipFrame);
      }
      linkTooltipFrame = requestAnimationFrame(() => {
        linkTooltipFrame = null;
        if (linkActivation !== "modifier-click") return;
        const anchorRect =
          hoveredLinkAnchorRect(container) ??
          linkRangeAnchorRect(container, term, range);
        if (!anchorRect) return;
        setLinkTooltip({ anchorRect });
      });
    };
    const hideLinkTooltip = () => {
      if (linkTooltipFrame !== null) {
        cancelAnimationFrame(linkTooltipFrame);
        linkTooltipFrame = null;
      }
      setLinkTooltip(null);
    };
    const webLinksAddon = new WebLinksAddon(
      (event, uri) => {
        event.preventDefault();
        hideLinkTooltip();
        if (linkActivation === "modifier-click" && !modifierHeld(event)) return;
        void openUrl(uri).catch((err: unknown) => {
          console.error("failed to open terminal link", uri, err);
        });
      },
      {
        hover: (_event, _uri, range) => {
          if (linkActivation !== "modifier-click") return;
          showLinkTooltip(range);
        },
        leave: () => {
          hideLinkTooltip();
        },
      },
    );
    const serializeAddon = new SerializeAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(serializeAddon);
    term.loadAddon(unicode11Addon);
    // xterm.js defaults to Unicode 6 width tables that treat most emoji as
    // width 1. The glyph then overflows its cell and adjacent cells overwrite
    // it, producing the half-rendered / crammed look. Unicode 11 tables mark
    // modern emoji as width 2 so cell allocation matches the glyph footprint.
    term.unicode.activeVersion = "11";
    termRef.current = term;
    fitRef.current = fitAddon;

    // The DOM renderer (default) anchors xterm's hidden textarea at the
    // cursor cell, so IME composition popups (CJK input) render at the
    // correct location and intermediate characters are not flushed to the
    // PTY mid-composition. The canvas/webgl addons are faster but mis-handle
    // composition events on macOS/Linux IMEs — we pick correctness over fps.
    term.open(container);
    const fitWithCellMeasurements = () => {
      const cjkEnabled =
        useSettings.getState().settings.experiments.cjkCellWidthHeuristic;
      if (cjkEnabled) patchTerminalCellMeasurements(term);
      fitAddon.fit();
      if (cjkEnabled) patchTerminalCellMeasurements(term);
    };
    try {
      fitWithCellMeasurements();
    } catch {
      // initial fit can fail if container has zero size; ResizeObserver will retry.
    }

    let themeFrame: number | null = null;
    const scheduleThemeRefresh = () => {
      if (themeFrame !== null) {
        cancelAnimationFrame(themeFrame);
      }
      themeFrame = requestAnimationFrame(() => {
        themeFrame = null;
        term.options.theme = makeXtermTheme(
          terminalBackgroundActive(
            useSettings.getState().settings.appearance.background,
          ),
        );
        try {
          fitAddon.fit();
        } catch {
          // ignore — ResizeObserver will retry
        }
      });
    };
    scheduleThemeRefresh();

    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];
    let observedLinkedWorktreePath: string | null = null;
    let liveCwdProbeTimer: number | null = null;
    let restoredDiskScrollback = false;

    const rememberLinkedWorktreeCwd = (path: string, source: string) => {
      void api
        .linkedWorktreeRoot(path)
        .then((root) => {
          if (disposed) return;
          useAppStore.setState((s) => ({
            liveInWorktree: { ...s.liveInWorktree, [sessionId]: Boolean(root) },
          }));
          if (root) {
            observedLinkedWorktreePath = root;
          }
        })
        .catch((err: unknown) => {
          console.debug(`[Terminal] ${source} linked-worktree probe failed`, err);
        });
    };

    const scheduleLiveCwdProbe = () => {
      if (disposed || liveCwdProbeTimer !== null) return;
      liveCwdProbeTimer = window.setTimeout(() => {
        liveCwdProbeTimer = null;
        if (disposed) return;
        void api
          .ptyCwd(sessionId)
          .then((liveCwd) => {
            if (liveCwd && !disposed) {
              rememberLinkedWorktreeCwd(liveCwd, "pty-cwd");
            }
          })
          .catch((err: unknown) => {
            console.debug("[Terminal] pty_cwd probe failed", err);
          });
      }, 500);
    };

    // OSC 7 cwd tracking. The shell rc we inject via ZDOTDIR emits
    // `\e]7;file://<host><pwd>\e\\` on every prompt. xterm's parser hands
    // us the inner payload (everything between `\e]7;` and the terminator)
    // — strip the `file://[host]` prefix, percent-decode, resolve linked
    // worktree roots via the backend, and update the live-cwd store entry
    // for this session. A resolved root is also remembered as an adoption
    // candidate for commands that created and entered a fresh worktree.
    // Returning `true` claims the sequence so xterm doesn't echo it.
    term.parser.registerOscHandler(7, (data) => {
      const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (!match) return false;
      let path: string;
      try {
        path = decodeURIComponent(match[1]);
      } catch {
        return false;
      }
      rememberLinkedWorktreeCwd(path, "osc7");
      return true;
    });

    // Live-apply terminal font setting changes without reinitialising xterm.
    const unsubSettings = useSettings.subscribe((state, prev) => {
      const next = state.settings.terminal;
      const previous = prev.settings.terminal;
      let changed = false;
      if (next.fontFamily !== previous.fontFamily) {
        term.options.fontFamily = next.fontFamily;
        changed = true;
      }
      if (next.fontSize !== previous.fontSize) {
        term.options.fontSize = next.fontSize;
        changed = true;
      }
      if (next.fontWeight !== previous.fontWeight) {
        term.options.fontWeight = next.fontWeight;
        changed = true;
      }
      if (next.fontWeightBold !== previous.fontWeightBold) {
        term.options.fontWeightBold = next.fontWeightBold;
        changed = true;
      }
      if (next.lineHeight !== previous.lineHeight) {
        term.options.lineHeight = next.lineHeight;
        changed = true;
      }
      if (next.linkActivation !== previous.linkActivation) {
        linkActivation = next.linkActivation;
        if (next.linkActivation !== "modifier-click") {
          setLinkTooltip(null);
        }
      }
      if (state.settings.appearance.themeId !== prev.settings.appearance.themeId) {
        scheduleThemeRefresh();
      }
      const cjkNow = state.settings.experiments.cjkCellWidthHeuristic;
      const cjkPrev = prev.settings.experiments.cjkCellWidthHeuristic;
      if (cjkNow !== cjkPrev) {
        if (cjkNow) {
          patchTerminalCellMeasurements(term);
        } else {
          unpatchTerminalCellMeasurements(term);
        }
      }
      const nextBackground = state.settings.appearance.background;
      const previousBackground = prev.settings.appearance.background;
      if (
        nextBackground.relativePath !== previousBackground.relativePath ||
        nextBackground.applyToTerminal !== previousBackground.applyToTerminal
      ) {
        scheduleThemeRefresh();
      }
      if (changed) {
        try {
          fitWithCellMeasurements();
        } catch {
          // ignore — ResizeObserver will retry
        }
      }
    });

    // `scrollback_load` must finish before any save is allowed. Without
    // this gate, React.StrictMode's mount → cleanup → mount cycle in dev
    // can race the cleanup of mount A against mount A's load: the
    // cleanup serialises the still-empty xterm buffer and writes 0
    // bytes to disk, wiping the previously persisted scrollback. By the
    // time mount B's load runs, the disk content is already gone. The
    // flag flips to `true` only after the initial load step settles, so
    // earlier serialise calls (whether from the debounced output trigger
    // or from `flushAllScrollbacks` on app close) become no-ops.
    let savesAllowed = false;

    // Debounced "save scrollback to disk" trigger. Reset on every chunk
    // of PTY output so a stream of bytes coalesces into one save 1s
    // after the stream goes quiet, instead of one save per chunk.
    const SCROLLBACK_SAVE_DEBOUNCE_MS = 1000;
    let scrollbackSaveTimer: number | null = null;
    const scheduleScrollbackSave = () => {
      if (disposed) return;
      if (scrollbackSaveTimer !== null) {
        window.clearTimeout(scrollbackSaveTimer);
      }
      scrollbackSaveTimer = window.setTimeout(() => {
        scrollbackSaveTimer = null;
        // persistScrollbackAsync is hoisted as a function declaration in
        // the IIFE region below; calling it here at runtime is safe.
        void persistScrollbackAsync();
      }, SCROLLBACK_SAVE_DEBOUNCE_MS);
    };

    // Force viewport repaints around PTY output bursts.
    //
    // xterm's DOM renderer reuses per-row DOM elements and incrementally
    // patches glyphs as the buffer changes. When a streaming TUI (Claude
    // CLI, `htop`, `claude --print`) is mid-redraw — or interrupted by
    // Esc/Ctrl+C — the parser can settle with stale cursor/cell DOM left
    // from an earlier frame. The xterm buffer is correct
    // (copy-to-clipboard yields clean text); only the DOM rendition is
    // stale. Forcing `refresh(0, rows-1)` rebuilds every visible row from
    // the buffer, which clears leftover characters and cursor blocks.
    //
    // We run one rAF-throttled refresh after each parsed write for live
    // interactive redraws (notably Claude's slash-command picker), plus
    // an idle refresh after the burst goes quiet to catch interrupted
    // final frames.
    const VIEWPORT_REPAINT_IDLE_MS = 120;
    let viewportRepaintTimer: number | null = null;
    let viewportRepaintFrame: number | null = null;
    const repaintViewport = () => {
      if (disposed) return;
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore — terminal may have been disposed between scheduling
        // and reaching the call.
      }
    };
    const scheduleViewportFrameRepaint = () => {
      if (disposed || viewportRepaintFrame !== null) return;
      viewportRepaintFrame = requestAnimationFrame(() => {
        viewportRepaintFrame = null;
        repaintViewport();
      });
    };
    const scheduleViewportIdleRepaint = () => {
      if (disposed) return;
      if (viewportRepaintTimer !== null) {
        window.clearTimeout(viewportRepaintTimer);
      }
      viewportRepaintTimer = window.setTimeout(() => {
        viewportRepaintTimer = null;
        repaintViewport();
      }, VIEWPORT_REPAINT_IDLE_MS);
    };

    const writeToPty = (targetSessionId: string, data: string) => {
      if (data.length === 0) return;
      invoke("pty_write", {
        sessionId: targetSessionId,
        data: encodeStringToBase64(data),
      }).catch((err: unknown) => {
        console.error("[Terminal] pty_write failed", err);
      });
    };
    const sendToPty = (data: string) => {
      writeToPty(sessionId, data);
    };
    const sendUserInputToPty = (data: string) => {
      if (data.length === 0) return;
      const state = useAppStore.getState();
      const targets = state.multiInputEnabled
        ? visibleMultiInputSessionIds(state.panes)
        : [sessionId];
      const targetIds = targets.length > 0 ? targets : [sessionId];
      for (const targetId of targetIds) {
        writeToPty(targetId, data);
      }
    };

    // CJK IME path. xterm.js's built-in handler only processes plain
    // `insertText`, so Korean/Japanese/Chinese commits delivered as
    // W3C composition InputEvents on the helper textarea never reach
    // the PTY. We intercept those events ourselves and render the
    // live preview through xterm's hidden `.composition-view` element.
    const compositionView = container.querySelector<HTMLElement>(
      ".composition-view",
    );
    const getCellDims = (): { width: number; height: number } | null => {
      // xterm v6 exposes render dimensions only via internals.
      const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })
        ._core;
      const cell = core?._renderService?.dimensions?.css?.cell;
      return cell ? { width: cell.width, height: cell.height } : null;
    };
    const showComposing = (text: string) => {
      if (!compositionView) return;
      if (text.length === 0) {
        compositionView.classList.remove("active");
        compositionView.textContent = "";
        return;
      }
      const cell = getCellDims();
      compositionView.textContent = text;
      if (cell) {
        const buf = term.buffer.active;
        // xterm's visible cursor row = `baseY + cursorY - viewportY`
        // (mirrors xterm's own `Buffer.ts`: `absoluteY = ybase + y;
        // relativeY = absoluteY - ydisp`). `cursorY` is the cursor's
        // offset within the current page (0..rows-1), `baseY` is the
        // buffer line where that page starts, and `viewportY` is the
        // buffer line currently shown at the top of the viewport (they
        // diverge when the user scrolls into scrollback). Subtracting
        // `viewportY` alone — without adding `baseY` — leaves a session
        // with non-empty scrollback computing `cursorY - viewportY ≈
        // -ybase`, parking the overlay thousands of pixels above the
        // visible terminal so the preview vanishes off-screen.
        const cursorViewportY = buf.baseY + buf.cursorY - buf.viewportY;
        compositionView.style.left = `${buf.cursorX * cell.width}px`;
        compositionView.style.top = `${cursorViewportY * cell.height}px`;
        compositionView.style.minHeight = `${cell.height}px`;
        compositionView.style.lineHeight = `${cell.height}px`;
      }
      // Sync font with the current xterm options so the preview uses the
      // user's configured terminal font/size, not the default sans inherited
      // from the parent.
      const fontFamily = term.options.fontFamily;
      const fontSize = term.options.fontSize;
      const fontWeight = term.options.fontWeight;
      if (typeof fontFamily === "string") {
        compositionView.style.fontFamily = fontFamily;
      }
      if (typeof fontSize === "number") {
        compositionView.style.fontSize = `${fontSize}px`;
      }
      if (typeof fontWeight === "number" || typeof fontWeight === "string") {
        compositionView.style.fontWeight = String(fontWeight);
      }
      compositionView.classList.add("active");
    };
    const hideComposing = () => {
      if (!compositionView) return;
      compositionView.classList.remove("active");
      compositionView.textContent = "";
    };

    // WKWebView delivers a single Korean syllable across a mix of
    // input types within one composition:
    //
    //   insertCompositionText   preview (ev.data = composed text)
    //   insertReplacementText   preview when trailing char recomposes
    //   insertText  (IME flag)  preview + per-syllable diff-commit
    //   insertFromComposition   final commit (ev.data = full syllable)
    //
    // Terminator keys (space/Enter/…) may finalize without firing
    // `insertFromComposition` at all. To stay correct under any
    // delivery, one `composing` flag routes every commit
    // (terminator-keydown OR insertFromComposition) through a single
    // idempotent `commitComposition()` — a second call for the same
    // syllable becomes a no-op.
    let sentPrefix = "";
    let lastKeyCode229 = false;
    let composing = false;
    // Hangul jamo, Hangul syllables, Hiragana, Katakana, CJK ideographs.
    // Used to recognise IME-driven `insertText` events even when the
    // accompanying `keydown` (with keyCode 229) hasn't fired yet — on
    // WKWebView the `input` event sometimes arrives BEFORE its keydown.
    const CJK_DATA_RE =
      /[ᄀ-ᇿ㄰-㆏가-힯぀-ゟ゠-ヿ一-鿿]/;

    // Idempotent commit. Sends whatever sits past `sentPrefix` in the
    // helper textarea (the unflushed trailing syllable), then resets state.
    // `explicit` overrides the textarea slice — used by
    // `insertFromComposition` when WKWebView delivers the syllable as
    // `ev.data` rather than leaving it in the textarea.
    const commitComposition = (explicit?: string) => {
      if (!composing) return;
      const ta = container.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      const tail = ta && ta.value.length > sentPrefix.length
        ? ta.value.slice(sentPrefix.length)
        : "";
      const data = tail || explicit || "";
      if (data) sendUserInputToPty(data);
      if (ta) ta.value = "";
      sentPrefix = "";
      composing = false;
      hideComposing();
    };

    const onInput = (e: Event) => {
      const ev = e as InputEvent;
      const ta = container.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      switch (ev.inputType) {
        case "insertCompositionText":
          composing = true;
          showComposing(ev.data ?? "");
          ev.stopImmediatePropagation();
          return;

        case "deleteCompositionText":
          // Preview clear preceding a commit. No-op.
          ev.stopImmediatePropagation();
          return;

        case "insertReplacementText": {
          // Trailing char being recomposed in place. Preview only — never
          // commit here, the next insertText / insertFromComposition /
          // terminator-keydown carries the commit.
          composing = true;
          if (ta) {
            // Stale sentPrefix detection: if textarea no longer starts
            // with the prefix we tracked, a non-IME keystroke (Space,
            // Ctrl+C, …) reset the textarea between compositions.
            if (!ta.value.startsWith(sentPrefix)) sentPrefix = "";
            showComposing(ta.value.slice(sentPrefix.length));
          }
          ev.stopImmediatePropagation();
          return;
        }

        case "insertText": {
          // Distinguish plain ASCII from an IME first-jamo: treat as
          // IME when a keyCode-229 keydown was just observed OR
          // `ev.data` is a CJK character. The data check covers the
          // first jamo of a session when WKWebView fires `input`
          // before the corresponding keydown.
          const isIme =
            lastKeyCode229 || (!!ev.data && CJK_DATA_RE.test(ev.data));
          if (!isIme) {
            // Plain ASCII. xterm's keypress already emitted it; we
            // only advance `sentPrefix` so the next IME insertText
            // diff doesn't re-emit it as part of its committed prefix.
            hideComposing();
            composing = false;
            if (ta) sentPrefix = ta.value;
            return;
          }
          composing = true;
          if (!ta) return;
          const value = ta.value;
          const newCharLen = ev.data?.length ?? 0;
          // If textarea no longer starts with our tracked prefix, a
          // non-IME keystroke (Space, Ctrl+C, …) reset the textarea
          // between compositions. Reset so the slice below doesn't
          // drop the first jamo of the fresh composition.
          if (!value.startsWith(sentPrefix)) {
            sentPrefix = value.slice(0, Math.max(0, value.length - newCharLen));
          }
          const committedEnd = value.length - newCharLen;
          if (committedEnd > sentPrefix.length) {
            sendUserInputToPty(value.slice(sentPrefix.length, committedEnd));
            sentPrefix = value.slice(0, committedEnd);
          }
          showComposing(value.slice(sentPrefix.length));
          ev.stopImmediatePropagation();
          return;
        }

        case "insertFromComposition":
          // Final commit from composition-clean IME path. Idempotent —
          // if a terminator-keydown already flushed this syllable,
          // `composing` is false and this is a no-op.
          commitComposition(ev.data ?? undefined);
          ev.stopImmediatePropagation();
          return;

        default:
          hideComposing();
          return;
      }
    };

    const onKeydown = (e: Event) => {
      const ev = e as KeyboardEvent;
      // keyCode 229 = IME composing key. xterm's keydown reacts to
      // 229 with a `_handleAnyTextareaChanges` setTimeout that would
      // emit duplicate text — swallow at capture, and remember the
      // flag so a following `insertText` is recognised as an IME
      // jamo when its CJK-data check is ambiguous.
      //
      // macOS reports 229 even for the terminator keystroke that
      // finalizes the composition (space, Enter, …) when IME state
      // is uncommitted. Those must NOT take the IME path or the
      // follow-up `input` event re-emits the terminator on top of
      // xterm's keypress emit. Detect named non-printable keys +
      // actual whitespace as terminators and fall through to the
      // plain path. Letter/digit/punctuation keys keep the IME
      // path because the Korean 2-set IME reports them with
      // `ev.key` set to underlying ASCII (e.g. shift+ㅅ → key="T"),
      // and treating those as terminators flushes mid-syllable.
      if (ev.keyCode === 229) {
        const ta229 = container.querySelector<HTMLTextAreaElement>(
          ".xterm-helper-textarea",
        );
        const hasComposition = !!ta229?.value;
        // Backspace inside active composition is internal IME
        // editing (e.g. "있" → "이"); the `input` event already
        // updated the preview. Suppress xterm's \x7f emit so the
        // committed glyph doesn't race the backspace into the line.
        // Backspace WITHOUT composition falls through to the plain
        // path via TERMINATOR_KEYS below.
        if (ev.key === "Backspace" && hasComposition) {
          if (ta229) showComposing(ta229.value.slice(sentPrefix.length));
          lastKeyCode229 = true;
          ev.stopImmediatePropagation();
          return;
        }
        const TERMINATOR_KEYS = new Set([
          "Enter", "Tab", "Escape", "Backspace", " ", "Spacebar",
        ]);
        const isTerminator = TERMINATOR_KEYS.has(ev.key);
        if (!isTerminator) {
          lastKeyCode229 = true;
          ev.stopImmediatePropagation();
          return;
        }
        // Terminator under IME falls through; the prior syllable
        // still needs flushing, which happens below because
        // `lastKeyCode229` remains true from the real IME keydown.
      }
      // Modifier-only keystrokes are part of a chord, not a real
      // key. Must NOT flush mid-composition or clear lastKeyCode229
      // — Korean 2-set IME emits Shift before the second jamo of
      // a double consonant, and flushing here would commit the
      // prior syllable before the second jamo can combine.
      const MODIFIER_KEYS = new Set([
        "Shift", "Control", "Alt", "Meta", "CapsLock",
      ]);
      if (MODIFIER_KEYS.has(ev.key)) {
        return;
      }
      // Non-IME key after IME activity. Commit any mid-composition
      // syllable so it lands in the PTY before this key's effect
      // (space, Enter, English letter, …). Idempotent — a follow-up
      // `insertFromComposition` for the same syllable hits the
      // composing===false guard and is a no-op.
      if (lastKeyCode229 && composing) {
        commitComposition();
      }
      lastKeyCode229 = false;
      const ta = container.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (ta) sentPrefix = ta.value;

      // Shift+Enter: insert newline (LF) instead of submitting (CR). xterm
      // by default emits \r for both Enter and Shift+Enter, so TUIs like
      // Claude CLI cannot tell them apart. Send a literal LF and stop the
      // event so xterm does not emit its own \r on top.
      if (ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        sendUserInputToPty("\n");
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      // macOS line-navigation conventions. Cmd+Left / Cmd+Right map to the
      // emacs-style readline shortcuts that nearly every interactive shell
      // honours: Ctrl+A (start of line) and Ctrl+E (end of line).
      if (
        ev.metaKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.shiftKey
      ) {
        if (ev.key === "ArrowLeft") {
          sendUserInputToPty("\x01");
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
        if (ev.key === "ArrowRight") {
          sendUserInputToPty("\x05");
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
      }
    };

    // Register on `container` (ancestor of helperTextarea) with capture=true
    // so we run before xterm's textarea-capture listeners.
    container.addEventListener("input", onInput, true);
    container.addEventListener("keydown", onKeydown, true);

    // Own the paste path for text. xterm's built-in listener emits the
    // pasted text but only calls `stopPropagation()` — it never
    // `preventDefault()`s, so the browser's default action still
    // re-inserts the text into the helper textarea. That residue
    // collides with the IME composition tracker, which on the next
    // terminator keystroke would slice it out of the textarea as
    // an "uncommitted preview" and re-emit it to the PTY.
    //
    // Intercept at capture phase: read clipboardData ourselves and
    // hand it to `term.paste()`, which routes through xterm's
    // onData (with bracketed-paste wrapping intact when the PTY
    // enabled the mode) and clears the textarea. `preventDefault`
    // blocks the browser reinsertion; `stopImmediatePropagation`
    // blocks xterm's listener so the data emits exactly once.
    //
    // Skip this path when the clipboard carries an image-only
    // payload (macOS screencapture, copy-image-from-browser). The
    // WKWebView's native paste relays the underlying NSPasteboard
    // image to the running CLI (Claude Code surfaces it as
    // `[Image #N]`), which only works if we let the default
    // action proceed. Text-mixed payloads still take the owned
    // path because the textarea residue + IME race outweighs the
    // image relay there.
    const onPaste = (e: Event) => {
      const ev = e as ClipboardEvent;
      const cd = ev.clipboardData;
      const text = cd?.getData("text/plain") ?? "";
      const hasFiles = (cd?.files?.length ?? 0) > 0;
      if (!text && hasFiles) return;
      if (text) term.paste(text);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    container.addEventListener("paste", onPaste, true);

    // Swallow xterm's compositionstart/update/end. Its compositionend
    // handler re-emits the entire textarea contents on top of the
    // per-syllable PTY writes our `onInput` path already issued,
    // duplicating the composed phrase. Our `onInput` covers preview,
    // partial commits, and final commit through `commitComposition()`,
    // so xterm's path is pure duplication.
    const swallowComposition = (e: Event) => {
      e.stopImmediatePropagation();
    };
    container.addEventListener("compositionstart", swallowComposition, true);
    container.addEventListener("compositionupdate", swallowComposition, true);
    container.addEventListener("compositionend", swallowComposition, true);

    const inputDisposable = term.onData((data: string) => {
      sendUserInputToPty(data);
    });

    // Re-anchor the composition preview to the cursor on every xterm render.
    // The cursor advances asynchronously after a commit (PTY echo → emit →
    // term.write); without this, the preview stays painted at the previous
    // cursor cell and visually appears one column to the left of the new
    // cursor until the user types again.
    const repositionComposing = () => {
      if (!compositionView || !compositionView.classList.contains("active")) {
        return;
      }
      const cell = getCellDims();
      if (!cell) return;
      const buf = term.buffer.active;
      // See `showComposing` for the full derivation of this formula.
      const cursorViewportY = buf.baseY + buf.cursorY - buf.viewportY;
      compositionView.style.left = `${buf.cursorX * cell.width}px`;
      compositionView.style.top = `${cursorViewportY * cell.height}px`;
    };
    const renderDisposable = term.onRender(repositionComposing);
    // PTY output that arrives while the user is mid-composition can scroll
    // the viewport or move the prompt to a new row without producing an
    // `onRender` event whose painted region overlaps the cursor cell — the
    // overlay then stays pinned to the old screen coords and visually drifts
    // away from the live prompt. `onScroll` fires on viewport shifts and
    // `onCursorMove` fires when the shell redraws its prompt at a new row;
    // both feed the same recompute so the overlay tracks the cursor.
    const scrollDisposable = term.onScroll(repositionComposing);
    const cursorMoveDisposable = term.onCursorMove(repositionComposing);

    // Sticky-prompt detection. The banner above the terminal pins the
    // most recent user-prompt line found in xterm's rendered buffer
    // at-or-above the topmost-visible row. Detection is buffer-only —
    // a Cmd+K clear empties the buffer and the dispatch naturally
    // settles to `null`, hiding the banner without any side-channel
    // bookkeeping. Triggers:
    //   - scroll          (user navigates scrollback)
    //   - PTY output      (a new turn just landed)
    //   - terminal clear  (buffer wiped)
    // All three coalesce through a single rAF so a flurry of events
    // emits one buffer scan + one dispatch per animation frame.
    //
    // The Experiments → "Pin last user prompt" toggle short-circuits
    // every dispatch when off, AND emits a one-shot `null` so a banner
    // already showing from a prior render disappears immediately.
    let contextDispatchPending = false;
    let lastDispatchedContext: string | null | undefined = undefined;
    const dispatchContextPrompt = () => {
      contextDispatchPending = false;
      if (disposed) return;
      const enabled =
        useSettings.getState().settings.experiments.stickyPrompt;
      const next = enabled
        ? scanForContextPrompt(term.buffer.active, term.buffer.active.viewportY)
        : null;
      if (next === lastDispatchedContext) return;
      lastDispatchedContext = next;
      window.dispatchEvent(
        new CustomEvent<ContextPromptDetail>(CONTEXT_PROMPT_EVENT, {
          detail: { sessionId, prompt: next },
        }),
      );
    };
    const scheduleContextDispatch = () => {
      if (contextDispatchPending || disposed) return;
      contextDispatchPending = true;
      requestAnimationFrame(dispatchContextPrompt);
    };
    const contextScrollDisposable = term.onScroll(scheduleContextDispatch);
    // Initial dispatch so the banner reflects whatever was restored from
    // scrollback before the first scroll/output event fires.
    scheduleContextDispatch();
    // Toggle off mid-session must hide the banner without waiting for
    // the next scroll/output event; toggle back on rescans the buffer.
    const unsubStickyToggle = useSettings.subscribe((state, prev) => {
      if (
        state.settings.experiments.stickyPrompt !==
        prev.settings.experiments.stickyPrompt
      ) {
        scheduleContextDispatch();
      }
    });

    // Custom event hook so a global hotkey (Cmd+K) can clear THIS terminal
    // without needing a cross-component ref registry. The dispatcher passes
    // the target sessionId in `detail.sessionId`; terminals match against
    // their own to avoid clearing siblings.
    const onClearRequested = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      term.clear();
      // Sticky-prompt banner watches the buffer for `> ` lines; after a
      // clear there are none, so explicitly schedule a dispatch so the
      // banner picks up the now-empty state without waiting for the
      // next scroll/output event.
      scheduleContextDispatch();
      // Also redraw the shell prompt so the user sees a clean state.
      sendToPty("\x0c");
    };
    window.addEventListener("acorn:terminal-clear", onClearRequested);

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      invoke("pty_resize", { sessionId, cols, rows }).catch((err: unknown) => {
        console.error("[Terminal] pty_resize failed", err);
      });
    });

    // Debounce resize-driven `fit()` + SIGWINCH. Without this, dragging the
    // pane divider fires ResizeObserver at ~60 Hz; each fit() emits a new
    // PTY size, the shell/TUI receives a flood of SIGWINCHes, and Claude
    // CLI in particular leaves stale prompt redraws stacked in scrollback.
    // 80ms after the last container resize is short enough to feel snappy
    // and long enough to coalesce a drag.
    let resizeTimer: number | null = null;
    const RESIZE_DEBOUNCE_MS = 80;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        try {
          fitWithCellMeasurements();
        } catch (err) {
          console.error("[Terminal] fit failed", err);
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    let exited = false;
    // Snapshot of linked worktrees taken right before each PTY spawn. On exit
    // we re-fetch and compare when this spawn cycle carried an explicit
    // adoption intent, or when this session's own live cwd was observed inside
    // a fresh linked worktree. A repo-global "new worktree appeared" diff is
    // not enough evidence: another tab, agent, or external terminal may have
    // created it while this shell was idle.
    let worktreeSnapshot: Set<string> | null = null;
    let worktreeAdoptionIntent: WorktreeAdoptionIntent = { kind: "none" };

    async function spawnPty() {
      if (disposed) return;
      try {
        observedLinkedWorktreePath = null;
        worktreeAdoptionIntent = { kind: "none" };
        worktreeSnapshot = null;
        // Capture the worktree set *before* the child can mutate it.
        // Failure here is non-fatal — without a snapshot we just lose
        // the adoption shortcut for this spawn cycle, and the press-Enter
        // path takes over as before.
        try {
          const before = await api.gitWorktrees(cwd);
          if (!disposed) worktreeSnapshot = new Set(before);
        } catch (err) {
          console.debug("[Terminal] worktree snapshot failed", err);
        }
        if (disposed) return;
        // Pass the post-fit xterm dimensions so the PTY starts in sync with
        // what the renderer will paint. Otherwise the PTY falls back to
        // 80x24 and zsh-autosuggestions / prompt redraws compute wrap
        // positions for a wider line than xterm renders, leaving the cursor
        // and echoed characters offset from where the shell believes they
        // are. The earlier `fit()`-driven `onResize` cannot fix this — it
        // fires before `pty_spawn` and `pty_resize` errors out with
        // "no pty for session".
        //
        // Sessions always drop into $SHELL on the backend.
        await invoke("pty_spawn", {
          sessionId,
          cwd,
          env: {},
          cols: term.cols,
          rows: term.rows,
          replayScrollback: !restoredDiskScrollback,
        });
        if (disposed) {
          // Cleanup ran mid-spawn — the pty just got created has no UI.
          // Issue a kill so we do not leak a child process.
          invoke("pty_kill", { sessionId }).catch(() => {
            // best effort
          });
          return;
        }
        exited = false;
        // CommandRunDialog may have queued a one-shot command for this
        // session (e.g. `gh auth login` launched from the NoAccessBanner).
        // Drain the queue once the PTY is alive — the shell buffers the
        // bytes until its prompt is ready, so a small startup delay is
        // tolerable without coordinating with the prompt-ready signal.
        const queued = useAppStore
          .getState()
          .consumePendingTerminalInput(sessionId);
        // Cleanup can run between consume and write under StrictMode's
        // mount/cleanup/mount sequence. Re-check `disposed` so we do not
        // pty_write into a session whose PTY has already been killed.
        if (queued && !disposed) {
          if (queued.adoptWorktreeOnExit) {
            worktreeAdoptionIntent = { kind: "after-exit" };
          }
          const payload = encodeStringToBase64(queued.command + "\r");
          invoke("pty_write", { sessionId, data: payload }).catch(
            (err: unknown) => {
              console.error("[Terminal] pending pty_write failed", err);
            },
          );
        }
      } catch (err) {
        if (!disposed) {
          term.write(
            `\r\n${ANSI_RED}[acorn] Failed to spawn pty: ${formatError(err)}${ANSI_RESET}\r\n`,
          );
        }
      }
    }

    // React StrictMode in dev runs effects twice (mount → cleanup → mount).
    // Without per-await `disposed` guards, the first IIFE keeps progressing
    // after its cleanup has run, and ends up issuing `pty_spawn` for a
    // session whose UI (term, listeners) was already torn down. Combined
    // with the second mount's IIFE issuing its own spawn, two real PTY
    // children get forked for the same session id; the backend insert
    // collision then orphans one PTY, which exits and triggers the second
    // PTY to also exit (zsh prints "Saving session..." twice). Guard every
    // await resumption point so a disposed mount short-circuits cleanly.
    (async () => {
      try {
        const unlistenOutput = await listen<PtyOutputPayload>(
          `pty:output:${sessionId}`,
          (event) => {
            if (disposed) return;
            try {
              const bytes = decodeBase64ToBytes(event.payload.data);
              term.write(bytes, () => {
                if (disposed) return;
                // The parser has drained this chunk. Force a frame-bound
                // refresh so fast cursor-move/erase TUIs do not leave stale
                // DOM cursor blocks or cells behind.
                scheduleViewportFrameRepaint();
                // Also schedule a viewport repaint once the burst goes
                // quiet, so a TUI redraw interrupted mid-stream doesn't
                // leave stale glyphs from a wider previous line painted on
                // screen.
                scheduleViewportIdleRepaint();
                // A new prompt row may have just been rendered. Rescan the
                // buffer so the sticky banner picks it up in the same frame
                // (instead of waiting for the user's next scroll).
                scheduleContextDispatch();
              });
              // Output will land in the buffer — schedule a debounced save
              // so the new content reaches disk ~1s after activity ends.
              scheduleScrollbackSave();
              // Agents can create a worktree and chdir a descendant process
              // without triggering our shell's OSC 7 prompt hook. Probe the
              // live descendant cwd on output bursts so exit adoption can
              // remain tied to this session rather than a repo-global diff.
              scheduleLiveCwdProbe();
            } catch (err) {
              console.error("[Terminal] decode payload failed", err);
            }
          },
        );
        if (disposed) {
          unlistenOutput();
          return;
        }
        unlistenFns.push(unlistenOutput);

        const unlistenExit = await listen(`pty:exit:${sessionId}`, () => {
          if (disposed) return;
          // Adopt only when Acorn queued an explicit worktree command, or
          // when this terminal itself was observed running inside a fresh
          // linked worktree. Plain user `exit` must not adopt unrelated
          // worktrees created elsewhere in the same repo.
          void (async () => {
            let adoptedPath: string | null = null;
            try {
              const current = await api.gitWorktrees(cwd);
              if (disposed) return;
              if (worktreeSnapshot) {
                adoptedPath = chooseWorktreeToAdoptAfterExit({
                  before: [...worktreeSnapshot],
                  after: current,
                  intent: worktreeAdoptionIntent,
                  observedLinkedWorktreePath,
                });
              }
            } catch (err) {
              console.warn(
                "[Terminal] worktree adoption check failed",
                err,
              );
            }
            if (disposed) return;
            worktreeAdoptionIntent = { kind: "none" };
            if (adoptedPath) {
              const name = adoptedPath.split("/").pop() || adoptedPath;
              useToasts.getState().show(`Adopted new worktree: ${name}`);
              await useAppStore
                .getState()
                .adoptSessionWorktree(sessionId, adoptedPath);
              // The store now holds the new worktree_path; TerminalHost
              // re-renders with the updated cwd prop, this entire effect
              // tears down via cleanup, and a fresh mount spawns the PTY
              // inside the new worktree. We deliberately do *not* mark
              // `exited` or write the press-Enter prompt — that would
              // briefly flash on the way out.
              return;
            }
            // User opted into auto-close: drop the session tab now instead
            // of writing the press-Enter prompt. The worktree is preserved
            // (removeSession(id, false)); only the in-app tab disappears.
            if (useSettings.getState().settings.sessions.closeOnExit) {
              exited = true;
              void useAppStore.getState().removeSession(sessionId, false);
              return;
            }
            exited = true;
            term.write(
              `\r\n${ANSI_DIM}[process exited — press Enter to restart]${ANSI_RESET}\r\n`,
            );
          })();
        });
        if (disposed) {
          unlistenExit();
          return;
        }
        unlistenFns.push(unlistenExit);
      } catch (err) {
        if (!disposed) {
          term.write(
            `\r\n${ANSI_RED}[acorn] Failed to attach pty listeners: ${formatError(err)}${ANSI_RESET}\r\n`,
          );
        }
        return;
      }

      if (disposed) return;

      // Intercept Enter while exited to respawn the same session in-place.
      const restartDisposable = term.onKey(({ domEvent }) => {
        if (!exited) return;
        if (domEvent.key !== "Enter") return;
        exited = true; // belt-and-braces; cleared inside spawnPty on success
        domEvent.preventDefault();
        domEvent.stopPropagation();
        term.clear();
        term.writeln(`${ANSI_DIM}[restarting...]${ANSI_RESET}`);
        void spawnPty();
      });
      unlistenFns.push(() => restartDisposable.dispose());

      // Restore the xterm-rendered disk snapshot before spawning so the user
      // sees the previous terminal screen immediately on app restart. If this
      // succeeds, `spawnPty()` tells the daemon attachment not to replay its
      // raw PTY ring buffer: raw TUI output contains intermediate Claude
      // redraw frames, while the disk snapshot is already parsed by xterm.
      try {
        const saved = await invoke<string | null>("scrollback_load", {
          sessionId,
        });
        if (disposed) return;
        restoredDiskScrollback = saved !== null;
        const restored = saved ? stripRestoreMarkers(saved) : "";
        if (restored && shouldRestoreScrollback(restored)) {
          // Each step is awaited individually. Previously the mode
          // resets and marker were fired without awaiting and `spawnPty`
          // was called immediately after, so the new shell's first
          // prompt could arrive via the pty:output listener while our
          // own writes were still sitting in xterm's parser queue.
          // Interleaving with the shell's prompt-redraw escape sequences
          // intermittently parked the cursor at column 0 of the new
          // prompt line and left input invisible (the user typed but
          // echo landed off-screen). Strict serial drain makes the
          // post-restore cursor position deterministic.
          const writeAndDrain = (data: string): Promise<void> =>
            new Promise<void>((resolve) => term.write(data, resolve));

          await writeAndDrain(restored);
          if (disposed) return;
          // Only exit alt-screen if the snapshot actually left us in it
          // — issuing `\x1b[?1049l` from the normal buffer pushes the
          // alt buffer's contents into the normal buffer's scrollback,
          // doubling the apparent history.
          if (term.buffer.active.type === "alternate") {
            await writeAndDrain("\x1b[?1049l");
            if (disposed) return;
          }
          // Targeted mode resets. We deliberately skip DECSTR (`\x1b[!p`)
          // because its soft-reset coverage in xterm.js leaves
          // bracketed-paste and mouse-tracking modes untouched — and
          // those are exactly the modes a stale snapshot can leave
          // enabled (zsh enables `?2004` per prompt; vim/claude enable
          // `?1000`–`?1006`). When the new shell inherits an unexpected
          // tracker, paste arrives wrapped in `\e[200~ … \e[201~` and
          // mouse clicks emit escape sequences instead of focusing the
          // pane — both of which read as "input is broken" to the user.
          // Listing each mode explicitly makes the post-restore state
          // deterministic regardless of what the snapshot ended in.
          const RESETS =
            "\x1b[r" +     // DECSTBM full-screen scroll region
            "\x1b[?7h" +   // DECAWM auto-wrap on
            "\x1b[?25h" +  // DECTCEM cursor visible
            "\x1b[?2004l" + // bracketed paste off
            "\x1b[?1000l" + // X11 mouse tracking off
            "\x1b[?1002l" + // mouse btn-event tracking off
            "\x1b[?1003l" + // mouse any-event tracking off
            "\x1b[?1006l" + // SGR mouse mode off
            "\r"; //          park cursor at column 0
          await writeAndDrain(RESETS);
          if (disposed) return;
          await writeAndDrain(
            `\r\n${ANSI_DIM}${RESTORE_MARKER_TEXT}${ANSI_RESET}\r\n`,
          );
          if (disposed) return;
        }
      } catch (err) {
        console.warn("[Terminal] scrollback_load failed", err);
      }

      // Now safe to persist: the buffer either holds the prior session's
      // restored content or starts genuinely empty. Either state is the
      // legitimate post-load baseline, so future saves cannot accidentally
      // overwrite still-on-disk content with a never-loaded empty buffer.
      savesAllowed = true;

      if (disposed) return;
      await spawnPty();
    })();

    // Scrollback persistence is event-driven, not periodic:
    //
    //   - Each chunk of PTY output schedules a debounced save 1s later
    //     (`scheduleScrollbackSave`, called from the `pty:output` listener
    //     above). A burst of output coalesces into one save 1s after the
    //     burst ends, so a long-running `claude` stream or `ls -R` does
    //     not pin the disk.
    //   - The App-level `onCloseRequested` handler awaits a final flush
    //     of every live terminal via `registerScrollbackFlusher`, so a
    //     normal app quit never loses data even if a save is in flight.
    //
    // The previous 10s polling interval was a magic-number fallback for
    // both lossy quits and idle preservation; the close-time flush makes
    // it redundant. Hard kill (kill -9, OS crash) loses at most the
    // ~1s debounce window of unsaved output; that is the cost we accept
    // in exchange for not constantly serialising idle buffers.
    const SCROLLBACK_MAX_ROWS = 2000;
    const persistScrollbackAsync = async () => {
      // `savesAllowed` flips true only after the initial scrollback_load
      // settles. Skipping the save until then prevents a still-empty
      // buffer from clobbering the persisted scrollback during the
      // StrictMode mount → cleanup → mount cycle.
      if (disposed || !savesAllowed) return;
      try {
        const data = serializeAddon.serialize({
          scrollback: SCROLLBACK_MAX_ROWS,
        });
        await invoke("scrollback_save", {
          sessionId,
          data: prepareScrollbackForSave(data),
        });
      } catch (err) {
        console.warn("[Terminal] scrollback_save failed", err);
      }
    };
    const unregisterScrollbackFlusher = registerScrollbackFlusher(
      sessionId,
      persistScrollbackAsync,
    );

    return () => {
      disposed = true;
      unsubSettings();
      hideLinkTooltip();
      if (themeFrame !== null) {
        cancelAnimationFrame(themeFrame);
        themeFrame = null;
      }
      unregisterScrollbackFlusher();
      if (scrollbackSaveTimer !== null) {
        window.clearTimeout(scrollbackSaveTimer);
        scrollbackSaveTimer = null;
      }
      if (viewportRepaintTimer !== null) {
        window.clearTimeout(viewportRepaintTimer);
        viewportRepaintTimer = null;
      }
      if (viewportRepaintFrame !== null) {
        cancelAnimationFrame(viewportRepaintFrame);
        viewportRepaintFrame = null;
      }
      // No cleanup-time save: under React.StrictMode the cleanup of the
      // first dev mount fires while the buffer is still empty (load
      // hasn't run yet), and a fire-and-forget save here would clobber
      // the persisted scrollback with 0 bytes. Tab-close / project-switch
      // unmount instead relies on the most recent debounced output save
      // (within ~1s of the last activity), which is already on disk; the
      // App-level `onCloseRequested` handler covers full app quit and
      // does an awaited flush via `flushAllScrollbacks` before destroy.
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      resizeObserver.disconnect();
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("keydown", onKeydown, true);
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("compositionstart", swallowComposition, true);
      container.removeEventListener("compositionupdate", swallowComposition, true);
      container.removeEventListener("compositionend", swallowComposition, true);
      window.removeEventListener("acorn:terminal-clear", onClearRequested);
      inputDisposable.dispose();
      renderDisposable.dispose();
      scrollDisposable.dispose();
      cursorMoveDisposable.dispose();
      contextScrollDisposable.dispose();
      unsubStickyToggle();
      resizeDisposable.dispose();
      if (liveCwdProbeTimer !== null) {
        window.clearTimeout(liveCwdProbeTimer);
      }
      for (const off of unlistenFns) {
        try { off(); } catch { /* ignore */ }
      }
      invoke("pty_kill", { sessionId }).catch(() => {
        // Backend may not implement pty_kill yet — safe to ignore.
      });
      try { fitAddon.dispose(); } catch { /* ignore */ }
      try { webLinksAddon.dispose(); } catch { /* ignore */ }
      try { serializeAddon.dispose(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, cwd]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = isFocusedPane;
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      // ignore
    }
  }, [isFocusedPane]);

  // Steal keyboard focus for newly created sessions so the user can type
  // immediately after Cmd+T (or any other creation path). Store dispatches
  // `acorn:focus-session` after rAF so the slot has reattached to its pane
  // body before we call `term.focus()`.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      termRef.current?.focus();
    };
    window.addEventListener("acorn:focus-session", handler);
    return () => window.removeEventListener("acorn:focus-session", handler);
  }, [sessionId]);

  // When this terminal is hidden behind another tab in the same pane and
  // then made visible again, the DOM renderer may not have repainted while
  // CSS visibility was `hidden`. Force a fit + full-buffer refresh so the
  // visible rows show what's currently in the scrollback.
  //
  // We fire the refresh at three points to cover different layout/paint
  // race windows we've observed:
  //   1. Synchronously after the visibility flip.
  //   2. After the next animation frame (post-style-recalc).
  //   3. After a short timeout (covers cases where the webview defers paint).
  // We also poke the container's `offsetHeight` to force a reflow before
  // each refresh so xterm's row geometry is up to date.
  useEffect(() => {
    if (!isActive) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;

    const refresh = () => {
      // Force layout reflow so any pending visibility/size changes commit
      // before xterm queries its container dimensions.
      void container.offsetHeight;
      try {
        fit.fit();
      } catch {
        // ignore
      }
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore
      }
      try {
        term.scrollToBottom();
      } catch {
        // ignore
      }
    };

    refresh();
    const raf = requestAnimationFrame(refresh);
    const timeout = window.setTimeout(refresh, 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [isActive]);

  // FitAddon subtracts padding from xterm.element, not its parent — keep the
  // gutter on the outer wrapper so xterm's parent stays padding-free and rows
  // don't overflow past the pane body. The pinned-prompt banner overlays the
  // top edge as an `absolute` element so it never changes the terminal's
  // computed dimensions — a flex layout that shrunk the xterm container
  // mid-render fired SIGWINCH at claude's TUI and shredded its box-drawing
  // characters into half-rendered lines.
  return (
    <div
      className="acorn-terminal-shell relative h-full w-full"
      style={{
        padding: "16px 8px",
        overflow: "hidden",
      }}
    >
      <div className="acorn-bg-terminal" aria-hidden="true" />
      <div
        ref={containerRef}
        className={`acorn-terminal relative z-10 h-full w-full ${
          isFocusedPane ? "" : "acorn-terminal-inactive"
        }`}
      />
      <FloatingTooltip
        label={`${MODIFIER_LINK_LABEL} to open link`}
        anchorRect={linkTooltip?.anchorRect ?? null}
        side="top"
        overlayClassName="xterm-hover"
      />
      {/* Pinned-prompt overlay. */}
      <StickyUserPrompt sessionId={sessionId} />
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
