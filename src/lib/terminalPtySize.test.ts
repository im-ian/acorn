import { describe, expect, it } from "vitest";
import {
  ptyPixelSize,
  shouldForceCommandPtyResize,
} from "./terminalPtySize";

function term(type: string, mouseTrackingMode: string) {
  return {
    buffer: { active: { type } },
    modes: { mouseTrackingMode },
  };
}

describe("shouldForceCommandPtyResize", () => {
  it("forces a same-size resize from a normal shell prompt", () => {
    expect(shouldForceCommandPtyResize(term("normal", "none"))).toBe(true);
  });

  it("does not force once a TUI has entered the alternate screen", () => {
    expect(shouldForceCommandPtyResize(term("alternate", "none"))).toBe(false);
  });

  it("does not force while a TUI has mouse tracking on the normal buffer", () => {
    expect(shouldForceCommandPtyResize(term("normal", "any"))).toBe(false);
    expect(shouldForceCommandPtyResize(term("normal", "vt200"))).toBe(false);
    expect(shouldForceCommandPtyResize(term("normal", "drag"))).toBe(false);
  });
});

describe("ptyPixelSize", () => {
  it("multiplies cell size by the grid", () => {
    expect(ptyPixelSize(80, 24, { width: 8.5, height: 17 })).toEqual({
      pixelWidth: 680,
      pixelHeight: 408,
    });
  });

  it("returns zeros when cell metrics are missing or invalid", () => {
    expect(ptyPixelSize(80, 24, null)).toEqual({
      pixelWidth: 0,
      pixelHeight: 0,
    });
    expect(ptyPixelSize(80, 24, { width: 0, height: 17 })).toEqual({
      pixelWidth: 0,
      pixelHeight: 0,
    });
    expect(ptyPixelSize(0, 24, { width: 8, height: 17 })).toEqual({
      pixelWidth: 0,
      pixelHeight: 0,
    });
  });

  it("clamps to a u16", () => {
    expect(ptyPixelSize(10_000, 10_000, { width: 20, height: 20 })).toEqual({
      pixelWidth: 65535,
      pixelHeight: 65535,
    });
  });
});


