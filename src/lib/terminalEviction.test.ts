import { describe, expect, it } from "vitest";
import { selectTerminalsToEvict } from "./terminalEviction";

const set = (...ids: string[]) => new Set(ids);

describe("selectTerminalsToEvict", () => {
  it("returns nothing when at or under the cap", () => {
    expect(
      selectTerminalsToEvict({
        mounted: ["a", "b"],
        visible: set("a"),
        recency: ["b", "a"],
        daemonAlive: set("a", "b"),
        max: 2,
      }),
    ).toEqual([]);
  });

  it("evicts least-recently-visible first when over the cap", () => {
    // recency is least-recent → most-recent; "c" is the stalest off-screen one.
    expect(
      selectTerminalsToEvict({
        mounted: ["a", "b", "c", "d"],
        visible: set("d"),
        recency: ["c", "b", "a", "d"],
        daemonAlive: set("a", "b", "c", "d"),
        max: 3,
      }),
    ).toEqual(["c"]);
  });

  it("sheds enough victims to reach the cap", () => {
    expect(
      selectTerminalsToEvict({
        mounted: ["a", "b", "c", "d", "e"],
        visible: set("e"),
        recency: ["a", "b", "c", "d", "e"],
        daemonAlive: set("a", "b", "c", "d", "e"),
        max: 3,
      }),
    ).toEqual(["a", "b"]);
  });

  it("never evicts visible terminals even when stale", () => {
    expect(
      selectTerminalsToEvict({
        mounted: ["a", "b", "c"],
        visible: set("a", "b"),
        recency: ["a", "b", "c"],
        daemonAlive: set("a", "b", "c"),
        max: 1,
      }),
    ).toEqual(["c"]);
  });

  it("never evicts in-process (non-daemon-alive) terminals", () => {
    // "a" and "b" are in-process; only daemon-alive "c" is eligible.
    expect(
      selectTerminalsToEvict({
        mounted: ["a", "b", "c", "d"],
        visible: set("d"),
        recency: ["a", "b", "c", "d"],
        daemonAlive: set("c"),
        max: 2,
      }),
    ).toEqual(["c"]);
  });

  it("returns fewer than the overflow when too few are evictable", () => {
    // Over cap by 2, but only "b" is an off-screen daemon session.
    expect(
      selectTerminalsToEvict({
        mounted: ["a", "b", "c", "d"],
        visible: set("c", "d"),
        recency: ["a", "b", "c", "d"],
        daemonAlive: set("b"),
        max: 1,
      }),
    ).toEqual(["b"]);
  });

  it("ignores recency entries no longer mounted", () => {
    expect(
      selectTerminalsToEvict({
        mounted: ["b", "c"],
        visible: set("c"),
        recency: ["a", "b", "c"], // "a" already unmounted
        daemonAlive: set("a", "b", "c"),
        max: 1,
      }),
    ).toEqual(["b"]);
  });
});
