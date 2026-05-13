import { describe, expect, it } from "vitest";
import { toggleTaskMarker } from "./PullRequestDetailModal";

describe("toggleTaskMarker", () => {
  it("checks an unchecked task by index", () => {
    const body = "- [ ] one\n- [ ] two\n- [ ] three";
    expect(toggleTaskMarker(body, 1, true)).toBe(
      "- [ ] one\n- [x] two\n- [ ] three",
    );
  });

  it("unchecks a checked task by index", () => {
    const body = "- [x] one\n- [x] two";
    expect(toggleTaskMarker(body, 0, false)).toBe("- [ ] one\n- [x] two");
  });

  it("handles ordered list task items", () => {
    const body = "1. [ ] alpha\n2. [ ] beta";
    expect(toggleTaskMarker(body, 1, true)).toBe(
      "1. [ ] alpha\n2. [x] beta",
    );
  });

  it("preserves indentation of nested task items", () => {
    const body = "- [ ] root\n  - [ ] nested";
    expect(toggleTaskMarker(body, 1, true)).toBe(
      "- [ ] root\n  - [x] nested",
    );
  });

  it("skips task-looking lines inside fenced code blocks", () => {
    const body = [
      "- [ ] real one",
      "",
      "```",
      "- [ ] not a task",
      "```",
      "",
      "- [ ] real two",
    ].join("\n");
    const next = toggleTaskMarker(body, 1, true);
    expect(next).toBe(
      [
        "- [ ] real one",
        "",
        "```",
        "- [ ] not a task",
        "```",
        "",
        "- [x] real two",
      ].join("\n"),
    );
  });

  it("returns null when the index is out of range", () => {
    expect(toggleTaskMarker("- [ ] only", 5, true)).toBeNull();
    expect(toggleTaskMarker("no tasks here", 0, true)).toBeNull();
  });

  it("accepts uppercase X as checked", () => {
    const body = "- [X] done";
    expect(toggleTaskMarker(body, 0, false)).toBe("- [ ] done");
  });
});
