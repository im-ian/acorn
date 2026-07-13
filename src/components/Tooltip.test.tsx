import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function renderTooltip(delay?: number) {
    act(() => {
      root.render(
        <Tooltip label="Tooltip details" delay={delay}>
          <button type="button">Trigger</button>
        </Tooltip>,
      );
    });
  }

  function hoverTrigger() {
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("trigger not found");
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
      );
    });
  }

  function leaveTrigger() {
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("trigger not found");
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, cancelable: true }),
      );
    });
  }

  function contextMenuTrigger() {
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("trigger not found");
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
  }

  function tooltip() {
    return document.body.querySelector('[role="tooltip"]');
  }

  it("waits one second before showing when no delay is specified", () => {
    renderTooltip();
    hoverTrigger();

    act(() => vi.advanceTimersByTime(999));
    expect(tooltip()).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(tooltip()?.textContent).toBe("Tooltip details");
  });

  it("uses an explicit delay when provided", () => {
    renderTooltip(150);
    hoverTrigger();

    act(() => vi.advanceTimersByTime(149));
    expect(tooltip()).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(tooltip()?.textContent).toBe("Tooltip details");
  });

  it("renders a keyboard shortcut hint next to the label", () => {
    act(() => {
      root.render(
        <Tooltip label="Close" shortcut="⌘W" delay={0}>
          <button type="button">Trigger</button>
        </Tooltip>,
      );
    });
    hoverTrigger();
    act(() => vi.advanceTimersByTime(0));

    expect(tooltip()?.textContent).toBe("Close⌘W");
    expect(tooltip()?.querySelector("kbd")?.textContent).toBe("⌘W");
  });

  it("does not show when hover leaves before the delay completes", () => {
    renderTooltip(500);
    hoverTrigger();

    act(() => vi.advanceTimersByTime(499));
    leaveTrigger();
    act(() => vi.advanceTimersByTime(1));

    expect(tooltip()).toBeNull();
  });

  it("cancels a pending hover tooltip when the context menu opens", () => {
    renderTooltip(500);
    hoverTrigger();

    act(() => vi.advanceTimersByTime(250));
    contextMenuTrigger();
    act(() => vi.advanceTimersByTime(250));

    expect(tooltip()).toBeNull();
  });

  it("uses a block-level multiline surface so long content can wrap", () => {
    act(() => {
      root.render(
        <Tooltip label="very/long/path/that/should/wrap" delay={0} multiline>
          <button type="button">Trigger</button>
        </Tooltip>,
      );
    });
    hoverTrigger();
    act(() => vi.advanceTimersByTime(0));

    expect(tooltip()?.className).toContain("inline-block");
    expect(tooltip()?.className).toContain("max-w-[min(34rem,calc(100vw-1rem))]");
  });
});
