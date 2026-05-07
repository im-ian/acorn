import { describe, expect, it } from "vitest";
import { joinPath } from "./paths";

describe("joinPath", () => {
  it("joins base and relative with a single separator", () => {
    expect(joinPath("/Users/me/repo", "src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("does not double up the separator when base ends with /", () => {
    expect(joinPath("/Users/me/repo/", "src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("strips leading slashes from the relative path", () => {
    expect(joinPath("/Users/me/repo", "/src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("strips multiple leading slashes from the relative path", () => {
    expect(joinPath("/Users/me/repo", "///src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("handles empty relative", () => {
    expect(joinPath("/Users/me/repo", "")).toBe("/Users/me/repo/");
  });
});
