import { describe, expect, it } from "vitest";
import {
  applyTabMinimized,
  clampTabInsertIndex,
  collectMinimizedTabIds,
  isTabMinimizedInWorkspaces,
  mergeMinimizedTabIds,
  normalizeMinimizedTabIds,
  partitionTabIds,
  stackMinimizedTabIds,
} from "./paneTabs";

describe("normalizeMinimizedTabIds", () => {
  it("drops unknown, duplicate, and non-string ids", () => {
    expect(
      normalizeMinimizedTabIds(["b", "b", 1, null, "missing", "a"], ["a", "b"]),
    ).toEqual(["b", "a"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(normalizeMinimizedTabIds(undefined, ["a"])).toEqual([]);
    expect(normalizeMinimizedTabIds("a", ["a"])).toEqual([]);
  });
});

describe("applyTabMinimized", () => {
  it("moves a newly minimized tab to the end of the minimized group", () => {
    expect(applyTabMinimized(["a", "b", "c"], ["a"], "c", true)).toEqual({
      tabIds: ["a", "c", "b"],
      minimizedTabIds: ["a", "c"],
    });
  });

  it("moves a newly expanded tab to the start of the expanded group", () => {
    expect(applyTabMinimized(["a", "c", "b"], ["a", "c"], "a", false)).toEqual({
      tabIds: ["c", "a", "b"],
      minimizedTabIds: ["c"],
    });
  });

  it("is a no-op when the tab is already in the requested state", () => {
    expect(applyTabMinimized(["a", "b", "c"], ["a"], "a", true)).toEqual({
      tabIds: ["a", "b", "c"],
      minimizedTabIds: ["a"],
    });
    expect(applyTabMinimized(["a", "b", "c"], ["a"], "b", false)).toEqual({
      tabIds: ["a", "b", "c"],
      minimizedTabIds: ["a"],
    });
  });

  it("restacks mixed order when the tab is already minimized", () => {
    expect(applyTabMinimized(["b", "a", "c"], ["a"], "a", true)).toEqual({
      tabIds: ["a", "b", "c"],
      minimizedTabIds: ["a"],
    });
  });

  it("ignores unknown tab ids", () => {
    expect(applyTabMinimized(["a"], [], "missing", true)).toEqual({
      tabIds: ["a"],
      minimizedTabIds: [],
    });
  });
});

describe("clampTabInsertIndex", () => {
  const tabs = ["m1", "m2", "a", "b"];
  const minimized = ["m1", "m2"];

  it("keeps minimized inserts inside the left group", () => {
    expect(clampTabInsertIndex(tabs, minimized, true, 0)).toBe(0);
    expect(clampTabInsertIndex(tabs, minimized, true, 2)).toBe(2);
    expect(clampTabInsertIndex(tabs, minimized, true, 4)).toBe(2);
  });

  it("keeps expanded inserts after the minimized group", () => {
    expect(clampTabInsertIndex(tabs, minimized, false, 0)).toBe(2);
    expect(clampTabInsertIndex(tabs, minimized, false, 3)).toBe(3);
    expect(clampTabInsertIndex(tabs, minimized, false, 4)).toBe(4);
  });
});

describe("partition and merge", () => {
  it("splits tabs without reordering within each group", () => {
    expect(partitionTabIds(["b", "a", "d", "c"], ["a", "c"])).toEqual({
      minimized: ["a", "c"],
      expanded: ["b", "d"],
    });
    expect(stackMinimizedTabIds(["b", "a", "d", "c"], ["a", "c"])).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("merges minimized ids from two panes in left-then-right order", () => {
    expect(
      mergeMinimizedTabIds(["a"], ["c", "a"], ["a", "b", "c"]),
    ).toEqual(["a", "c"]);
  });
});

describe("isTabMinimizedInWorkspaces", () => {
  it("finds a minimized tab in any workspace pane", () => {
    expect(
      isTabMinimizedInWorkspaces(
        {
          a: { panes: { p1: { minimizedTabIds: ["x"] } } },
          b: { panes: { p2: { minimizedTabIds: ["y"] } } },
        },
        "y",
      ),
    ).toBe(true);
    expect(
      isTabMinimizedInWorkspaces(
        { a: { panes: { p1: { minimizedTabIds: ["x"] } } } },
        "missing",
      ),
    ).toBe(false);
  });

  it("collects unique minimized ids across panes", () => {
    expect([
      ...collectMinimizedTabIds({
        a: { panes: { p1: { minimizedTabIds: ["x", "y"] } } },
        b: { panes: { p2: { minimizedTabIds: ["y", "z"] } } },
      }),
    ]).toEqual(["x", "y", "z"]);
  });
});
