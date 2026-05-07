import { describe, expect, it } from "vitest";
import { classifyDropZone } from "./dnd";

const RECT = { left: 0, top: 0, width: 100, height: 100 };

describe("classifyDropZone", () => {
  it("returns center when pointer is past the 25% edge threshold on all sides", () => {
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

  it("respects the 25% threshold boundary as center", () => {
    // 25% in from the left = relX 0.25, distLeft 0.25 → still center.
    expect(classifyDropZone({ x: 25, y: 50 }, RECT)).toEqual({ kind: "center" });
  });

  it("handles non-zero rect origin", () => {
    expect(
      classifyDropZone({ x: 105, y: 150 }, { left: 100, top: 100, width: 100, height: 100 }),
    ).toEqual({ kind: "edge", direction: "horizontal", side: "before" });
  });
});
