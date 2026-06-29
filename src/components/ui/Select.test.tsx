import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Select,
  type SelectItem,
  type SelectOption,
  type SelectOptionGroup,
} from "./Select";

const THEME_OPTIONS: SelectOption[] = [
  { value: "acorn-dark", label: "Acorn Dark Green" },
  { value: "acorn-pink", label: "Acorn Dark Pink" },
  { value: "solarized-dark", label: "Solarized Dark" },
];

function getCombobox(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"]',
  );
  if (!button) throw new Error("Combobox not found");
  return button;
}

function clickElement(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function getSearchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("[data-select-search]");
  if (!input) throw new Error("Search input not found");
  return input;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("Input value setter not found");

  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }),
    );
  });
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll("[data-select-option-label]"),
  ).map((option) => option.textContent?.trim() ?? "");
}

function separators(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-select-separator]"),
  );
}

function sectionMarkers(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-select-group-label], [data-select-separator]",
    ),
  ).map((element) =>
    element.hasAttribute("data-select-separator")
      ? "separator"
      : (element.textContent?.trim() ?? ""),
  );
}

describe("Select", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens a searchable popover from a button trigger", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Select searchable defaultValue="acorn-dark">
          <option value="acorn-dark">Acorn Dark Green</option>
          <option value="acorn-pink">Acorn Dark Pink</option>
          <option value="solarized-dark">Solarized Dark</option>
        </Select>,
      );
    });

    const trigger = getCombobox();
    expect(trigger.textContent).toContain("Acorn Dark Green");
    expect(document.querySelector("[data-select-search]")).toBeNull();

    clickElement(trigger);
    const input = getSearchInput();
    setInputValue(input, "pink");

    expect(optionLabels()).toEqual(["Acorn Dark Pink"]);
  });

  it("selects the filtered active option with Enter", () => {
    const onValueChange = vi.fn();
    const onChange = vi.fn();

    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          searchable
          value="acorn-dark"
          options={THEME_OPTIONS}
          onValueChange={onValueChange}
          onChange={onChange}
        />,
      );
    });

    clickElement(getCombobox());
    const input = getSearchInput();
    setInputValue(input, "pink");
    pressKey(input, "Enter");

    expect(onValueChange).toHaveBeenCalledWith("acorn-pink");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ value: "acorn-pink" }),
      }),
    );
  });

  it("adds a filtered option through the multi-select API", () => {
    const onValuesChange = vi.fn();
    const onChange = vi.fn();

    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          multiple
          searchable
          value={["acorn-dark"]}
          options={THEME_OPTIONS}
          onValuesChange={onValuesChange}
          onChange={onChange}
        />,
      );
    });

    clickElement(getCombobox());
    const input = getSearchInput();
    setInputValue(input, "pink");
    pressKey(input, "Enter");

    expect(onValuesChange).toHaveBeenCalledWith([
      "acorn-dark",
      "acorn-pink",
    ]);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          value: "acorn-dark",
          values: ["acorn-dark", "acorn-pink"],
        }),
      }),
    );
  });

  it("renders option descriptions and includes them in search", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          searchable
          value="pro"
          options={[
            {
              value: "basic",
              label: "Basic Plan",
              description: "$9/month - Perfect for small projects",
            },
            {
              value: "pro",
              label: "Pro Plan",
              description: "$29/month - Advanced features",
            },
            {
              value: "enterprise",
              label: "Enterprise Plan",
              description: "Custom pricing - Tailored solutions",
            },
          ]}
        />,
      );
    });

    clickElement(getCombobox());

    expect(optionLabels()).toEqual([
      "Basic Plan",
      "Pro Plan",
      "Enterprise Plan",
    ]);
    expect(
      Array.from(
        document.querySelectorAll("[data-select-option-description]"),
      ).map((option) => option.textContent?.trim() ?? ""),
    ).toEqual([
      "$9/month - Perfect for small projects",
      "$29/month - Advanced features",
      "Custom pricing - Tailored solutions",
    ]);

    setInputValue(getSearchInput(), "tailored");

    expect(optionLabels()).toEqual(["Enterprise Plan"]);
  });

  it("renders option icons in the trigger and option list", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          value="panes"
          options={[
            { value: "panes", label: "Panes", icon: <span>P</span> },
            { value: "kanban", label: "Kanban", icon: <span>K</span> },
          ]}
        />,
      );
    });

    expect(
      document.querySelector("[data-select-trigger-icon]")?.textContent,
    ).toBe("P");

    clickElement(getCombobox());

    expect(
      Array.from(document.querySelectorAll("[data-select-option-icon]")).map(
        (icon) => icon.textContent,
      ),
    ).toEqual(["P", "K"]);
  });

  it("renders separators without making them selectable", () => {
    const onValueChange = vi.fn();
    const options: SelectItem[] = [
      { value: "basic", label: "Basic Plan" },
      { type: "separator" },
      { value: "pro", label: "Pro Plan" },
      { type: "separator", label: "Enterprise" },
      { value: "enterprise", label: "Enterprise Plan" },
    ];

    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          searchable
          value="basic"
          options={options}
          onValueChange={onValueChange}
        />,
      );
    });

    clickElement(getCombobox());

    expect(optionLabels()).toEqual([
      "Basic Plan",
      "Pro Plan",
      "Enterprise Plan",
    ]);
    expect(separators()).toHaveLength(2);
    expect(separators()[1]?.getAttribute("aria-label")).toBe("Enterprise");

    setInputValue(getSearchInput(), "enterprise");

    expect(optionLabels()).toEqual(["Enterprise Plan"]);
    expect(separators()).toHaveLength(0);

    pressKey(getSearchInput(), "Enter");

    expect(onValueChange).toHaveBeenCalledWith("enterprise");
  });

  it("preserves separators between explicit option groups", () => {
    const options: Array<SelectItem | SelectOptionGroup> = [
      {
        label: "Acorn themes",
        options: [{ value: "acorn-dark", label: "Acorn Dark Green" }],
      },
      { type: "separator" },
      {
        label: "Built-in dark",
        options: [{ value: "github-dark", label: "GitHub Dark" }],
      },
    ];

    act(() => {
      root = createRoot(container);
      root.render(<Select searchable value="acorn-dark" options={options} />);
    });

    clickElement(getCombobox());

    expect(sectionMarkers()).toEqual([
      "Acorn themes",
      "separator",
      "Built-in dark",
    ]);
    expect(optionLabels()).toEqual(["Acorn Dark Green", "GitHub Dark"]);

    setInputValue(getSearchInput(), "github");

    expect(sectionMarkers()).toEqual(["Built-in dark"]);
    expect(optionLabels()).toEqual(["GitHub Dark"]);
  });

  it("opens non-searchable selects without rendering a search input", () => {
    const onValueChange = vi.fn();

    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          value="acorn-dark"
          options={THEME_OPTIONS}
          onValueChange={onValueChange}
        />,
      );
    });

    const trigger = getCombobox();
    clickElement(trigger);

    expect(document.querySelector("[data-select-search]")).toBeNull();
    expect(optionLabels()).toEqual([
      "Acorn Dark Green",
      "Acorn Dark Pink",
      "Solarized Dark",
    ]);

    pressKey(trigger, "ArrowDown");
    pressKey(trigger, "Enter");

    expect(onValueChange).toHaveBeenCalledWith("acorn-pink");
  });

  it("can place the options above the trigger", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          placement="top"
          value="acorn-dark"
          options={THEME_OPTIONS}
        />,
      );
    });

    clickElement(getCombobox());

    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox?.parentElement?.style.transform).toBe("translateY(-100%)");
  });
});
