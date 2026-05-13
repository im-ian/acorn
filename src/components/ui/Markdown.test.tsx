import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown — interactive task list", () => {
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

  it("renders task checkboxes as enabled when onTaskToggle is supplied", () => {
    act(() => {
      root.render(
        <Markdown
          content={"- [ ] one\n- [x] two"}
          onTaskToggle={() => {}}
        />,
      );
    });
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.disabled).toBe(false);
    }
    expect(boxes[0]?.checked).toBe(false);
    expect(boxes[1]?.checked).toBe(true);
  });

  it("invokes onTaskToggle with the correct index when clicked", () => {
    const handler = vi.fn();
    act(() => {
      root.render(
        <Markdown
          content={"- [ ] one\n- [ ] two\n- [ ] three"}
          onTaskToggle={handler}
        />,
      );
    });
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    act(() => {
      boxes[1]!.click();
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1, true);
  });

  it("keeps checkboxes read-only when no handler is given", () => {
    act(() => {
      root.render(<Markdown content={"- [ ] one"} />);
    });
    const box = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(box?.disabled).toBe(true);
  });
});
