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
}: {
  bindings: HotkeyBindings;
  blockAppHotkeys?: boolean;
}) {
  useAppHotkeyBlocker(blockAppHotkeys);
  useHotkeys(bindings);
  return <input aria-label="hotkey target" />;
}

describe("useHotkeys", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    bindings: HotkeyBindings,
    blockAppHotkeys = false,
  ): HTMLInputElement {
    act(() => {
      root.render(
        <HotkeyHarness
          bindings={bindings}
          blockAppHotkeys={blockAppHotkeys}
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
});
