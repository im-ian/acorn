import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

function IndependentMenuRow({
  id,
  label,
}: {
  id: string;
  label: string;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      data-menu-row={id}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {label}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={[{ label: `${label} action`, onClick: vi.fn() }]}
      />
    </div>
  );
}

function openRowMenu(row: Element, x: number, y: number, withMouseDown: boolean) {
  if (withMouseDown) {
    row.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
  }
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
}

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

  it("keeps a single menu when another row right-clicks and stops mousedown", () => {
    act(() => {
      root.render(
        <>
          <IndependentMenuRow id="a" label="Rename A" />
          <IndependentMenuRow id="b" label="Rename B" />
        </>,
      );
    });

    const rowA = document.querySelector("[data-menu-row='a']");
    const rowB = document.querySelector("[data-menu-row='b']");
    if (!rowA || !rowB) throw new Error("missing rows");

    act(() => {
      openRowMenu(rowA, 12, 16, false);
    });
    expect(document.querySelectorAll("[data-acorn-context-menu]")).toHaveLength(1);
    expect(document.body.textContent).toContain("Rename A action");

    act(() => {
      openRowMenu(rowB, 24, 48, true);
    });
    expect(document.querySelectorAll("[data-acorn-context-menu]")).toHaveLength(1);
    expect(document.body.textContent).toContain("Rename B action");
    expect(document.body.textContent).not.toContain("Rename A action");
  });

  it("dismisses an open menu on a capturing mousedown even when the row stops bubbling", () => {
    act(() => {
      root.render(
        <>
          <IndependentMenuRow id="a" label="Rename A" />
          <IndependentMenuRow id="b" label="Rename B" />
        </>,
      );
    });

    const rowA = document.querySelector("[data-menu-row='a']");
    const rowB = document.querySelector("[data-menu-row='b']");
    if (!rowA || !rowB) throw new Error("missing rows");

    act(() => {
      openRowMenu(rowA, 12, 16, false);
    });
    expect(document.querySelectorAll("[data-acorn-context-menu]")).toHaveLength(1);

    act(() => {
      rowB.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 24,
          clientY: 48,
        }),
      );
    });
    expect(document.querySelectorAll("[data-acorn-context-menu]")).toHaveLength(0);
  });
});
