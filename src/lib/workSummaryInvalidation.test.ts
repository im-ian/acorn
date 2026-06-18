import { describe, expect, it } from "vitest";
import { fsChangeTouchesRoot } from "./workSummaryInvalidation";

describe("work summary invalidation", () => {
  it("matches direct paths under the watched root", () => {
    expect(
      fsChangeTouchesRoot(
        {
          paths: ["/repo/src/App.tsx"],
          dotgit_changed: false,
        },
        "/repo",
      ),
    ).toBe(true);
  });

  it("matches refresh hints and roots that intersect the watched root", () => {
    expect(
      fsChangeTouchesRoot(
        {
          paths: [],
          overflow: true,
          refresh: { kind: "subtree", path: "/repo/src" },
          dotgit_changed: false,
        },
        "/repo",
      ),
    ).toBe(true);
    expect(
      fsChangeTouchesRoot(
        {
          paths: [],
          root: "/repo",
          dotgit_changed: false,
        },
        "/repo/src",
      ),
    ).toBe(true);
  });

  it("does not match sibling paths", () => {
    expect(
      fsChangeTouchesRoot(
        {
          paths: ["/repo-other/src/App.tsx"],
          dotgit_changed: false,
        },
        "/repo",
      ),
    ).toBe(false);
  });
});
