import { describe, expect, it } from "vitest";
import {
  isSessionInFocusedPane,
  visibleMultiInputSessionIds,
} from "./multiInput";

describe("visibleMultiInputSessionIds", () => {
  it("returns the active session from each visible pane", () => {
    expect(
      visibleMultiInputSessionIds({
        left: { activeSessionId: "s1" },
        right: { activeSessionId: "s2" },
      }),
    ).toEqual(["s1", "s2"]);
  });

  it("skips empty panes and de-duplicates sessions", () => {
    expect(
      visibleMultiInputSessionIds({
        left: { activeSessionId: "s1" },
        middle: { activeSessionId: null },
        right: { activeSessionId: "s1" },
      }),
    ).toEqual(["s1"]);
  });
});

describe("isSessionInFocusedPane", () => {
  it("returns true only for the active session in the focused pane", () => {
    const panes = {
      left: { activeSessionId: "s1" },
      right: { activeSessionId: "s2" },
    };

    expect(isSessionInFocusedPane("s1", panes, "left")).toBe(true);
    expect(isSessionInFocusedPane("s2", panes, "left")).toBe(false);
  });
});
