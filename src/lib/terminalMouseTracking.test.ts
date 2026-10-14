import { describe, expect, it } from "vitest";
import {
  terminalLinkClickShouldReachApp,
  terminalLinkPressShouldOpen,
  terminalMouseTrackingReleaseAction,
} from "./terminalMouseTracking";

describe("terminalLinkPressShouldOpen", () => {
  it("opens the first press and skips the rest of a multi-click", () => {
    expect(terminalLinkPressShouldOpen(1)).toBe(true);
    expect(terminalLinkPressShouldOpen(0)).toBe(true);
    expect(terminalLinkPressShouldOpen(2)).toBe(false);
    expect(terminalLinkPressShouldOpen(3)).toBe(false);
  });
});

describe("terminalLinkClickShouldReachApp", () => {
  const reach = (
    overrides: Partial<Parameters<typeof terminalLinkClickShouldReachApp>[0]>,
  ) =>
    terminalLinkClickShouldReachApp({
      mouseTracking: true,
      hasLink: true,
      linkActivation: "click",
      modifierHeld: false,
      altKey: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...overrides,
    });

  it("keeps a link click the terminal opens away from a tracking app", () => {
    expect(reach({ modifierHeld: false })).toBe(false);
    expect(reach({ modifierHeld: true })).toBe(false);
    expect(
      reach({ linkActivation: "modifier-click", modifierHeld: true }),
    ).toBe(false);
    expect(reach({ metaKey: true, modifierHeld: true })).toBe(false);
    expect(reach({ ctrlKey: true, modifierHeld: true })).toBe(false);
  });

  it("still delivers clicks the terminal is not opening", () => {
    expect(
      reach({ linkActivation: "modifier-click", modifierHeld: false }),
    ).toBe(true);
    expect(reach({ hasLink: false })).toBe(true);
    expect(reach({ mouseTracking: false, modifierHeld: true })).toBe(true);
  });

  it("lets selection modifiers and a non-chord modifier reach the app", () => {
    expect(reach({ altKey: true })).toBe(true);
    expect(reach({ shiftKey: true })).toBe(true);
    expect(reach({ altKey: true, modifierHeld: true })).toBe(true);
    expect(reach({ shiftKey: true, modifierHeld: true })).toBe(true);
    expect(reach({ ctrlKey: true, modifierHeld: false })).toBe(true);
    expect(reach({ metaKey: true, modifierHeld: false })).toBe(true);
  });
});

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
