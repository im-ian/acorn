import { useEffect, useRef, type ReactElement } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { registerScrollbackFlusher } from "../lib/scrollback-coordinator";
import { resolveStartupCommand, useSettings } from "../lib/settings";
import type { SessionStartupMode } from "../lib/types";

interface TerminalProps {
  sessionId: string;
  cwd: string;
  /**
   * Per-session startup mode persisted on `Session.startup_mode`. `null`
   * (or omitted) means the session has no recorded preference (legacy
   * sessions created before this field existed) — the spawn falls back
   * to the global `sessionStartup.mode` setting in that case.
   */
  startupMode?: SessionStartupMode | null;
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
  startupMode = null,
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
      fontWeight: initialSettings.terminal.fontWeight,
      fontWeightBold: initialSettings.terminal.fontWeightBold,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(serializeAddon);
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
      if (next.fontWeight !== previous.fontWeight) {
        term.options.fontWeight = next.fontWeight;
        changed = true;
      }
      if (next.fontWeightBold !== previous.fontWeightBold) {
        term.options.fontWeightBold = next.fontWeightBold;
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

    // macOS WKWebView delivers Korean IME via two different inputType
    // families depending on system/IME mode. We support both:
    //
    // Family A — composition-clean (W3C spec):
    //   insertCompositionText / deleteCompositionText / insertFromComposition
    //   `ev.data` on commit holds the full composed syllable.
    //
    // Family B — replacement-based:
    //   insertText (start of new syllable / committing previous trailing)
    //   insertReplacementText (composing in progress, replacing trailing)
    //   No clean commit event — we infer commits from textarea diff.
    //
    // For Family B we maintain `sentPrefix` so we know which characters
    // were already forwarded to the PTY. The `lastKeyCode229` flag
    // differentiates an IME-driven `insertText` from a plain ASCII one.
    let sentPrefix = "";
    let lastKeyCode229 = false;
    // Hangul jamo, Hangul syllables, Hiragana, Katakana, CJK ideographs.
    // Used to recognise IME-driven `insertText` events even when the
    // accompanying `keydown` (with keyCode 229) hasn't fired yet — on
    // WKWebView the `input` event sometimes arrives BEFORE its keydown.
    const CJK_DATA_RE =
      /[ᄀ-ᇿ㄰-㆏가-힯぀-ゟ゠-ヿ一-鿿]/;

    const flushTrailing = () => {
      const ta = container.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (!ta) return;
      const value = ta.value;
      if (value.length > sentPrefix.length) {
        sendToPty(value.slice(sentPrefix.length));
      }
      sentPrefix = "";
      ta.value = "";
      hideComposing();
    };

    const onInput = (e: Event) => {
      const ev = e as InputEvent;
      const ta = container.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      switch (ev.inputType) {
        // Family A — composition-clean
        case "insertCompositionText":
          showComposing(ev.data ?? "");
          ev.stopImmediatePropagation();
          return;
        case "deleteCompositionText":
          ev.stopImmediatePropagation();
          return;
        case "insertFromComposition":
          if (ev.data) sendToPty(ev.data);
          hideComposing();
          ev.stopImmediatePropagation();
          return;

        // Family B — replacement-based
        case "insertReplacementText": {
          // In-syllable replacement; trailing char being recomposed.
          // Don't commit; show preview of trailing.
          if (ta) showComposing(ta.value.slice(sentPrefix.length));
          ev.stopImmediatePropagation();
          return;
        }
        case "insertText": {
          // Plain ASCII vs IME first-jamo. We treat it as IME when EITHER
          // a keyCode-229 keydown was just observed OR `ev.data` itself is
          // a CJK character. WKWebView occasionally fires `input` before
          // the corresponding keydown, so the flag alone is unreliable
          // for the very first jamo of a session.
          const isIme =
            lastKeyCode229 || (!!ev.data && CJK_DATA_RE.test(ev.data));
          if (!isIme) {
            // Plain ASCII char that xterm's keypress already emitted to
            // the PTY. The browser still appends it to the helper textarea
            // though (input is non-cancelable), so we must advance
            // sentPrefix or the next IME insertText will re-emit it as
            // part of its committed-prefix diff.
            hideComposing();
            if (ta) sentPrefix = ta.value;
            return;
          }
          if (!ta) return;
          const value = ta.value;
          const newCharLen = ev.data?.length ?? 0;
          const committedEnd = value.length - newCharLen;
          if (committedEnd > sentPrefix.length) {
            sendToPty(value.slice(sentPrefix.length, committedEnd));
            sentPrefix = value.slice(0, committedEnd);
          }
          showComposing(value.slice(sentPrefix.length));
          ev.stopImmediatePropagation();
          return;
        }
        default:
          hideComposing();
          return;
      }
    };

    const onKeydown = (e: Event) => {
      const ev = e as KeyboardEvent;
      // keyCode 229 = IME composing key. xterm's keydown handler reacts
      // to this with a `_handleAnyTextareaChanges` setTimeout that would
      // emit duplicate text. Stop it at capture phase, AND remember it so
      // a following `insertText` is treated as IME first-jamo (Family B).
      //
      // EXCEPT: macOS reports keyCode 229 even for the terminator
      // keystroke that finalizes the composition (space, Enter, etc.)
      // when the user has uncommitted IME state. If we treat such a key
      // as IME, the subsequent `input` event takes the IME branch and
      // re-emits the terminator on top of xterm's own keypress emit,
      // producing duplicate spaces / Enters. Detect ASCII-printable keys
      // and fall through to the non-IME path instead.
      if (ev.keyCode === 229) {
        const isAsciiTerminator =
          ev.key.length === 1 && ev.key.charCodeAt(0) < 0x80;
        if (!isAsciiTerminator) {
          lastKeyCode229 = true;
          ev.stopImmediatePropagation();
          return;
        }
        // ASCII terminator under IME — treat as non-IME; the previous
        // syllable still needs flushing, which happens below because
        // `lastKeyCode229` remains true from the prior real IME keydown.
      }
      // Non-IME key. If we just left IME mode (last keydown was 229),
      // flush whatever Korean syllable is mid-composition so it lands in
      // the PTY before this key's effect (space, Enter, English…).
      // Otherwise leave the textarea alone — xterm's own keypress handler
      // will emit the printable char, and we sync sentPrefix to the
      // textarea length so the next IME insertText diff treats those
      // already-emitted chars as committed.
      if (lastKeyCode229) {
        flushTrailing();
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
        sendToPty("\n");
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
          sendToPty("\x01");
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
        if (ev.key === "ArrowRight") {
          sendToPty("\x05");
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

    const inputDisposable = term.onData((data: string) => {
      sendToPty(data);
    });

    // Re-anchor the composition preview to the cursor on every xterm render.
    // The cursor advances asynchronously after a commit (PTY echo → emit →
    // term.write); without this, the preview stays painted at the previous
    // cursor cell and visually appears one column to the left of the new
    // cursor until the user types again.
    const renderDisposable = term.onRender(() => {
      if (!compositionView || !compositionView.classList.contains("active")) {
        return;
      }
      const cell = getCellDims();
      if (!cell) return;
      const cursorX = term.buffer.active.cursorX;
      const cursorY = term.buffer.active.cursorY;
      compositionView.style.left = `${cursorX * cell.width}px`;
      compositionView.style.top = `${cursorY * cell.height}px`;
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
      if (disposed) return;
      try {
        const startup = resolveStartupCommand(
          useSettings.getState().settings,
          startupMode,
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
          if (disposed) return;
          args = exists
            ? [...startup.args, "--resume", sessionId]
            : [...startup.args, "--session-id", sessionId];
        }
        if (disposed) return;
        await invoke("pty_spawn", {
          sessionId,
          cwd,
          command: startup.command,
          args,
          env: {},
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
              term.write(bytes);
              // Output landed in the buffer — schedule a debounced save
              // so the new content reaches disk ~1s after activity ends.
              scheduleScrollbackSave();
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
          exited = true;
          term.write(
            `\r\n${ANSI_DIM}[process exited — press Enter to restart]${ANSI_RESET}\r\n`,
          );
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

      // Restore prior scrollback before spawning so the user sees the
      // previous session's output immediately on app restart. The dim
      // separator marks where the live PTY output begins.
      try {
        const saved = await invoke<string | null>("scrollback_load", {
          sessionId,
        });
        if (disposed) return;
        if (saved && saved.length > 0) {
          term.write(saved);
          term.write(
            `\r\n${ANSI_DIM}— restored from previous session —${ANSI_RESET}\r\n`,
          );
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
        await invoke("scrollback_save", { sessionId, data });
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
      unregisterScrollbackFlusher();
      if (scrollbackSaveTimer !== null) {
        window.clearTimeout(scrollbackSaveTimer);
        scrollbackSaveTimer = null;
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
      window.removeEventListener("acorn:terminal-clear", onClearRequested);
      inputDisposable.dispose();
      renderDisposable.dispose();
      resizeDisposable.dispose();
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
