import { describe, expect, it } from "vitest";
import { terminalMouseTrackingReleaseAction } from "./terminalMouseTracking";

describe("terminalMouseTrackingReleaseAction", () => {
  it("replays a press that never started a selection as a click", () => {
    expect(
      terminalMouseTrackingReleaseAction({
        selecting: false,
        selectedTextLength: 0,
        clickCount: 1,
      }),
    ).toBe("click");
  });

  it("replays an empty selection after a jitter-drag as a click", () => {
    expect(
      terminalMouseTrackingReleaseAction({
        selecting: true,
        selectedTextLength: 0,
        clickCount: 1,
      }),
    ).toBe("click");
  });

  it("keeps any pasteable selection, including one character", () => {
    expect(
      terminalMouseTrackingReleaseAction({
        selecting: true,
        selectedTextLength: 1,
        clickCount: 1,
      }),
    ).toBe("keep-selection");
    expect(
      terminalMouseTrackingReleaseAction({
        selecting: true,
        selectedTextLength: 12,
        clickCount: 1,
      }),
    ).toBe("keep-selection");
  });

  it("keeps double-click word select even when it is empty", () => {
    expect(
      terminalMouseTrackingReleaseAction({
        selecting: true,
        selectedTextLength: 0,
        clickCount: 2,
      }),
    ).toBe("keep-selection");
  });
});
