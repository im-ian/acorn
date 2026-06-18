import { describe, expect, it } from "vitest";
import {
  basename,
  normalizePath,
  pathsIntersect,
  relativePath,
} from "./pathUtils";

describe("path utils", () => {
  it("normalizes trailing separators and Windows separators", () => {
    expect(normalizePath("C:\\Users\\me\\repo\\")).toBe("C:/Users/me/repo");
    expect(normalizePath("/Users/me/repo///")).toBe("/Users/me/repo");
  });

  it("extracts a basename from POSIX and Windows paths", () => {
    expect(basename("/Users/me/repo/src/App.tsx")).toBe("App.tsx");
    expect(basename("C:\\Users\\me\\repo")).toBe("repo");
  });

  it("builds a relative path when the child is inside the root", () => {
    expect(relativePath("/repo", "/repo/src/App.tsx")).toBe("src/App.tsx");
    expect(relativePath("/repo", "/other/App.tsx")).toBe("/other/App.tsx");
  });

  it("detects intersecting roots without treating sibling prefixes as matches", () => {
    expect(pathsIntersect("/repo/src/App.tsx", "/repo")).toBe(true);
    expect(pathsIntersect("/repo", "/repo/src")).toBe(true);
    expect(pathsIntersect("/repo-other/src/App.tsx", "/repo")).toBe(false);
  });
});
