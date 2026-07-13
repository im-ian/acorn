import { describe, expect, it } from "vitest";
import { retainRecentGitStatPaths } from "./fileExplorerGitStats";

describe("retainRecentGitStatPaths", () => {
  it("bounds accumulated watcher paths to the latest backend batch capacity", () => {
    const retained = new Set<string>();

    retainRecentGitStatPaths(
      retained,
      Array.from({ length: 256 }, (_, index) => `/repo/first-${index}`),
      256,
    );
    retainRecentGitStatPaths(
      retained,
      Array.from({ length: 256 }, (_, index) => `/repo/second-${index}`),
      256,
    );

    expect(retained.size).toBe(256);
    expect(retained.has("/repo/first-0")).toBe(false);
    expect(retained.has("/repo/second-255")).toBe(true);
  });

  it("refreshes an existing path without consuming extra capacity", () => {
    const retained = new Set(["/repo/a", "/repo/b"]);

    retainRecentGitStatPaths(retained, ["/repo/a", "/repo/c"], 2);

    expect([...retained]).toEqual(["/repo/a", "/repo/c"]);
  });
});
