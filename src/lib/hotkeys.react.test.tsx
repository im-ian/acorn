import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAppHotkeyBlocker,
  useHotkeys,
  type HotkeyBindings,
} from "./hotkeys";

function HotkeyHarness({
  bindings,
  blockAppHotkeys = false,
  terminalTarget = false,
}: {
  bindings: HotkeyBindings;
  blockAppHotkeys?: boolean;
  terminalTarget?: boolean;
}) {
  useAppHotkeyBlocker(blockAppHotkeys);
  useHotkeys(bindings);
  const input = <input aria-label="hotkey target" />;
  return terminalTarget ? <div className="acorn-terminal">{input}</div> : input;
}

describe("useHotkeys", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalPlatform = navigator.platform;

  function setPlatform(value: string) {
    Object.defineProperty(navigator, "platform", {
      value,
      configurable: true,
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setPlatform(originalPlatform);
  });

  function render(
    bindings: HotkeyBindings,
    blockAppHotkeys = false,
    terminalTarget = false,
  ): HTMLInputElement {
    act(() => {
      root.render(
        <HotkeyHarness
          bindings={bindings}
          blockAppHotkeys={blockAppHotkeys}
          terminalTarget={terminalTarget}
        />,
      );
    });
    const input = container.querySelector("input");
    if (!input) throw new Error("missing hotkey target");
    return input;
  }

  it("claims handled modifier shortcuts before focused descendants process them", () => {
    const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const input = render({ "Control+Shift+e": handler });
    const descendantHandler = vi.fn();
    input.addEventListener("keydown", descendantHandler, { capture: true });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "e",
        code: "KeyE",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(descendantHandler).not.toHaveBeenCalled();
  });

  it("leaves unmodified shortcuts on the normal bubble path", () => {
    const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const input = render({ Escape: handler });
    const descendantHandler = vi.fn();
    input.addEventListener("keydown", descendantHandler, { capture: true });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(descendantHandler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("blocks app-level modifier shortcuts while a modal is open", () => {
    const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const input = render({ "Control+Shift+e": handler }, true);
    const descendantHandler = vi.fn();
    input.addEventListener("keydown", descendantHandler, { capture: true });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "e",
        code: "KeyE",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(descendantHandler).not.toHaveBeenCalled();
  });

  it.each([
    { binding: "Control+c", key: "c", shiftKey: false },
    { binding: "Control+Shift+c", key: "c", shiftKey: true },
    { binding: "Control+v", key: "v", shiftKey: false },
    { binding: "Control+Shift+v", key: "v", shiftKey: true },
    { binding: "Control+x", key: "x", shiftKey: false },
    { binding: "Control+Shift+x", key: "x", shiftKey: true },
    { binding: "Control+k", key: "k", shiftKey: false },
    { binding: "Control+w", key: "w", shiftKey: false },
  ])(
    "defers $binding to a focused Windows terminal",
    ({ binding, key, shiftKey }) => {
      setPlatform("Win32");
      const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
      const input = render({ [binding]: handler }, false, true);
      const descendantHandler = vi.fn();
      input.addEventListener("keydown", descendantHandler, { capture: true });

      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: `Key${key.toUpperCase()}`,
          ctrlKey: true,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(handler).not.toHaveBeenCalled();
      expect(descendantHandler).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps Ctrl+Shift+T as an app shortcut in a Windows terminal", () => {
    setPlatform("Win32");
    const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const input = render({ "Control+Shift+t": handler }, false, true);
    const descendantHandler = vi.fn();
    input.addEventListener("keydown", descendantHandler, { capture: true });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(descendantHandler).not.toHaveBeenCalled();
  });

  it("keeps the same binding active outside a Windows terminal", () => {
    setPlatform("Win32");
    const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const input = render({ "Control+Shift+c": handler });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "c",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not apply the Windows terminal policy on macOS", () => {
    setPlatform("MacIntel");
    const handler = vi.fn((event: KeyboardEvent) => event.preventDefault());
    const input = render({ "Control+Shift+c": handler }, false, true);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "c",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
