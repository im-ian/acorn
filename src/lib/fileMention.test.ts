import { describe, expect, it } from "vitest";
import {
  formatTerminalFileMention,
  pathRelativeToCwd,
} from "./fileMention";

describe("pathRelativeToCwd", () => {
  it("returns a repo-relative path for files under the terminal cwd", () => {
    expect(
      pathRelativeToCwd(
        "/Users/me/repo/src/components/Terminal.tsx",
        "/Users/me/repo",
      ),
    ).toBe("src/components/Terminal.tsx");
  });

  it("keeps absolute paths when the file is outside the terminal cwd", () => {
    expect(
      pathRelativeToCwd("/Users/me/other/file.ts", "/Users/me/repo"),
    ).toBe("/Users/me/other/file.ts");
  });

  it("handles a cwd with a trailing slash", () => {
    expect(pathRelativeToCwd("/Users/me/repo/README.md", "/Users/me/repo/")).toBe(
      "README.md",
    );
  });
});

describe("formatTerminalFileMention", () => {
  it("formats a simple repo-relative file path by default", () => {
    expect(
      formatTerminalFileMention(
        "/Users/me/repo/src/components/Terminal.tsx",
        "/Users/me/repo",
      ),
    ).toBe("src/components/Terminal.tsx ");
  });

  it("uses a mention prefix for Claude agent sessions", () => {
    expect(
      formatTerminalFileMention(
        "/Users/me/repo/src/components/Terminal.tsx",
        "/Users/me/repo",
        { agentProvider: "claude" },
      ),
    ).toBe("@src/components/Terminal.tsx ");
  });

  it("backslash-escapes whitespace so paths remain one mention token", () => {
    expect(
      formatTerminalFileMention(
        "/Users/me/repo/docs/PR notes/final plan.md",
        "/Users/me/repo",
      ),
    ).toBe("docs/PR\\ notes/final\\ plan.md ");
  });

  it("backslash-escapes literal backslashes", () => {
    expect(
      formatTerminalFileMention(
        "/Users/me/repo/docs/back\\slash.md",
        "/Users/me/repo",
      ),
    ).toBe("docs/back\\\\slash.md ");
  });
});
