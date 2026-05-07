import { describe, expect, it } from "vitest";
import { countStats, parseDiff } from "./diff";

describe("parseDiff", () => {
  it("classifies hunk headers", () => {
    expect(parseDiff("@@ -1,3 +1,4 @@")).toEqual([
      { kind: "hunk", prefix: "@@", text: "@@ -1,3 +1,4 @@" },
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
      { kind: "add", prefix: "+", text: "added" },
      { kind: "del", prefix: "-", text: "removed" },
      { kind: "ctx", prefix: " ", text: "unchanged" },
    ]);
  });

  it("treats prefix-less lines as ctx with empty prefix", () => {
    expect(parseDiff("bare")).toEqual([
      { kind: "ctx", prefix: "", text: "bare" },
    ]);
  });

  it("preserves an empty trailing line from a trailing newline", () => {
    expect(parseDiff("+a\n")).toHaveLength(2);
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
