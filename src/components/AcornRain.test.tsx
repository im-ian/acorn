import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcornRain } from "./AcornRain";

describe("AcornRain resource lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps only three active rain batches during repeated triggers", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => root?.render(<AcornRain />));

    act(() => {
      for (let i = 0; i < 5; i += 1) {
        window.dispatchEvent(new Event("acorn:shake-tree"));
      }
    });

    expect(vi.getTimerCount()).toBe(3);
  });

  it("uses unique React keys for batches triggered in the same millisecond", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => root?.render(<AcornRain />));

    act(() => {
      window.dispatchEvent(new Event("acorn:shake-tree"));
      window.dispatchEvent(new Event("acorn:shake-tree"));
    });

    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });

  it("clears batch cleanup timers when the host unmounts", () => {
    act(() => root?.render(<AcornRain />));
    act(() => window.dispatchEvent(new Event("acorn:shake-tree")));
    expect(vi.getTimerCount()).toBe(1);

    act(() => root?.unmount());
    root = null;

    expect(vi.getTimerCount()).toBe(0);
  });
});
