import { describe, expect, it } from "vitest";
import {
  createToggleLatch,
  isSessionInFocusedPane,
  multiInputWriteSessionIds,
  visibleMultiInputSessionIds,
} from "./multiInput";

describe("visibleMultiInputSessionIds", () => {
  it("returns the active session from each visible pane", () => {
    expect(
      visibleMultiInputSessionIds({
        left: { activeTabId: "s1" },
        right: { activeTabId: "s2" },
      }),
    ).toEqual(["s1", "s2"]);
  });

  it("skips empty panes and de-duplicates sessions", () => {
    expect(
      visibleMultiInputSessionIds({
        left: { activeTabId: "s1" },
        middle: { activeTabId: null },
        right: { activeTabId: "s1" },
      }),
    ).toEqual(["s1"]);
  });

  it("skips frontend-owned tabs", () => {
    expect(
      visibleMultiInputSessionIds({
        left: { activeTabId: "s1" },
        right: { activeTabId: "code-viewer:abc" },
      }),
    ).toEqual(["s1"]);
  });
});

describe("isSessionInFocusedPane", () => {
  it("returns true only for the active session in the focused pane", () => {
    const panes = {
      left: { activeTabId: "s1" },
      right: { activeTabId: "s2" },
    };

    expect(isSessionInFocusedPane("s1", panes, "left")).toBe(true);
    expect(isSessionInFocusedPane("s2", panes, "left")).toBe(false);
  });
});

describe("multiInputWriteSessionIds", () => {
  const panes = {
    left: { activeTabId: "s1" },
    right: { activeTabId: "s2" },
  };
  const sessions = [
    { id: "s1" },
    { id: "s2" },
    { id: "chat", mode: "chat" as const },
    { id: "old", archived_at: "2026-01-01T00:00:00Z" },
  ];

  it("stays on the focused session when multi-input is off", () => {
    expect(multiInputWriteSessionIds(false, panes, "s1", sessions)).toEqual([
      "s1",
    ]);
  });

  it("fans out to each visible pane's active session when enabled", () => {
    expect(multiInputWriteSessionIds(true, panes, "s1", sessions)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("skips chat and archived sessions", () => {
    expect(
      multiInputWriteSessionIds(
        true,
        {
          left: { activeTabId: "s1" },
          right: { activeTabId: "chat" },
          extra: { activeTabId: "old" },
        },
        "s1",
        sessions,
      ),
    ).toEqual(["s1"]);
  });
});

describe("createToggleLatch", () => {
  it("accepts the first event and ignores a duplicate inside the window", () => {
    const accept = createToggleLatch(50);
    expect(accept(1000)).toBe(true);
    expect(accept(1049)).toBe(false);
    expect(accept(1050)).toBe(true);
  });
});
