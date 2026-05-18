import { describe, expect, it } from "vitest";
import { countStats, diffGutterWidth, parseDiff } from "./diff";

describe("parseDiff", () => {
  it("classifies hunk headers", () => {
    expect(parseDiff("@@ -1,3 +1,4 @@")).toEqual([
      {
        kind: "hunk",
        prefix: "@@",
        text: "@@ -1,3 +1,4 @@",
        oldLine: null,
        newLine: null,
      },
    ]);
  });

  it("classifies meta lines", () => {
    const meta = [
      "diff --git a/x b/x",
      "index abc..def 100644",
      "--- a/x",
      "+++ b/x",
      "new file mode 100644",
      "deleted file mode 100644",
      "similarity index 100%",
      "rename from old",
    ].join("\n");
    const lines = parseDiff(meta);
    expect(lines.every((l) => l.kind === "meta")).toBe(true);
    expect(lines).toHaveLength(8);
  });

  it("strips +/-/space prefix and tags add/del/ctx", () => {
    const patch = "+added\n-removed\n unchanged";
    expect(parseDiff(patch)).toEqual([
      { kind: "add", prefix: "+", text: "added", oldLine: null, newLine: null },
      {
        kind: "del",
        prefix: "-",
        text: "removed",
        oldLine: null,
        newLine: null,
      },
      {
        kind: "ctx",
        prefix: " ",
        text: "unchanged",
        oldLine: null,
        newLine: null,
      },
    ]);
  });

  it("treats prefix-less lines as ctx with empty prefix", () => {
    expect(parseDiff("bare")).toEqual([
      { kind: "ctx", prefix: "", text: "bare", oldLine: null, newLine: null },
    ]);
  });

  it("preserves an empty trailing line from a trailing newline", () => {
    expect(parseDiff("+a\n")).toHaveLength(2);
  });

  it("tracks old and new line numbers across hunks", () => {
    const patch = [
      "@@ -10,3 +20,4 @@",
      " ctx-a",
      "-removed",
      "+added-1",
      "+added-2",
      "@@ -100,2 +200,2 @@",
      " ctx-b",
      "-gone",
    ].join("\n");
    const lines = parseDiff(patch);
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["hunk", null, null],
      ["ctx", 10, 20],
      ["del", 11, null],
      ["add", null, 21],
      ["add", null, 22],
      ["hunk", null, null],
      ["ctx", 100, 200],
      ["del", 101, null],
    ]);
  });

  it("falls back to null cursors when the hunk header is malformed", () => {
    const patch = ["@@ broken header @@", "+x"].join("\n");
    const lines = parseDiff(patch);
    expect(lines[1]).toMatchObject({ kind: "add", oldLine: null, newLine: null });
  });
});

describe("diffGutterWidth", () => {
  it("returns 1 when no line numbers are known", () => {
    expect(diffGutterWidth(parseDiff("+a\n-b"))).toBe(1);
  });

  it("returns the digit count of the largest tracked line number", () => {
    const patch = ["@@ -1,2 +98,3 @@", " a", " b", "+c"].join("\n");
    expect(diffGutterWidth(parseDiff(patch))).toBe(3);
  });
});

describe("countStats", () => {
  it("counts add and del lines, ignoring ctx/meta/hunk", () => {
    const lines = parseDiff(
      [
        "diff --git a/x b/x",
        "@@ -1,2 +1,3 @@",
        " ctx",
        "+a1",
        "+a2",
        "-d1",
      ].join("\n"),
    );
    expect(countStats(lines)).toEqual({ add: 2, del: 1 });
  });

  it("returns zeros for an empty list", () => {
    expect(countStats([])).toEqual({ add: 0, del: 0 });
  });
});
