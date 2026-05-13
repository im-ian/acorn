import { describe, expect, it } from "vitest";

import { extractTabFromEvent } from "./settings-events";

describe("extractTabFromEvent", () => {
  it("returns the string payload when given a non-empty string", () => {
    expect(extractTabFromEvent("background-sessions")).toBe(
      "background-sessions",
    );
  });

  it("returns the tab field from an object payload", () => {
    expect(extractTabFromEvent({ tab: "agents" })).toBe("agents");
  });

  it("ignores extra fields on the object payload", () => {
    expect(extractTabFromEvent({ tab: "sessions", other: 42 })).toBe(
      "sessions",
    );
  });

  it("returns null for an empty string", () => {
    expect(extractTabFromEvent("")).toBeNull();
  });

  it("returns null when the tab field is empty", () => {
    expect(extractTabFromEvent({ tab: "" })).toBeNull();
  });

  it("returns null when the tab field is not a string", () => {
    expect(extractTabFromEvent({ tab: 1 })).toBeNull();
  });

  it("returns null for null / undefined detail", () => {
    expect(extractTabFromEvent(null)).toBeNull();
    expect(extractTabFromEvent(undefined)).toBeNull();
  });

  it("returns null for an object without a tab field", () => {
    expect(extractTabFromEvent({ other: "x" })).toBeNull();
  });

  it("returns null for primitive non-string detail", () => {
    expect(extractTabFromEvent(42)).toBeNull();
    expect(extractTabFromEvent(true)).toBeNull();
  });
});
