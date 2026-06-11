import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./Select";

const THEME_OPTIONS: SelectOption[] = [
  { value: "acorn-dark", label: "Acorn Dark Green" },
  { value: "acorn-pink", label: "Acorn Dark Pink" },
  { value: "solarized-dark", label: "Solarized Dark" },
];

function getCombobox(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  if (!input) throw new Error("Combobox not found");
  return input;
}

function focusInput(input: HTMLInputElement) {
  act(() => {
    input.focus();
  });
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

function pressKey(input: HTMLInputElement, key: string) {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }),
    );
  });
}

function optionLabels(): string[] {
  return Array.from(document.querySelectorAll('[role="option"]')).map(
    (option) => option.textContent?.trim() ?? "",
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

  it("filters option children by typed keywords", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Select defaultValue="acorn-dark">
          <option value="acorn-dark">Acorn Dark Green</option>
          <option value="acorn-pink">Acorn Dark Pink</option>
          <option value="solarized-dark">Solarized Dark</option>
        </Select>,
      );
    });

    const input = getCombobox();
    expect(input.value).toBe("Acorn Dark Green");

    focusInput(input);
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
          value="acorn-dark"
          options={THEME_OPTIONS}
          onValueChange={onValueChange}
          onChange={onChange}
        />,
      );
    });

    const input = getCombobox();
    focusInput(input);
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
          value={["acorn-dark"]}
          options={THEME_OPTIONS}
          onValuesChange={onValuesChange}
          onChange={onChange}
        />,
      );
    });

    const input = getCombobox();
    focusInput(input);
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
});
