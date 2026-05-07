import { describe, expect, it } from "vitest";
import {
  findPaneNode,
  listPaneIds,
  makePaneNode,
  removePaneFromLayout,
  splitPaneInLayout,
  type LayoutNode,
} from "./layout";

describe("makePaneNode", () => {
  it("creates a pane leaf with the given id", () => {
    expect(makePaneNode("p1")).toEqual({ kind: "pane", id: "p1" });
  });
});

describe("listPaneIds", () => {
  it("returns the single id for a leaf", () => {
    expect(listPaneIds(makePaneNode("p1"))).toEqual(["p1"]);
  });

  it("returns ids in left-to-right (a-before-b) order for nested splits", () => {
    const layout: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      a: makePaneNode("p1"),
      b: {
        kind: "split",
        id: "s2",
        direction: "vertical",
        a: makePaneNode("p2"),
        b: makePaneNode("p3"),
      },
    };
    expect(listPaneIds(layout)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("findPaneNode", () => {
  const layout: LayoutNode = {
    kind: "split",
    id: "s1",
    direction: "horizontal",
    a: makePaneNode("p1"),
    b: makePaneNode("p2"),
  };

  it("returns the pane when present", () => {
    expect(findPaneNode(layout, "p2")).toEqual(makePaneNode("p2"));
  });

  it("returns null when missing", () => {
    expect(findPaneNode(layout, "nope")).toBeNull();
  });
});

describe("splitPaneInLayout", () => {
  it("replaces a leaf with a split when target matches; new pane on `after`", () => {
    const initial = makePaneNode("p1");
    const next = splitPaneInLayout(
      initial,
      "p1",
      "horizontal",
      "p2",
      "after",
      "s1",
    );
    expect(next).toEqual({
      kind: "split",
      id: "s1",
      direction: "horizontal",
      a: makePaneNode("p1"),
      b: makePaneNode("p2"),
    });
  });

  it("places new pane before existing one when side === 'before'", () => {
    const next = splitPaneInLayout(
      makePaneNode("p1"),
      "p1",
      "vertical",
      "p2",
      "before",
      "s1",
    );
    expect(next).toEqual({
      kind: "split",
      id: "s1",
      direction: "vertical",
      a: makePaneNode("p2"),
      b: makePaneNode("p1"),
    });
  });

  it("returns the same leaf when target is missing (no-op)", () => {
    const initial = makePaneNode("p1");
    const next = splitPaneInLayout(
      initial,
      "absent",
      "horizontal",
      "p2",
      "after",
      "s1",
    );
    expect(next).toBe(initial);
  });

  it("recurses into split children", () => {
    const initial: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      a: makePaneNode("p1"),
      b: makePaneNode("p2"),
    };
    const next = splitPaneInLayout(
      initial,
      "p2",
      "vertical",
      "p3",
      "after",
      "s2",
    );
    expect(listPaneIds(next)).toEqual(["p1", "p2", "p3"]);
    expect(next.kind).toBe("split");
  });
});

describe("removePaneFromLayout", () => {
  it("returns null when removing the only pane", () => {
    expect(removePaneFromLayout(makePaneNode("p1"), "p1")).toBeNull();
  });

  it("returns the same leaf when target is missing", () => {
    const leaf = makePaneNode("p1");
    expect(removePaneFromLayout(leaf, "absent")).toBe(leaf);
  });

  it("collapses the surviving sibling into the parent slot", () => {
    const initial: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      a: makePaneNode("p1"),
      b: makePaneNode("p2"),
    };
    expect(removePaneFromLayout(initial, "p1")).toEqual(makePaneNode("p2"));
    expect(removePaneFromLayout(initial, "p2")).toEqual(makePaneNode("p1"));
  });

  it("preserves identity (===) when nothing changes", () => {
    const initial: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      a: makePaneNode("p1"),
      b: makePaneNode("p2"),
    };
    expect(removePaneFromLayout(initial, "absent")).toBe(initial);
  });

  it("removes a deeply nested pane and collapses appropriately", () => {
    const initial: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      a: makePaneNode("p1"),
      b: {
        kind: "split",
        id: "s2",
        direction: "vertical",
        a: makePaneNode("p2"),
        b: makePaneNode("p3"),
      },
    };
    const next = removePaneFromLayout(initial, "p2");
    expect(listPaneIds(next!)).toEqual(["p1", "p3"]);
  });
});
