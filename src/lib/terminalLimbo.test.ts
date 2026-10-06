import { describe, expect, it } from "vitest";
import {
  getTerminalLimbo,
  isParkedInTerminalLimbo,
  shouldFitTerminal,
  terminalElementHasLayoutBox,
} from "./terminalLimbo";

describe("isParkedInTerminalLimbo", () => {
  it("is true for a terminal container parked in limbo", () => {
    const slot = document.createElement("div");
    const container = document.createElement("div");
    slot.appendChild(container);
    getTerminalLimbo().appendChild(slot);
    expect(isParkedInTerminalLimbo(container)).toBe(true);
  });

  it("is false once the slot moves into a pane body", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const slot = document.createElement("div");
    const container = document.createElement("div");
    slot.appendChild(container);
    getTerminalLimbo().appendChild(slot);
    pane.appendChild(slot);
    expect(isParkedInTerminalLimbo(container)).toBe(false);
    expect(isParkedInTerminalLimbo(null)).toBe(false);
  });
});

describe("shouldFitTerminal", () => {
  it("fits a visible box, including after the terminal has been on screen", () => {
    expect(
      shouldFitTerminal({
        parkedInLimbo: false,
        hasLayoutBox: true,
        fittedOnScreen: false,
      }),
    ).toBe(true);
    expect(
      shouldFitTerminal({
        parkedInLimbo: false,
        hasLayoutBox: true,
        fittedOnScreen: true,
      }),
    ).toBe(true);
  });

  it("measures limbo once, before any on-screen fit", () => {
    expect(
      shouldFitTerminal({
        parkedInLimbo: true,
        hasLayoutBox: true,
        fittedOnScreen: false,
      }),
    ).toBe(true);
    expect(
      shouldFitTerminal({
        parkedInLimbo: true,
        hasLayoutBox: true,
        fittedOnScreen: true,
      }),
    ).toBe(false);
  });

  it("never fits a container with no layout box", () => {
    expect(
      shouldFitTerminal({
        parkedInLimbo: false,
        hasLayoutBox: false,
        fittedOnScreen: false,
      }),
    ).toBe(false);
    expect(
      shouldFitTerminal({
        parkedInLimbo: false,
        hasLayoutBox: false,
        fittedOnScreen: true,
      }),
    ).toBe(false);
  });
});

describe("terminalElementHasLayoutBox", () => {
  it("rejects a missing element and a zero rect", () => {
    expect(terminalElementHasLayoutBox(null)).toBe(false);
    const hidden = document.createElement("div");
    hidden.getClientRects = () =>
      ({
        length: 1,
        item: () =>
          ({
            width: 0,
            height: 0,
          }) as DOMRect,
      }) as unknown as DOMRectList;
    expect(terminalElementHasLayoutBox(hidden)).toBe(false);
  });

  it("accepts a rect with area", () => {
    const visible = document.createElement("div");
    visible.getClientRects = () =>
      ({
        length: 1,
        item: () =>
          ({
            width: 640,
            height: 400,
          }) as DOMRect,
      }) as unknown as DOMRectList;
    expect(terminalElementHasLayoutBox(visible)).toBe(true);
  });
});
