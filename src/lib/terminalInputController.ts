import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";
import {
  getTerminalShortcutAction,
  isImeTerminatorKeydown,
  isImeTextData,
  isModifierOnlyKeydown,
  isPlainSpaceKeydown,
  isPlainSpaceText,
} from "./terminalInput";

interface TerminalInputControllerOptions {
  container: HTMLElement;
  term: XTerm;
  sendUserInputToPty(data: string): void;
  sendKeyboardInputToPty(data: string): void;
  scrollToLiveTail(): void;
}

interface XTermRenderInternals {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: { width: number; height: number };
        };
      };
    };
  };
}

function getHelperTextarea(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
}

function getCellDims(term: XTerm): { width: number; height: number } | null {
  // xterm v6 exposes render dimensions only via internals.
  const core = (term as unknown as XTermRenderInternals)._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  return cell ? { width: cell.width, height: cell.height } : null;
}

function createCompositionPreview(term: XTerm, view: HTMLElement | null) {
  const position = () => {
    if (!view) return;
    const cell = getCellDims(term);
    if (!cell) return;
    const buf = term.buffer.active;
    // xterm's visible cursor row = `baseY + cursorY - viewportY`.
    const cursorViewportY = buf.baseY + buf.cursorY - buf.viewportY;
    view.style.left = `${buf.cursorX * cell.width}px`;
    view.style.top = `${cursorViewportY * cell.height}px`;
    view.style.minHeight = `${cell.height}px`;
    view.style.lineHeight = `${cell.height}px`;
  };

  const hide = () => {
    if (!view) return;
    view.classList.remove("active");
    view.textContent = "";
  };

  const show = (text: string) => {
    if (!view) return;
    if (text.length === 0) {
      hide();
      return;
    }
    view.textContent = text;
    position();

    const fontFamily = term.options.fontFamily;
    const fontSize = term.options.fontSize;
    const fontWeight = term.options.fontWeight;
    if (typeof fontFamily === "string") {
      view.style.fontFamily = fontFamily;
    }
    if (typeof fontSize === "number") {
      view.style.fontSize = `${fontSize}px`;
    }
    if (typeof fontWeight === "number" || typeof fontWeight === "string") {
      view.style.fontWeight = String(fontWeight);
    }
    view.classList.add("active");
  };

  const reposition = () => {
    if (!view?.classList.contains("active")) return;
    position();
  };

  return { show, hide, reposition };
}

export function attachTerminalInputController({
  container,
  term,
  sendUserInputToPty,
  sendKeyboardInputToPty,
  scrollToLiveTail,
}: TerminalInputControllerOptions): IDisposable {
  const preview = createCompositionPreview(
    term,
    container.querySelector<HTMLElement>(".composition-view"),
  );

  // WKWebView delivers a single Korean syllable across a mix of
  // `inputType`s. This state owns the contract between browser events,
  // xterm's helper textarea, and PTY writes:
  //
  // - preview events update `.composition-view` only
  // - commit events flush the unsent textarea tail once
  // - direct keydown writes reserve ownership of the following input echo
  let sentPrefix = "";
  let lastKeyCode229 = false;
  let composing = false;
  let composingText = "";
  let pendingDirectSpaceInputEvents = 0;
  let suppressNextPlainSpaceKeydown = false;
  let suppressNextPlainSpaceKeydownTimer: number | null = null;

  const readUnsentTail = (ta: HTMLTextAreaElement | null): string =>
    ta && ta.value.length > sentPrefix.length
      ? ta.value.slice(sentPrefix.length)
      : "";

  const syncSentPrefix = (ta: HTMLTextAreaElement | null) => {
    if (ta) sentPrefix = ta.value;
  };

  const showComposing = (text: string) => {
    composingText = text;
    preview.show(text);
  };

  const hideComposing = () => {
    composingText = "";
    preview.hide();
  };

  const splitTrailingPlainSpace = (text: string) => {
    const last = text.slice(-1);
    if (!isPlainSpaceText(last)) {
      return { beforeSpace: text, hadSpace: false };
    }
    return { beforeSpace: text.slice(0, -1), hadSpace: true };
  };

  const clearSuppressedSpaceKeydown = () => {
    suppressNextPlainSpaceKeydown = false;
    if (suppressNextPlainSpaceKeydownTimer !== null) {
      window.clearTimeout(suppressNextPlainSpaceKeydownTimer);
      suppressNextPlainSpaceKeydownTimer = null;
    }
  };

  const suppressMatchingSpaceKeydown = () => {
    clearSuppressedSpaceKeydown();
    suppressNextPlainSpaceKeydown = true;
    suppressNextPlainSpaceKeydownTimer = window.setTimeout(() => {
      suppressNextPlainSpaceKeydown = false;
      suppressNextPlainSpaceKeydownTimer = null;
    }, 250);
  };

  const commitComposition = (explicit?: string) => {
    if (!composing) return;
    const ta = getHelperTextarea(container);
    const data = readUnsentTail(ta) || explicit || composingText || "";
    if (data) sendUserInputToPty(data);
    if (ta) ta.value = "";
    sentPrefix = "";
    composing = false;
    hideComposing();
  };

  const consumePendingDirectSpaceInput = (
    ev: InputEvent,
    ta: HTMLTextAreaElement | null,
  ): boolean => {
    if (
      pendingDirectSpaceInputEvents <= 0 ||
      ev.inputType !== "insertText"
    ) {
      return false;
    }

    const insertedText = ev.data ?? readUnsentTail(ta);
    if (!isPlainSpaceText(insertedText)) {
      pendingDirectSpaceInputEvents = 0;
      return false;
    }

    pendingDirectSpaceInputEvents -= 1;
    hideComposing();
    composing = false;
    syncSentPrefix(ta);
    ev.stopImmediatePropagation();
    return true;
  };

  const consumePreKeydownTerminatorSpaceInput = (
    ev: InputEvent,
    ta: HTMLTextAreaElement | null,
  ): boolean => {
    if (
      ev.inputType !== "insertText" ||
      !lastKeyCode229 ||
      !composing
    ) {
      return false;
    }

    const tail = readUnsentTail(ta);
    const { beforeSpace, hadSpace } = splitTrailingPlainSpace(tail);
    if (!isPlainSpaceText(ev.data ?? "") && !hadSpace) {
      return false;
    }

    const composed = beforeSpace || composingText;
    if (composed) sendUserInputToPty(composed);
    sendKeyboardInputToPty(" ");
    if (ta) ta.value = "";
    sentPrefix = "";
    lastKeyCode229 = false;
    composing = false;
    hideComposing();
    suppressMatchingSpaceKeydown();
    ev.stopImmediatePropagation();
    return true;
  };

  const handleInput = (ev: InputEvent, ta: HTMLTextAreaElement | null) => {
    switch (ev.inputType) {
      case "insertCompositionText":
        composing = true;
        showComposing(ev.data ?? "");
        ev.stopImmediatePropagation();
        return;

      case "deleteCompositionText":
        ev.stopImmediatePropagation();
        return;

      case "insertReplacementText": {
        composing = true;
        if (ta) {
          if (!ta.value.startsWith(sentPrefix)) sentPrefix = "";
          showComposing(ta.value.slice(sentPrefix.length));
        }
        ev.stopImmediatePropagation();
        return;
      }

      case "insertText": {
        const isIme = lastKeyCode229 || isImeTextData(ev.data);
        if (!isIme) {
          hideComposing();
          composing = false;
          syncSentPrefix(ta);
          return;
        }

        composing = true;
        if (!ta) return;
        const value = ta.value;
        const newCharLen = ev.data?.length ?? 0;
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
        commitComposition(ev.data ?? undefined);
        ev.stopImmediatePropagation();
        return;

      default:
        hideComposing();
        return;
    }
  };

  const onInput = (e: Event) => {
    const ev = e as InputEvent;
    const ta = getHelperTextarea(container);
    if (consumePendingDirectSpaceInput(ev, ta)) return;
    if (consumePreKeydownTerminatorSpaceInput(ev, ta)) return;
    handleInput(ev, ta);
  };

  const handleImeKeydown = (
    ev: KeyboardEvent,
    ta: HTMLTextAreaElement | null,
  ): boolean => {
    if (ev.keyCode !== 229) return false;

    const hasComposition = !!ta?.value;
    if (ev.key === "Backspace" && hasComposition) {
      showComposing(ta.value.slice(sentPrefix.length));
      lastKeyCode229 = true;
      ev.stopImmediatePropagation();
      return true;
    }

    if (!isImeTerminatorKeydown(ev)) {
      lastKeyCode229 = true;
      ev.stopImmediatePropagation();
      return true;
    }

    return false;
  };

  const onKeydown = (e: Event) => {
    const ev = e as KeyboardEvent;
    pendingDirectSpaceInputEvents = 0;
    const ta = getHelperTextarea(container);

    if (suppressNextPlainSpaceKeydown) {
      if (isPlainSpaceKeydown(ev)) {
        clearSuppressedSpaceKeydown();
        syncSentPrefix(ta);
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      clearSuppressedSpaceKeydown();
    }

    if (handleImeKeydown(ev, ta)) return;
    if (isModifierOnlyKeydown(ev)) return;

    if (lastKeyCode229 && composing) {
      commitComposition();
    }
    lastKeyCode229 = false;
    syncSentPrefix(ta);

    if (isPlainSpaceKeydown(ev)) {
      pendingDirectSpaceInputEvents += 1;
      sendKeyboardInputToPty(" ");
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }

    const shortcut = getTerminalShortcutAction(ev);
    if (!shortcut) return;

    if (shortcut.kind === "write") {
      sendUserInputToPty(shortcut.data);
    } else {
      scrollToLiveTail();
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  const swallowComposition = (e: Event) => {
    e.stopImmediatePropagation();
  };

  container.addEventListener("input", onInput, true);
  container.addEventListener("keydown", onKeydown, true);
  container.addEventListener("compositionstart", swallowComposition, true);
  container.addEventListener("compositionupdate", swallowComposition, true);
  container.addEventListener("compositionend", swallowComposition, true);

  const renderDisposable = term.onRender(() => preview.reposition());
  const scrollDisposable = term.onScroll(() => preview.reposition());
  const cursorMoveDisposable = term.onCursorMove(() => preview.reposition());

  return {
    dispose() {
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("keydown", onKeydown, true);
      container.removeEventListener("compositionstart", swallowComposition, true);
      container.removeEventListener("compositionupdate", swallowComposition, true);
      container.removeEventListener("compositionend", swallowComposition, true);
      renderDisposable.dispose();
      scrollDisposable.dispose();
      cursorMoveDisposable.dispose();
      clearSuppressedSpaceKeydown();
    },
  };
}
