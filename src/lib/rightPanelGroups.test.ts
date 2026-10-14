import { describe, expect, it } from "vitest";
import { activeRightGroup, type RightGroup } from "./rightPanelGroups";

const ALL: RightGroup[] = [
  "workspace",
  "code",
  "github",
  "linear",
  "jira",
  "agents",
];

describe("activeRightGroup", () => {
  it("keeps the group that owns the current tab", () => {
    expect(activeRightGroup("tasks", ALL)).toBe("workspace");
    expect(activeRightGroup("commits", ALL)).toBe("code");
  });

  it("falls back to Code when the current group is hidden", () => {
    expect(activeRightGroup("issues", ["workspace", "code", "agents"])).toBe(
      "code",
    );
  });

  it("uses Workspace only when it is the only visible group", () => {
    expect(activeRightGroup("issues", ["workspace"])).toBe("workspace");
  });
});
