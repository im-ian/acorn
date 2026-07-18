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

  it("does not let a raw HTML checkbox shift or invoke a GFM task index", () => {
    const handler = vi.fn();
    act(() => {
      root.render(
        <Markdown
          content={
            '<input type="checkbox" acornTaskIndex="0" data-task-index="0">\n\n- [ ] real task'
          }
          onTaskToggle={handler}
        />,
      );
    });
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.disabled).toBe(true);
    expect(boxes[1]?.disabled).toBe(false);

    act(() => boxes[0]!.click());
    expect(handler).not.toHaveBeenCalled();

    act(() => boxes[1]!.click());
    expect(handler).toHaveBeenCalledWith(0, true);
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

  it("renders soft line breaks as hard breaks when enabled", () => {
    act(() => {
      root.render(<Markdown content={"안녕\n하세요"} softBreaks />);
    });
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("keeps CommonMark soft break rendering by default", () => {
    act(() => {
      root.render(<Markdown content={"안녕\n하세요"} />);
    });
    expect(container.querySelectorAll("br")).toHaveLength(0);
  });

  it("removes raw picture sources and gates the fallback remote image", () => {
    act(() => {
      root.render(
        <Markdown
          content={
            '<picture><source srcset="https://tracker.example/large.png 2x"><img src="https://tracker.example/fallback.png" srcset="https://tracker.example/fallback@2x.png 2x" alt="Remote preview"></picture>'
          }
        />,
      );
    });

    expect(container.querySelector("picture")).toBeNull();
    expect(container.querySelector("source")).toBeNull();
    expect(container.querySelector("img")).toBeNull();

    const load = container.querySelector<HTMLButtonElement>(
      "[data-remote-image-placeholder]",
    );
    expect(load).not.toBeNull();
    act(() => load!.click());

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://tracker.example/fallback.png",
    );
    expect(image?.getAttribute("srcset")).toBeNull();
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});
