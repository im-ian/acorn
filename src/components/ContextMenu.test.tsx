import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

describe("ContextMenu", () => {
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

  function render(items: ContextMenuItem[]) {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <ContextMenu open x={20} y={30} items={items} onClose={onClose} />,
      );
    });
    return onClose;
  }

  it("renders group titles without making them actionable menu items", () => {
    render([
      { type: "group-title", label: "Session" },
      { label: "Rename", onClick: vi.fn() },
      { type: "separator" },
      { type: "group-title", label: "Danger zone" },
      { label: "Remove", onClick: vi.fn(), disabled: true },
    ]);

    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Session");
    expect(menu?.textContent).toContain("Danger zone");
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Rename", "Remove"]);
  });

  it("keeps button click behavior unchanged", () => {
    const onClick = vi.fn();
    const onClose = render([
      { type: "group-title", label: "Actions" },
      { label: "Rename", onClick },
    ]);

    const rename = document.querySelector('[role="menuitem"]');
    if (!rename) throw new Error("missing menu item");

    act(() => {
      (rename as HTMLButtonElement).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
