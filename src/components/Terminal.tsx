import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Terminal as XTerm,
  type IDisposable,
  type ITheme,
  type IViewportRange,
} from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDownToLine } from "lucide-react";
import { createPortal } from "react-dom";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import type { BackgroundState } from "../lib/background";
import { visibleMultiInputSessionIds } from "../lib/multiInput";
import { endAcornDrag, getCurrentFilePayload } from "../lib/dnd";
import { formatTerminalFileMention } from "../lib/fileMention";
import { registerScrollbackFlusher } from "../lib/scrollback-coordinator";
import {
  patchTerminalCellMeasurements,
  unpatchTerminalCellMeasurements,
} from "../lib/terminal-cjk-cell-width-addon";
import {
  patchTerminalEmojiWidthMeasurements,
  unpatchTerminalEmojiWidthMeasurements,
} from "../lib/terminal-emoji-width-addon";
import {
  createTerminalRepaintScheduler,
  repaintTerminalViewport,
} from "../lib/terminalRepaint";
import {
  findConversationPromptTarget,
  scanForContextPrompt,
  TERMINAL_CONVERSATION_NAV_EVENT,
  type ConversationNavigationDirection,
} from "../lib/terminalConversation";
import { patchTerminalMouseCoordinateScale } from "../lib/terminalMouseScale";
import { UI_SCALE_CHANGED_EVENT } from "../lib/layoutEvents";
import {
  prepareScrollbackForSave,
  RESTORE_MARKER_TEXT,
  shouldRestoreScrollback,
  stripRestoreMarkers,
} from "../lib/terminalScrollback";
import {
  getClipboardImageFile,
  hasClipboardImagePayload,
  terminalPasteAction,
  type ClipboardImageFile,
} from "../lib/terminalPaste";
import { saveClipboardImageAttachment } from "../lib/clipboardImageAttachment";
import {
  createTerminalFileLinkProvider,
  resolveTerminalFilePathCandidates,
  type TerminalFileReference,
} from "../lib/terminalFileLinks";
import { createTerminalWebLinkProvider } from "../lib/terminalWebLinks";
import {
  useSettings,
  type TerminalLinkActivation,
} from "../lib/settings";
import { buildXtermTheme } from "../lib/terminalTheme";
import { useThemes, type ThemeMode } from "../lib/themes";
import type { SessionAgentProvider } from "../lib/types";
import {
  showStoreResultToast,
  showTranslatedErrorToast,
  showTranslatedToast,
} from "../lib/operationToasts";
import {
  chooseWorktreeToAdoptAfterExit,
  type WorktreeAdoptionIntent,
} from "../lib/worktreeAdoption";
import { hasRecordedWorktree } from "../lib/sessionWorktree";
import { useAppStore } from "../store";
import { StickyUserPrompt } from "./StickyUserPrompt";
import { FloatingTooltip, Tooltip, type TooltipAnchorRect } from "./Tooltip";

interface TerminalProps {
  sessionId: string;
  repoPath: string;
  cwd: string;
  agentProvider?: SessionAgentProvider | null;
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

function isTerminalScrolledBack(term: XTerm): boolean {
  const buffer = term.buffer.active;
  return (
    buffer.type === "normal" &&
    buffer.baseY - buffer.viewportY >= SCROLL_TO_BOTTOM_VISIBLE_ROWS
  );
}

function isTerminalViewportScrolledBack(container: HTMLElement): boolean {
  const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
  if (!viewport) return false;
  const remaining =
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  const rowHeight =
    container.querySelector<HTMLElement>(".xterm-rows > div")
      ?.getBoundingClientRect().height ?? 0;
  const threshold = Math.max(160, rowHeight * SCROLL_TO_BOTTOM_VISIBLE_ROWS);
  return remaining >= threshold;
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
const SCROLL_TO_BOTTOM_VISIBLE_ROWS = 10;
// xterm briefly leaves and re-enters hovered links when refreshed rows repaint.
const LINK_TOOLTIP_HIDE_GRACE_MS = 80;

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

// macOS uses Cmd (metaKey); other platforms use Ctrl. Matches the
// platform-primary modifier `tinykeys` resolves `$mod` to.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|od|ad)/.test(navigator.platform);
const MODIFIER_LINK_LABEL = IS_MAC ? "Command-click" : "Ctrl-click";

interface TerminalRenderInternals {
  _core?: {
    linkifier?: {
      currentLink?: {
        link?: {
          decorations?: {
            underline?: boolean;
          };
        };
      };
    };
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

function suppressCurrentXtermLinkUnderline(term: XTerm): void {
  const link = (term as unknown as TerminalRenderInternals)._core?.linkifier
    ?.currentLink?.link;
  if (link?.decorations && link.decorations.underline !== false) {
    link.decorations.underline = false;
  }
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

function rectToTooltipAnchorRect(rect: DOMRect): TooltipAnchorRect {
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  };
}

function unionRects(rects: TooltipAnchorRect[]): TooltipAnchorRect | null {
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

function terminalLinkTooltipKey(text: string, range: IViewportRange): string {
  return [
    text,
    range.start.x,
    range.start.y,
    range.end.x,
    range.end.y,
  ].join("\u0000");
}

function FloatingTerminalLinkUnderlines({
  linkKey,
  rects,
}: {
  linkKey: string;
  rects: TooltipAnchorRect[];
}): ReactElement | null {
  if (rects.length === 0) return null;

  return createPortal(
    <>
      {rects.map((rect, index) => (
        <span
          key={`${linkKey}:${index}`}
          aria-hidden="true"
          data-acorn-terminal-link-underline="true"
          className="xterm-hover pointer-events-none fixed bg-fg"
          style={{
            top: rect.bottom - 1,
            left: rect.left,
            width: rect.width,
            height: 1,
            zIndex: 9998,
          }}
        />
      ))}
    </>,
    document.body,
  );
}

function linkRangeAnchorRects(
  container: HTMLElement,
  term: XTerm,
  range: IViewportRange,
): TooltipAnchorRect[] {
  const cell = terminalCellDims(term);
  if (!cell) return [];
  const viewportY = term.buffer.active.viewportY;

  const startViewportY = range.start.y - viewportY - 1;
  const endViewportY = range.end.y - viewportY - 1;
  if (endViewportY < 0 || startViewportY >= term.rows) return [];

  const rowElements = Array.from(
    container.querySelectorAll<HTMLElement>(".xterm-rows > div"),
  );
  const rects: TooltipAnchorRect[] = [];
  const firstVisibleRow = Math.max(0, startViewportY);
  const lastVisibleRow = Math.min(term.rows - 1, endViewportY);
  for (let y = firstVisibleRow; y <= lastVisibleRow; y++) {
    const rowElement = rowElements[y];
    const rowRect =
      rowElement?.getBoundingClientRect() ??
      (
        container.querySelector<HTMLElement>(".xterm-screen") ?? container
      ).getBoundingClientRect();
    const startCol = y === startViewportY ? Math.max(0, range.start.x - 1) : 0;
    const endCol =
      y === endViewportY
        ? Math.max(startCol + 1, Math.min(term.cols, range.end.x))
        : term.cols;
    const textRect = rowElement
      ? textRangeRectForColumns(rowElement, startCol, endCol)
      : null;
    if (textRect) {
      rects.push(rectToTooltipAnchorRect(textRect));
      continue;
    }
    const left = rowRect.left + startCol * cell.width;
    const top = rowElement ? rowRect.top : rowRect.top + y * cell.height;
    const right = rowRect.left + endCol * cell.width;
    const bottom = rowElement ? rowRect.bottom : top + cell.height;
    rects.push({
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top,
    });
  }
  return rects.filter((rect) => rect.width > 0 && rect.height > 0);
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodePtyChannelPayload(payload: unknown): Uint8Array {
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload)) {
    return new Uint8Array(payload);
  }
  if (typeof payload === "string") {
    return decodeBase64ToBytes(payload);
  }
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    typeof (payload as { data?: unknown }).data === "string"
  ) {
    return decodeBase64ToBytes((payload as { data: string }).data);
  }
  throw new Error("unsupported pty output payload");
}

function unregisterTauriChannel(channel: Channel<unknown>) {
  const internals = (
    window as typeof window & {
      __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
    }
  ).__TAURI_INTERNALS__;
  internals?.unregisterCallback?.(channel.id);
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

function usesExplicitRelativePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

export function Terminal({
  sessionId,
  repoPath,
  cwd,
  agentProvider = null,
  isActive = true,
  isFocusedPane = true,
}: TerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fitTerminalRef = useRef<(() => void) | null>(null);
  const [linkTooltip, setLinkTooltip] = useState<{
    anchorRect: TooltipAnchorRect;
    underlineRects: TooltipAnchorRect[];
    linkKey: string;
  } | null>(null);
  const [isScrolledBack, setIsScrolledBack] = useState(false);

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
      // rendered cells (e.g. the prompt user "developer" renders as
      // "develope"). PTY output is the only writer here, so `false` is the
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
    let linkTooltipHideTimer: number | null = null;
    const cancelLinkTooltipHide = () => {
      if (linkTooltipHideTimer !== null) {
        window.clearTimeout(linkTooltipHideTimer);
        linkTooltipHideTimer = null;
      }
    };
    const showLinkTooltip = (text: string, range: IViewportRange) => {
      cancelLinkTooltipHide();
      if (linkTooltipFrame !== null) {
        cancelAnimationFrame(linkTooltipFrame);
      }
      const linkKey = terminalLinkTooltipKey(text, range);
      linkTooltipFrame = requestAnimationFrame(() => {
        linkTooltipFrame = null;
        if (linkActivation !== "modifier-click") return;
        const underlineRects = linkRangeAnchorRects(container, term, range);
        const anchorRect = unionRects(underlineRects);
        if (!anchorRect) return;
        setLinkTooltip((current) => {
          if (current?.linkKey === linkKey) {
            return current;
          }
          return { anchorRect, underlineRects, linkKey };
        });
      });
    };
    const hideLinkTooltip = (immediate = false) => {
      if (linkTooltipFrame !== null) {
        cancelAnimationFrame(linkTooltipFrame);
        linkTooltipFrame = null;
      }
      cancelLinkTooltipHide();
      if (immediate) {
        setLinkTooltip(null);
        return;
      }
      linkTooltipHideTimer = window.setTimeout(() => {
        linkTooltipHideTimer = null;
        setLinkTooltip(null);
      }, LINK_TOOLTIP_HIDE_GRACE_MS);
    };
    const activateExternalLink = (event: MouseEvent, uri: string) => {
      event.preventDefault();
      hideLinkTooltip(true);
      if (linkActivation === "modifier-click" && !modifierHeld(event)) {
        return;
      }
      void openUrl(uri).catch((err: unknown) => {
        console.error("failed to open terminal link", uri, err);
      });
    };
    const hoverExternalLink = (uri: string, range: IViewportRange) => {
      if (linkActivation !== "modifier-click") return;
      suppressCurrentXtermLinkUnderline(term);
      queueMicrotask(() => {
        try { suppressCurrentXtermLinkUnderline(term); } catch { /* ignore */ }
      });
      requestAnimationFrame(() => {
        try { suppressCurrentXtermLinkUnderline(term); } catch { /* ignore */ }
      });
      showLinkTooltip(uri, range);
    };
    term.options.linkHandler = {
      activate: activateExternalLink,
      hover: (_event, uri, range) => {
        hoverExternalLink(uri, range as IViewportRange);
      },
      leave: () => {
        hideLinkTooltip();
      },
    };
    const resolveTerminalFileBaseCwd = async (): Promise<string> => {
      let baseCwd = cwd;
      try {
        baseCwd = (await api.ptyCwd(sessionId)) ?? cwd;
      } catch (err: unknown) {
        console.debug("[Terminal] pty_cwd for file link failed", err);
      }
      return baseCwd;
    };
    let terminalFileHomeDirPromise: Promise<string | null> | null = null;
    const resolveTerminalFileHomeDir = (): Promise<string | null> => {
      if (!terminalFileHomeDirPromise) {
        terminalFileHomeDirPromise = homeDir()
          .then((home) => home?.replace(/\/+$/u, "") ?? null)
          .catch((err: unknown) => {
            console.debug("[Terminal] home_dir for file link failed", err);
            return null;
          });
      }
      return terminalFileHomeDirPromise;
    };
    const resolveOpenableTerminalFileReferences = async (
      references: TerminalFileReference[],
    ): Promise<TerminalFileReference[]> => {
      const needsHome = references.some((reference) =>
        reference.path.startsWith("~/"),
      );
      const [baseCwd, home] = await Promise.all([
        resolveTerminalFileBaseCwd(),
        needsHome ? resolveTerminalFileHomeDir() : Promise.resolve(null),
      ]);
      const resolveExistingFilePath = async (
        reference: TerminalFileReference,
      ): Promise<string | null> => {
        const basePaths = usesExplicitRelativePath(reference.path)
          ? []
          : [cwd, repoPath];
        const candidates = resolveTerminalFilePathCandidates(
          baseCwd,
          reference.path,
          {
            home,
            basePaths,
          },
        );
        for (const candidate of candidates) {
          try {
            if (await api.fsFileExists(candidate)) {
              return candidate;
            }
          } catch (err: unknown) {
            console.debug("[Terminal] fs_file_exists for file link failed", err);
          }
        }
        return null;
      };
      const resolved: Array<TerminalFileReference | null> = await Promise.all(
        references.map(async (reference) => {
          const absolutePath = await resolveExistingFilePath(reference);
          if (!absolutePath) return null;
          return { ...reference, absolutePath };
        }),
      );
      return resolved.filter(
        (reference): reference is TerminalFileReference => reference !== null,
      );
    };
    const openTerminalFileReference = (reference: TerminalFileReference) => {
      void (async () => {
        let path: string | null = reference.absolutePath ?? null;
        if (path) {
          try {
            if (!(await api.fsFileExists(path))) {
              return;
            }
          } catch (err: unknown) {
            console.debug("[Terminal] fs_file_exists before open failed", err);
            return;
          }
        } else {
          const [baseCwd, home] = await Promise.all([
            resolveTerminalFileBaseCwd(),
            reference.path.startsWith("~/")
              ? resolveTerminalFileHomeDir()
              : Promise.resolve(null),
          ]);
          const basePaths = usesExplicitRelativePath(reference.path)
            ? []
            : [cwd, repoPath];
          const candidates = resolveTerminalFilePathCandidates(
            baseCwd,
            reference.path,
            {
              home,
              basePaths,
            },
          );
          path = null;
          for (const candidate of candidates) {
            try {
              if (await api.fsFileExists(candidate)) {
                path = candidate;
                break;
              }
            } catch (err: unknown) {
              console.debug("[Terminal] fs_file_exists before open failed", err);
            }
          }
          if (!path) {
            return;
          }
        }
        const target =
          reference.line === undefined
            ? undefined
            : { line: reference.line, column: reference.column };
        useAppStore.getState().openCodeViewerTab(path, cwd, target);
      })();
    };
    let webLinksDisposable: IDisposable | null = term.registerLinkProvider(
      createTerminalWebLinkProvider(term, {
        activate: activateExternalLink,
        hover: (_event, uri, link) => {
          hoverExternalLink(uri, link.range);
        },
        leave: () => {
          hideLinkTooltip();
        },
      }),
    );
    let fileLinksDisposable: IDisposable | null = term.registerLinkProvider(
      createTerminalFileLinkProvider(term, {
        resolveReferences: resolveOpenableTerminalFileReferences,
        activate: (event, reference) => {
          event.preventDefault();
          hideLinkTooltip(true);
          if (linkActivation === "modifier-click" && !modifierHeld(event)) {
            return;
          }
          openTerminalFileReference(reference);
        },
        hover: (_event, _reference, link) => {
          if (linkActivation !== "modifier-click") return;
          showLinkTooltip(link.text, link.range);
        },
        leave: () => {
          hideLinkTooltip();
        },
      }),
    );
    const serializeAddon = new SerializeAddon();
    const unicode11Addon = new Unicode11Addon();
    const unicodeGraphemesAddon = new UnicodeGraphemesAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(unicodeGraphemesAddon);
    // xterm.js defaults to Unicode 6 width tables and plain codepoint
    // accounting. The grapheme provider uses newer width data and keeps
    // variation-selector, skin-tone, regional-flag, and ZWJ emoji clusters in
    // a single rendered cell group so following text starts on the right
    // terminal column.
    termRef.current = term;
    fitRef.current = fitAddon;

    // The DOM renderer (default) anchors xterm's hidden textarea at the
    // cursor cell, so IME composition popups (CJK input) render at the
    // correct location and intermediate characters are not flushed to the
    // PTY mid-composition. The canvas/webgl addons are faster but mis-handle
    // composition events on macOS/Linux IMEs — we pick correctness over fps.
    term.open(container);
    patchTerminalEmojiWidthMeasurements(term);
    const unpatchMouseCoordinateScale = patchTerminalMouseCoordinateScale(term);
    const fitWithCellMeasurements = () => {
      const cjkEnabled =
        useSettings.getState().settings.experiments.cjkCellWidthHeuristic;
      if (cjkEnabled) patchTerminalCellMeasurements(term);
      fitAddon.fit();
      if (cjkEnabled) patchTerminalCellMeasurements(term);
    };
    fitTerminalRef.current = fitWithCellMeasurements;
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
    let daemonSessionAliveAtMount = false;

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
          hideLinkTooltip(true);
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
    let terminalActivityVersion = 0;
    let imagePasteFallbackTimer: number | null = null;
    let imagePasteFallbackSerial = 0;
    const IMAGE_PASTE_FALLBACK_DELAY_MS = 500;
    const scheduleClipboardImageFallback = (
      imageFile: ClipboardImageFile,
      observedActivityVersion: number,
    ) => {
      if (imagePasteFallbackTimer !== null) {
        window.clearTimeout(imagePasteFallbackTimer);
      }
      const serial = ++imagePasteFallbackSerial;
      imagePasteFallbackTimer = window.setTimeout(() => {
        imagePasteFallbackTimer = null;
        if (
          disposed ||
          serial !== imagePasteFallbackSerial ||
          terminalActivityVersion !== observedActivityVersion
        ) {
          return;
        }
        void saveClipboardImageAttachment(imageFile)
          .then((attachment) => {
            if (
              disposed ||
              serial !== imagePasteFallbackSerial ||
              terminalActivityVersion !== observedActivityVersion
            ) {
              return;
            }
            sendUserInputToPty(formatTerminalFileMention(attachment.path, cwd));
            term.focus();
          })
          .catch((err: unknown) => {
            console.warn("[Terminal] clipboard image attachment failed", err);
          });
      }, IMAGE_PASTE_FALLBACK_DELAY_MS);
    };
    let conversationNavigationFromY: number | null = null;
    const setConversationNavigationFromY = (line: number) => {
      conversationNavigationFromY = Math.max(0, Math.floor(line));
    };
    const scrollToLiveTail = () => {
      const buffer = term.buffer.active;
      try {
        term.scrollToBottom();
        setConversationNavigationFromY(buffer.baseY);
        setIsScrolledBack(false);
      } catch {
        // Terminal may have been disposed between the event and scroll.
      }
      term.focus();
    };
    const scrollToBufferLine = (line: number) => {
      const buffer = term.buffer.active;
      const target = Math.max(0, Math.min(line, buffer.baseY));
      try {
        term.scrollToLine(target);
        setIsScrolledBack(target < buffer.baseY);
        term.focus();
        return true;
      } catch {
        return false;
      }
    };
    const scrollToConversationPrompt = (
      direction: ConversationNavigationDirection,
    ) => {
      const buffer = term.buffer.active;
      if (buffer.type !== "normal") return false;
      const fromY = conversationNavigationFromY ?? buffer.viewportY;
      const target = findConversationPromptTarget(buffer, direction, fromY);
      if (target) {
        const didScroll = scrollToBufferLine(target.markerRow);
        if (didScroll) setConversationNavigationFromY(target.markerRow);
        return didScroll;
      }
      if (direction === "next" && fromY < buffer.baseY) {
        scrollToLiveTail();
        return true;
      }
      return false;
    };
    const syncScrolledBackState = () => {
      setIsScrolledBack(
        isTerminalScrolledBack(term) ||
          isTerminalViewportScrolledBack(container),
      );
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
      terminalActivityVersion += 1;
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
        if (ev.key === "ArrowDown") {
          scrollToLiveTail();
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
    // Image-only payloads first stay on the native path. If the paste
    // produces no terminal input or output, save the image to app-local
    // storage and insert an @file mention as the compatibility path.
    const onPaste = (e: Event) => {
      const ev = e as ClipboardEvent;
      const cd = ev.clipboardData;
      if (!cd) return;
      const text = cd?.getData("text/plain") ?? "";
      const imageFile = getClipboardImageFile(cd);
      const action = terminalPasteAction({
        text,
        hasImagePayload: Boolean(imageFile) || hasClipboardImagePayload(cd),
      });
      if (action.kind === "deferImageAttachment") {
        if (imageFile) {
          scheduleClipboardImageFallback(imageFile, terminalActivityVersion);
        }
        return;
      }
      if (action.kind === "pasteText") term.paste(action.text);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    container.addEventListener("paste", onPaste, true);

    const onDragOver = (e: DragEvent) => {
      if (!getCurrentFilePayload()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      const payload = getCurrentFilePayload();
      if (!payload) return;
      e.preventDefault();
      try {
        sendUserInputToPty(formatTerminalFileMention(payload.path, cwd));
        term.focus();
      } finally {
        endAcornDrag();
      }
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

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

    let ptyReady = false;
    let lastPtyResize:
      | {
          cols: number;
          rows: number;
        }
      | null = null;
    const sendPtyResize = (
      force = false,
      size: { cols: number; rows: number } = {
        cols: term.cols,
        rows: term.rows,
      },
    ) => {
      if (!ptyReady || size.cols <= 0 || size.rows <= 0) return;
      if (
        !force &&
        lastPtyResize?.cols === size.cols &&
        lastPtyResize.rows === size.rows
      ) {
        return;
      }
      lastPtyResize = { cols: size.cols, rows: size.rows };
      invoke("pty_resize", {
        sessionId,
        cols: size.cols,
        rows: size.rows,
      }).catch((err: unknown) => {
        if (
          lastPtyResize?.cols === size.cols &&
          lastPtyResize.rows === size.rows
        ) {
          lastPtyResize = null;
        }
        console.error("[Terminal] pty_resize failed", err);
      });
    };
    const syncViewportAndPtySize = () => {
      const fit = fitTerminalRef.current;
      if (!fit) return;
      repaintTerminalViewport({ container, fit, term });
      // Even when xterm's cols/rows are unchanged, force a backend resize so
      // TUIs launched from an already-open shell observe the current pane size.
      sendPtyResize(true);
    };
    const commandSizeSyncScheduler = createTerminalRepaintScheduler(
      syncViewportAndPtySize,
      120,
    );

    const inputDisposable = term.onData((data: string) => {
      terminalActivityVersion += 1;
      sendUserInputToPty(data);
      if (data.includes("\r") || data.includes("\n")) {
        commandSizeSyncScheduler.schedule();
      }
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
        ? scanForContextPrompt(
            term.buffer.active,
            term.buffer.active.viewportY,
          )?.prompt ?? null
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
    const conversationPositionDisposable = term.onScroll(
      setConversationNavigationFromY,
    );
    const contextScrollDisposable = term.onScroll(scheduleContextDispatch);
    const scrollbackStateDisposable = term.onScroll(syncScrolledBackState);
    const viewportElement =
      container.querySelector<HTMLElement>(".xterm-viewport");
    viewportElement?.addEventListener("scroll", syncScrolledBackState);
    syncScrolledBackState();
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

    const onConversationNavRequested = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          direction: ConversationNavigationDirection;
          sessionId: string;
        }>
      ).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (!scrollToConversationPrompt(detail.direction)) return;
      e.preventDefault();
      scheduleContextDispatch();
      syncScrolledBackState();
    };
    window.addEventListener(
      TERMINAL_CONVERSATION_NAV_EVENT,
      onConversationNavRequested,
    );

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
      sendPtyResize(false, { cols, rows });
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
        ptyReady = false;
        lastPtyResize = null;
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
        const spawnCols = term.cols;
        const spawnRows = term.rows;
        await invoke("pty_spawn", {
          sessionId,
          cwd,
          env: {},
          cols: spawnCols,
          rows: spawnRows,
          replayScrollback: daemonSessionAliveAtMount || !restoredDiskScrollback,
        });
        if (disposed) {
          // Cleanup ran mid-spawn — the pty just got created has no UI.
          // Issue a kill so we do not leak a child process.
          invoke("pty_kill", { sessionId }).catch(() => {
            // best effort
          });
          return;
        }
        ptyReady = true;
        lastPtyResize = { cols: spawnCols, rows: spawnRows };
        commandSizeSyncScheduler.schedule();
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
    const handlePtyOutput = (bytes: Uint8Array) => {
      terminalActivityVersion += 1;
      term.write(bytes, () => {
        if (disposed) return;
        // The parser has drained this chunk. Force a frame-bound
        // refresh so fast cursor-move/erase TUIs do not leave stale
        // DOM cursor blocks or cells behind.
        scheduleViewportFrameRepaint();
        // Also schedule a viewport repaint once the burst goes quiet,
        // so a TUI redraw interrupted mid-stream doesn't leave stale
        // glyphs from a wider previous line painted on screen.
        scheduleViewportIdleRepaint();
        // A new prompt row may have just been rendered. Rescan the
        // buffer so the sticky banner picks it up in the same frame
        // instead of waiting for the user's next scroll.
        scheduleContextDispatch();
      });
      // Output will land in the buffer — schedule a debounced save so the
      // new content reaches disk ~1s after activity ends.
      scheduleScrollbackSave();
      // Agents can create a worktree and chdir a descendant process without
      // triggering our shell's OSC 7 prompt hook. Probe the live descendant
      // cwd on output bursts so exit adoption stays tied to this session.
      scheduleLiveCwdProbe();
    };

    (async () => {
      let outputChannel: Channel<unknown> | null = null;
      try {
        outputChannel = new Channel<unknown>((payload) => {
          if (disposed) return;
          try {
            handlePtyOutput(decodePtyChannelPayload(payload));
          } catch (err) {
            console.error("[Terminal] decode channel payload failed", err);
          }
        });
        const outputToken = await invoke<number>("pty_subscribe_output", {
          sessionId,
          channel: outputChannel,
        });
        const subscribedOutputChannel = outputChannel;
        if (disposed) {
          invoke("pty_unsubscribe_output", {
            sessionId,
            token: outputToken,
          })
            .catch(() => {
              // best effort
            })
            .finally(() => unregisterTauriChannel(subscribedOutputChannel));
          return;
        }
        unlistenFns.push(() => {
          invoke("pty_unsubscribe_output", {
            sessionId,
            token: outputToken,
          })
            .catch(() => {
              // best effort
            })
            .finally(() => unregisterTauriChannel(subscribedOutputChannel));
        });

        const unlistenOutput = await listen<PtyOutputPayload>(
          `pty:output:${sessionId}`,
          (event) => {
            if (disposed) return;
            try {
              handlePtyOutput(decodeBase64ToBytes(event.payload.data));
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
          ptyReady = false;
          lastPtyResize = null;
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
              await useAppStore
                .getState()
                .adoptSessionWorktree(sessionId, adoptedPath);
              const error = useAppStore.getState().consumeError();
              if (error) {
                showTranslatedErrorToast(
                  "toasts.session.worktreeAdoptFailed",
                  error,
                );
              } else {
                showTranslatedToast("toasts.session.worktreeAdopted", { name });
              }
              // The store now holds the new worktree_path; TerminalHost
              // re-renders with the updated cwd prop, this entire effect
              // tears down via cleanup, and a fresh mount spawns the PTY
              // inside the new worktree. We deliberately do *not* mark
              // `exited` or write the press-Enter prompt — that would
              // briefly flash on the way out.
              return;
            }
            // User opted into auto-close: drop ordinary sessions immediately,
            // but route worktree-backed sessions through the same removal
            // policy as tab close.
            if (useSettings.getState().settings.sessions.closeOnExit) {
              exited = true;
              const store = useAppStore.getState();
              const session =
                store.sessions.find((candidate) => candidate.id === sessionId) ??
                null;
              if (session && hasRecordedWorktree(session)) {
                store.requestRemoveSession(sessionId);
              } else {
                void store.removeSession(sessionId, false).then(() => {
                  showStoreResultToast(
                    null,
                    "toasts.session.removeFailed",
                  );
                });
              }
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
        if (outputChannel) {
          unregisterTauriChannel(outputChannel);
        }
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

      // If the daemon already owns a live PTY for this session, its ring
      // buffer is the freshest representation of the screen. Disk scrollback
      // is only the last saved frontend snapshot and can be stale after the
      // app has been closed while an agent kept running. Replaying that
      // stale snapshot first leaves xterm's buffer/cursor out of sync with
      // the next daemon redraw, so live daemon reattach skips disk restore
      // and asks `pty_spawn` to replay the daemon ring instead.
      try {
        const daemonSessions = await api.daemonListSessions();
        if (disposed) return;
        daemonSessionAliveAtMount = daemonSessions.some(
          (session) => session.id === sessionId && session.alive,
        );
      } catch {
        daemonSessionAliveAtMount = false;
      }

      // Restore the xterm-rendered disk snapshot before spawning so the user
      // sees the previous terminal screen immediately on app restart. Dead or
      // newly spawned sessions can safely use that snapshot; already-live
      // daemon sessions must use the daemon ring instead so cursor state
      // matches the running PTY.
      try {
        const saved = await invoke<string | null>("scrollback_load", {
          sessionId,
        });
        if (disposed) return;
        restoredDiskScrollback = !daemonSessionAliveAtMount && saved !== null;
        const restored = saved ? stripRestoreMarkers(saved) : "";
        if (
          !daemonSessionAliveAtMount &&
          restored &&
          shouldRestoreScrollback(restored)
        ) {
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
      hideLinkTooltip(true);
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
      cancelLinkTooltipHide();
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
      commandSizeSyncScheduler.dispose();
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("keydown", onKeydown, true);
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      container.removeEventListener("compositionstart", swallowComposition, true);
      container.removeEventListener("compositionupdate", swallowComposition, true);
      container.removeEventListener("compositionend", swallowComposition, true);
      window.removeEventListener("acorn:terminal-clear", onClearRequested);
      inputDisposable.dispose();
      renderDisposable.dispose();
      scrollDisposable.dispose();
      cursorMoveDisposable.dispose();
      contextScrollDisposable.dispose();
      conversationPositionDisposable.dispose();
      scrollbackStateDisposable.dispose();
      viewportElement?.removeEventListener("scroll", syncScrolledBackState);
      unsubStickyToggle();
      window.removeEventListener(
        TERMINAL_CONVERSATION_NAV_EVENT,
        onConversationNavRequested,
      );
      resizeDisposable.dispose();
      if (liveCwdProbeTimer !== null) {
        window.clearTimeout(liveCwdProbeTimer);
      }
      if (imagePasteFallbackTimer !== null) {
        window.clearTimeout(imagePasteFallbackTimer);
      }
      imagePasteFallbackSerial += 1;
      for (const off of unlistenFns) {
        try { off(); } catch { /* ignore */ }
      }
      invoke("pty_kill", { sessionId }).catch(() => {
        // Backend may not implement pty_kill yet — safe to ignore.
      });
      unpatchTerminalEmojiWidthMeasurements(term);
      unpatchMouseCoordinateScale();
      try { webLinksDisposable?.dispose(); } catch { /* ignore */ }
      webLinksDisposable = null;
      try { fileLinksDisposable?.dispose(); } catch { /* ignore */ }
      fileLinksDisposable = null;
      try { fitAddon.dispose(); } catch { /* ignore */ }
      try { serializeAddon.dispose(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      fitTerminalRef.current = null;
    };
  }, [sessionId, repoPath, cwd]);

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
    const refresh = () => {
      const term = termRef.current;
      const fit = fitTerminalRef.current;
      const container = containerRef.current;
      if (!term || !fit || !container) return;
      repaintTerminalViewport({
        container,
        fit,
        term,
        scrollToBottom: true,
      });
    };

    const scheduler = createTerminalRepaintScheduler(refresh);
    scheduler.schedule();
    return scheduler.dispose;
  }, [isActive]);

  // WKWebView can defer paints while the app window is not focused. App-level
  // scale changes also adjust the transformed coordinate space around xterm.
  // Force the same layout + full-row repaint used for tab activation, without
  // scrolling the user's viewport.
  useEffect(() => {
    if (!isActive) return;

    const refresh = () => {
      const term = termRef.current;
      const fit = fitTerminalRef.current;
      const container = containerRef.current;
      if (!term || !fit || !container) return;
      repaintTerminalViewport({ container, fit, term });
    };
    const scheduler = createTerminalRepaintScheduler(refresh);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") return;
      scheduler.schedule();
    };
    const onUiScaleChanged = () => {
      setLinkTooltip(null);
      scheduler.schedule();
    };

    window.addEventListener("focus", scheduler.schedule);
    window.addEventListener(UI_SCALE_CHANGED_EVENT, onUiScaleChanged);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", scheduler.schedule);
      window.removeEventListener(UI_SCALE_CHANGED_EVENT, onUiScaleChanged);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      scheduler.dispose();
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
      data-acorn-link-hover={linkTooltip ? "true" : undefined}
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
      {isScrolledBack ? (
        <Tooltip label="Scroll terminal to bottom" side="top" delay={150}>
          <button
            type="button"
            aria-label="Scroll terminal to bottom"
            onClick={() => {
              const term = termRef.current;
              if (!term) return;
              try {
                term.scrollToBottom();
                setIsScrolledBack(false);
              } catch {
                // Terminal may have been disposed between render and click.
              }
              term.focus();
            }}
            className="absolute bottom-5 right-4 z-20 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-elevated/95 text-fg-muted shadow-lg backdrop-blur-sm transition hover:bg-bg-sidebar hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent/60"
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      {linkTooltip ? (
        <FloatingTerminalLinkUnderlines
          linkKey={linkTooltip.linkKey}
          rects={linkTooltip.underlineRects}
        />
      ) : null}
      <FloatingTooltip
        label={`${MODIFIER_LINK_LABEL} to open link`}
        anchorRect={linkTooltip?.anchorRect ?? null}
        side="top"
        overlayClassName="xterm-hover"
        dismissOnScroll={false}
      />
      {/* Pinned-prompt overlay. */}
      <StickyUserPrompt sessionId={sessionId} agentProvider={agentProvider} />
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
