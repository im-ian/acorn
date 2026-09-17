import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyntheticDoubleClick } from "./doubleClick";

let container: HTMLDivElement;
let root: Root;

function Target({ onDoubleClick }: { onDoubleClick: () => void }) {
  return <div data-testid="target" onClick={useSyntheticDoubleClick(onDoubleClick)} />;
}

function click(at: { x: number; y: number; t: number }): void {
  const target = container.querySelector('[data-testid="target"]');
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
  });
  // jsdom stamps timeStamp at construction, so drive it explicitly instead of
  // sleeping through the 500ms window.
  Object.defineProperty(event, "timeStamp", { value: at.t });
  act(() => {
    target?.dispatchEvent(event);
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
});

describe("useSyntheticDoubleClick", () => {
  function render(): ReturnType<typeof vi.fn> {
    const onDoubleClick = vi.fn();
    act(() => {
      root.render(<Target onDoubleClick={onDoubleClick} />);
    });
    return onDoubleClick;
  }

  it("fires on two clicks inside the time and distance window", () => {
    const onDoubleClick = render();
    click({ x: 40, y: 40, t: 1000 });
    expect(onDoubleClick).not.toHaveBeenCalled();
    click({ x: 44, y: 37, t: 1200 });
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("ignores a second click that lands too late", () => {
    const onDoubleClick = render();
    click({ x: 40, y: 40, t: 1000 });
    click({ x: 40, y: 40, t: 1600 });
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("ignores a second click that drifts too far", () => {
    const onDoubleClick = render();
    click({ x: 40, y: 40, t: 1000 });
    click({ x: 40, y: 60, t: 1100 });
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("does not fire again on a third click", () => {
    const onDoubleClick = render();
    click({ x: 40, y: 40, t: 1000 });
    click({ x: 40, y: 40, t: 1100 });
    click({ x: 40, y: 40, t: 1200 });
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});
