import { describe, expect, it } from "vitest";
import { classifyRightPanelFsChange } from "./right-panel-invalidation";

describe("classifyRightPanelFsChange", () => {
  it("invalidates staged data for working-tree file changes", () => {
    expect(
      classifyRightPanelFsChange("/repo/app", ["/repo/app/src/main.ts"]),
    ).toEqual({ commits: false, staged: true });
  });

  it("invalidates commits and staged data for in-repo git metadata changes", () => {
    expect(
      classifyRightPanelFsChange("/repo/app", ["/repo/app/.git/HEAD"]),
    ).toEqual({ commits: true, staged: true });
  });

  it("treats linked-worktree gitdir events as git metadata", () => {
    expect(
      classifyRightPanelFsChange("/repo/app/.acorn/worktrees/feature", [
        "/repo/app/.git/worktrees/feature/index",
      ]),
    ).toEqual({ commits: true, staged: true });
  });

  it("ignores empty events and missing repos", () => {
    expect(classifyRightPanelFsChange(null, ["/repo/app/.git/HEAD"])).toEqual({
      commits: false,
      staged: false,
    });
    expect(classifyRightPanelFsChange("/repo/app", [])).toEqual({
      commits: false,
      staged: false,
    });
  });
});
