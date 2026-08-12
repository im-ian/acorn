import { describe, expect, it } from "vitest";
import {
  basename,
  inferPathFlavor,
  isAbsolutePath,
  isPathInsideOrEqual,
  joinPath,
  normalizePath,
  parentPath,
  pathsEqual,
  pathsIntersect,
  relativePath,
  trimTrailingPathSeparators,
} from "./pathUtils";

describe("path utils", () => {
  it("normalizes trailing separators and Windows separators", () => {
    expect(normalizePath("C:\\Users\\me\\repo\\")).toBe("C:/Users/me/repo");
    expect(normalizePath("/Users/me/repo///")).toBe("/Users/me/repo");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("C:\\")).toBe("C:/");
    expect(normalizePath("\\\\server\\share\\repo\\")).toBe(
      "//server/share/repo",
    );
    expect(normalizePath("src\\components\\App.tsx")).toBe(
      "src/components/App.tsx",
    );
  });

  it("uses an absolute POSIX root to preserve literal backslashes", () => {
    expect(inferPathFlavor("/repo/docs/back\\slash.md")).toBe("posix");
    expect(normalizePath("/repo/docs/back\\slash.md/")).toBe(
      "/repo/docs/back\\slash.md",
    );
    expect(basename("/repo/docs/back\\slash.md")).toBe("back\\slash.md");
    expect(parentPath("/repo/docs/back\\slash.md")).toBe("/repo/docs");
    expect(pathsEqual("/repo/docs/back\\slash.md", "/repo/docs/back/slash.md")).toBe(
      false,
    );
  });

  it("extracts a basename from POSIX and Windows paths", () => {
    expect(basename("/Users/me/repo/src/App.tsx")).toBe("App.tsx");
    expect(basename("C:\\Users\\me\\repo")).toBe("repo");
  });

  it("builds a relative path when the child is inside the root", () => {
    expect(relativePath("/repo", "/repo/src/App.tsx")).toBe("src/App.tsx");
    expect(relativePath("/repo", "/other/App.tsx")).toBe("/other/App.tsx");
    expect(relativePath("C:\\Repo", "c:/repo/src/App.tsx")).toBe(
      "src/App.tsx",
    );
    expect(relativePath("C:\\Repo", "C:\\Repo-other\\App.tsx")).toBe(
      "C:\\Repo-other\\App.tsx",
    );
    expect(relativePath("/repo", "/repo/docs/back\\slash.md")).toBe(
      "docs/back\\slash.md",
    );
  });

  it("detects intersecting roots without treating sibling prefixes as matches", () => {
    expect(pathsIntersect("/repo/src/App.tsx", "/repo")).toBe(true);
    expect(pathsIntersect("/repo", "/repo/src")).toBe(true);
    expect(pathsIntersect("/repo-other/src/App.tsx", "/repo")).toBe(false);
    expect(pathsIntersect("C:\\Repo\\src", "c:/repo")).toBe(true);
  });

  it("compares Windows drive and UNC paths case-insensitively", () => {
    expect(pathsEqual("C:\\Repo", "c:/repo/")).toBe(true);
    expect(pathsEqual("\\\\Server\\Share", "//server/share")).toBe(true);
    expect(pathsEqual("/Repo", "/repo")).toBe(false);
  });

  it("checks directory boundaries across native separators", () => {
    expect(isPathInsideOrEqual("C:\\repo\\src\\App.tsx", "c:/REPO")).toBe(
      true,
    );
    expect(isPathInsideOrEqual("C:\\repo-other", "C:\\repo")).toBe(false);
    expect(
      isPathInsideOrEqual(
        "\\\\server\\share\\repo\\src",
        "\\\\SERVER\\SHARE\\repo",
      ),
    ).toBe(true);
  });

  it("preserves native roots and separators while walking and joining", () => {
    expect(trimTrailingPathSeparators("C:\\repo\\")).toBe("C:\\repo");
    expect(trimTrailingPathSeparators("C:\\")).toBe("C:\\");
    expect(parentPath("/repo/src")).toBe("/repo");
    expect(parentPath("C:\\repo\\src")).toBe("C:\\repo");
    expect(parentPath("C:\\repo")).toBe("C:\\");
    expect(parentPath("\\\\server\\share")).toBe("\\\\server\\share");
    expect(joinPath("/repo", "src\\App.tsx")).toBe(
      "/repo/src\\App.tsx",
    );
    expect(joinPath("C:\\repo", "src/App.tsx")).toBe(
      "C:\\repo\\src\\App.tsx",
    );
    expect(joinPath("C:\\", "src")).toBe("C:\\src");
  });

  it("keeps a POSIX backslash filename intact through the rename path flow", () => {
    const path = "/repo/docs/old\\name.md";
    expect(joinPath(parentPath(path), "new\\name.md")).toBe(
      "/repo/docs/new\\name.md",
    );
  });

  it("recognizes POSIX, drive, and UNC absolute paths", () => {
    expect(isAbsolutePath("/repo/src/App.tsx")).toBe(true);
    expect(isAbsolutePath("C:\\repo\\src\\App.tsx")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share\\file.txt")).toBe(true);
    expect(isAbsolutePath("src\\App.tsx")).toBe(false);
  });
});
