import { describe, expect, it } from "vitest";
import { getTerminalLimbo, isParkedInTerminalLimbo } from "./terminalLimbo";

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
