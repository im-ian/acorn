import { useEffect, useRef, type ReactElement } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { resolveStartupCommand, useSettings } from "../lib/settings";

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
}

interface PtyOutputPayload {
  data: string;
}

const TERMINAL_BG = "#1f2326";

const TERMINAL_THEME: ITheme = {
  background: TERMINAL_BG, foreground: "#ededed", cursor: "#ededed",
  cursorAccent: TERMINAL_BG, selectionBackground: "#3a3f44",
  black: TERMINAL_BG, red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#ededed",
  brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
  brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
  brightCyan: "#56b6c2", brightWhite: "#ffffff",
};

const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

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
}: TerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Snapshot terminal font preferences at mount; subsequent setting changes
    // are applied live via the subscription below.
    const initialSettings = useSettings.getState().settings;
    const term = new XTerm({
      theme: TERMINAL_THEME,
      fontFamily: initialSettings.terminal.fontFamily,
      fontSize: initialSettings.terminal.fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    termRef.current = term;
    fitRef.current = fitAddon;

    // The DOM renderer (default) anchors xterm's hidden textarea at the
    // cursor cell, so IME composition popups (CJK input) render at the
    // correct location and intermediate characters are not flushed to the
    // PTY mid-composition. The canvas/webgl addons are faster but mis-handle
    // composition events on macOS/Linux IMEs — we pick correctness over fps.
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // initial fit can fail if container has zero size; ResizeObserver will retry.
    }

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
      if (changed) {
        try {
          fitAddon.fit();
        } catch {
          // ignore — ResizeObserver will retry
        }
      }
    });

    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];

    const sendToPty = (data: string) => {
      if (data.length === 0) return;
      invoke("pty_write", {
        sessionId,
        data: encodeStringToBase64(data),
      }).catch((err: unknown) => {
        console.error("[Terminal] pty_write failed", err);
      });
    };

    // CJK IME workaround for WKWebView (Tauri/macOS).
    //
    // WKWebView delivers IME activity through W3C InputEvents on the
    // helper textarea, NOT compositionstart/update/end. The relevant
    // inputTypes:
    //   - `insertCompositionText` → composition preview is updating
    //                                (e.g. ㅇ → 아 → 안 as user types)
    //   - `deleteCompositionText` → preview is being cleared just before
    //                                a commit lands
    //   - `insertFromComposition` → final commit; `ev.data` is the
    //                                fully-composed text (the syllable)
    //
    // xterm.js v6 only handles plain `insertText`; the W3C composition
    // input types are dropped, so Korean/Japanese/Chinese commits never
    // reach the PTY. We process them ourselves and surface a live
    // preview by reusing xterm's hidden `.composition-view` element.
    const compositionView = container.querySelector<HTMLElement>(
      ".composition-view",
    );
    const helperTextarea = container.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    // Drain helper textarea after non-IME input (paste, plain insertText,
    // delete) and after each IME commit. Without this, the textarea
    // accumulates content (especially after a paste) and the macOS IME
    // anchors the next composition at a stale cursor offset, which
    // produces broken Korean syllables once the user resumes typing.
    // Schedule via setTimeout(0) so xterm's own input handler — which we
    // intentionally let run for non-IME types — finishes reading the
    // textarea first.
    const drainTextarea = () => {
      if (!helperTextarea) return;
      window.setTimeout(() => {
        helperTextarea.value = "";
      }, 0);
    };
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
        const cursorX = term.buffer.active.cursorX;
        const cursorY = term.buffer.active.cursorY;
        compositionView.style.left = `${cursorX * cell.width}px`;
        compositionView.style.top = `${cursorY * cell.height}px`;
        compositionView.style.minHeight = `${cell.height}px`;
        compositionView.style.lineHeight = `${cell.height}px`;
      }
      compositionView.classList.add("active");
    };
    const hideComposing = () => {
      if (!compositionView) return;
      compositionView.classList.remove("active");
      compositionView.textContent = "";
    };

    const onInput = (e: Event) => {
      const ev = e as InputEvent;
      switch (ev.inputType) {
        case "insertCompositionText":
          // Live preview update — e.g. user typed another jamo and the
          // syllable shape changed (ㅇ → 아 → 안). Show but don't commit.
          showComposing(ev.data ?? "");
          ev.stopImmediatePropagation();
          return;
        case "deleteCompositionText":
          // Preview being torn down just before a commit. Don't send.
          ev.stopImmediatePropagation();
          return;
        case "insertFromComposition":
          // Composition committed. ev.data is the final syllable.
          if (ev.data) sendToPty(ev.data);
          hideComposing();
          drainTextarea();
          ev.stopImmediatePropagation();
          return;
        default:
          // Plain insertText (ASCII paste / non-IME), deleteContentBackward,
          // etc. Let xterm's own _inputEvent handle it. We deliberately do
          // NOT drain the textarea here: a setTimeout(0) drain races with
          // the user's next IME composition keystroke and can clear the
          // textarea mid-composition, which makes the next syllable's
          // jamo arrive split (e.g. ㄱㅏ instead of 가).
          hideComposing();
          return;
      }
    };

    const onKeydown = (e: Event) => {
      const ev = e as KeyboardEvent;
      // keyCode 229 = IME composing key. xterm's keydown handler reacts
      // to this with a `_handleAnyTextareaChanges` setTimeout that would
      // emit duplicate text. Stop it at capture phase.
      if (ev.keyCode === 229) {
        ev.stopImmediatePropagation();
        return;
      }
      // Shift+Enter: insert newline (LF) instead of submitting (CR). xterm
      // by default emits \r for both Enter and Shift+Enter, so TUIs like
      // Claude CLI cannot tell them apart. Send a literal LF and stop the
      // event so xterm does not emit its own \r on top.
      if (ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        sendToPty("\n");
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
    };

    // Register on `container` (ancestor of helperTextarea) with capture=true
    // so we run before xterm's textarea-capture listeners.
    container.addEventListener("input", onInput, true);
    container.addEventListener("keydown", onKeydown, true);

    const inputDisposable = term.onData((data: string) => {
      sendToPty(data);
    });

    // Custom event hook so a global hotkey (Cmd+K) can clear THIS terminal
    // without needing a cross-component ref registry. The dispatcher passes
    // the target sessionId in `detail.sessionId`; terminals match against
    // their own to avoid clearing siblings.
    const onClearRequested = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      term.clear();
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
          fitAddon.fit();
        } catch (err) {
          console.error("[Terminal] fit failed", err);
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    let exited = false;

    async function spawnPty() {
      try {
        const startup = resolveStartupCommand(
          useSettings.getState().settings,
        );
        // When launching the `claude` CLI, pin the transcript path to our
        // session UUID. claude refuses `--session-id` for an id that
        // already has a transcript on disk, so we switch to `--resume <id>`
        // for restart-after-exit (and reopens of existing sessions).
        const isClaude =
          /(?:^|\/)claude$/i.test(startup.command.trim()) &&
          !startup.args.some(
            (a) => a === "--session-id" || a === "--resume" || a === "-r",
          );
        let args = startup.args;
        if (isClaude) {
          let exists = false;
          try {
            exists = await invoke<boolean>("claude_session_exists", {
              cwd,
              sessionId,
            });
          } catch (e) {
            console.error("[Terminal] claude_session_exists failed", e);
          }
          args = exists
            ? [...startup.args, "--resume", sessionId]
            : [...startup.args, "--session-id", sessionId];
        }
        await invoke("pty_spawn", {
          sessionId,
          cwd,
          command: startup.command,
          args,
          env: {},
        });
        exited = false;
      } catch (err) {
        if (!disposed) {
          term.write(
            `\r\n${ANSI_RED}[acorn] Failed to spawn pty: ${formatError(err)}${ANSI_RESET}\r\n`,
          );
        }
      }
    }

    (async () => {
      try {
        const unlistenOutput = await listen<PtyOutputPayload>(
          `pty:output:${sessionId}`,
          (event) => {
            if (disposed) return;
            try {
              const bytes = decodeBase64ToBytes(event.payload.data);
              term.write(bytes);
            } catch (err) {
              console.error("[Terminal] decode payload failed", err);
            }
          },
        );
        unlistenFns.push(unlistenOutput);

        const unlistenExit = await listen(`pty:exit:${sessionId}`, () => {
          if (disposed) return;
          exited = true;
          term.write(
            `\r\n${ANSI_DIM}[process exited — press Enter to restart]${ANSI_RESET}\r\n`,
          );
        });
        unlistenFns.push(unlistenExit);
      } catch (err) {
        if (!disposed) {
          term.write(
            `\r\n${ANSI_RED}[acorn] Failed to attach pty listeners: ${formatError(err)}${ANSI_RESET}\r\n`,
          );
        }
      }

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

      await spawnPty();
    })();

    return () => {
      disposed = true;
      unsubSettings();
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      resizeObserver.disconnect();
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("acorn:terminal-clear", onClearRequested);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      for (const off of unlistenFns) {
        try { off(); } catch { /* ignore */ }
      }
      invoke("pty_kill", { sessionId }).catch(() => {
        // Backend may not implement pty_kill yet — safe to ignore.
      });
      try { fitAddon.dispose(); } catch { /* ignore */ }
      try { webLinksAddon.dispose(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, cwd]);

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

  return (
    <div
      ref={containerRef}
      className="acorn-terminal h-full w-full"
      style={{ padding: "16px 8px", background: TERMINAL_BG }}
    />
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
