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

  it("renders checkbox items with checked state and toggles through onChange", () => {
    const onChange = vi.fn();
    const onClose = render([
      {
        type: "checkbox",
        label: "Close when finished",
        checked: false,
        onChange,
      },
    ]);

    const checkbox = document.querySelector('[role="menuitemcheckbox"]');
    if (!checkbox) throw new Error("missing checkbox menu item");

    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(checkbox.textContent?.trim()).toBe("Close when finished");

    act(() => {
      (checkbox as HTMLButtonElement).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders submenu affordances separately from shortcut text", () => {
    render([
      {
        type: "submenu",
        label: "Copy",
        children: [{ label: "Path", onClick: vi.fn() }],
      },
      { label: "Command palette", shortcut: "⌘K", onClick: vi.fn() },
    ]);

    const [copy, commandPalette] = document.querySelectorAll('[role="menuitem"]');
    expect(copy?.textContent?.trim()).toBe("Copy");
    expect(copy?.querySelector("svg")).not.toBeNull();
    expect(commandPalette?.textContent?.trim()).toBe("Command palette⌘K");
    expect(commandPalette?.querySelector("kbd")?.textContent).toBe("⌘K");
  });

  it("opens nested submenu items without a depth limit in the item model", () => {
    const onClick = vi.fn();
    const onClose = render([
      {
        type: "submenu",
        label: "Copy",
        children: [
          {
            type: "submenu",
            label: "Advanced",
            children: [{ label: "Session ID", onClick }],
          },
        ],
      },
    ]);

    const copy = document.querySelector('[role="menuitem"]');
    if (!copy) throw new Error("missing submenu trigger");

    act(() => {
      copy.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const advanced = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((node) => node.textContent?.includes("Advanced"));
    if (!advanced) throw new Error("missing nested submenu trigger");

    act(() => {
      advanced.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const sessionId = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((node) => node.textContent?.includes("Session ID"));
    if (!sessionId) throw new Error("missing nested menu item");

    act(() => {
      (sessionId as HTMLButtonElement).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
