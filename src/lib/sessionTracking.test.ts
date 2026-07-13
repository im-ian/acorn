import { describe, expect, it } from "vitest";
import {
  pruneSessionIdSet,
  retainSessionMapEntries,
} from "./sessionTracking";

describe("session tracking collection cleanup", () => {
  it("removes deleted session ids from mutable tracking sets", () => {
    const tracked = new Set(["live-a", "deleted", "live-b"]);
    const live = new Set(["live-a", "live-b"]);

    const changed = pruneSessionIdSet(tracked, live);

    expect(changed).toBe(true);
    expect([...tracked]).toEqual(["live-a", "live-b"]);
  });

  it("returns a pruned copy when a session-keyed state map has stale entries", () => {
    const tracked = new Map([
      ["live", { title: "keep" }],
      ["deleted", { title: "release" }],
    ]);

    const result = retainSessionMapEntries(tracked, new Set(["live"]));

    expect(result).not.toBe(tracked);
    expect([...result]).toEqual([["live", { title: "keep" }]]);
    expect(tracked.size).toBe(2);
  });

  it("preserves state map identity when every tracked session is still live", () => {
    const tracked = new Map([["live", { title: "keep" }]]);

    const result = retainSessionMapEntries(tracked, new Set(["live"]));

    expect(result).toBe(tracked);
  });
});
