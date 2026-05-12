import { describe, expect, it } from "vitest";
import { classifyDropZone } from "./dnd";

const RECT = { left: 0, top: 0, width: 100, height: 100 };

describe("classifyDropZone", () => {
  it("returns center when pointer is past the edge threshold on all sides", () => {
    expect(classifyDropZone({ x: 50, y: 50 }, RECT)).toEqual({ kind: "center" });
  });

  it("returns left edge when nearest to the left side", () => {
    expect(classifyDropZone({ x: 5, y: 50 }, RECT)).toEqual({
      kind: "edge",
      direction: "horizontal",
      side: "before",
    });
  });

  it("returns right edge when nearest to the right side", () => {
    expect(classifyDropZone({ x: 95, y: 50 }, RECT)).toEqual({
      kind: "edge",
      direction: "horizontal",
      side: "after",
    });
  });

  it("returns top edge when nearest to the top side", () => {
    expect(classifyDropZone({ x: 50, y: 5 }, RECT)).toEqual({
      kind: "edge",
      direction: "vertical",
      side: "before",
    });
  });

  it("returns bottom edge when nearest to the bottom side", () => {
    expect(classifyDropZone({ x: 50, y: 95 }, RECT)).toEqual({
      kind: "edge",
      direction: "vertical",
      side: "after",
    });
  });

  it("treats the threshold boundary as center (not edge)", () => {
    // 100x100 rect → edge band = min(64px, 40% × 100) = 40px. distLeft = 40
    // is the exact boundary, so it should classify as center.
    expect(classifyDropZone({ x: 40, y: 50 }, RECT)).toEqual({ kind: "center" });
  });

  it("clamps edge band to 40% of the smaller dimension on narrow panes", () => {
    // 50px wide × 200px tall pane. Horizontal threshold = min(64, 20) = 20px.
    // distLeft = 21 sits just outside the edge band → center.
    const narrow = { left: 0, top: 0, width: 50, height: 200 };
    expect(classifyDropZone({ x: 21, y: 100 }, narrow)).toEqual({ kind: "center" });
    expect(classifyDropZone({ x: 5, y: 100 }, narrow)).toEqual({
      kind: "edge",
      direction: "horizontal",
      side: "before",
    });
  });

  it("handles non-zero rect origin", () => {
    expect(
      classifyDropZone({ x: 105, y: 150 }, { left: 100, top: 100, width: 100, height: 100 }),
    ).toEqual({ kind: "edge", direction: "horizontal", side: "before" });
  });
});
