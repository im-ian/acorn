import { describe, expect, it } from "vitest";
import { parseIssueKey } from "./issueKey";

describe("parseIssueKey", () => {
  it("returns the first mapped key from a branch name", () => {
    expect(parseIssueKey("feature/jtf-184-right-panel", ["JTF"])).toBe(
      "JTF-184",
    );
    expect(parseIssueKey("JTF-184", ["JTF"])).toBe("JTF-184");
  });

  it("ignores keys whose prefix is not mapped", () => {
    expect(parseIssueKey("iso-8601-and-sha-256", ["JTF"])).toBeNull();
    expect(parseIssueKey("ACORN-12-fix", ["JTF"])).toBeNull();
  });

  it("matches only the mapped tracker when both prefixes exist", () => {
    expect(parseIssueKey("jtf-184-and-acorn-12", ["JTF", "ACORN"])).toBe(
      "JTF-184",
    );
    expect(parseIssueKey("acorn-12-only", ["ACORN"])).toBe("ACORN-12");
  });
});
