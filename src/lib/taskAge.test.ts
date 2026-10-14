import { describe, expect, it } from "vitest";
import { taskAgeLabel } from "./taskAge";

const NOW = Date.parse("2026-10-14T00:00:00Z");

describe("taskAgeLabel", () => {
  it("uses just now, minutes, hours, days, and years", () => {
    expect(taskAgeLabel("2026-10-13T23:59:30Z", NOW, "just now")).toBe("just now");
    expect(taskAgeLabel("2026-10-13T23:50:00Z", NOW, "just now")).toBe("10m");
    expect(taskAgeLabel("2026-10-13T23:00:00Z", NOW, "just now")).toBe("1h");
    expect(taskAgeLabel("2026-10-13T00:00:00Z", NOW, "just now")).toBe("1d");
    expect(taskAgeLabel("2025-10-14T00:00:00Z", NOW, "just now")).toBe("1y");
  });

  it("returns an empty string for a bad timestamp", () => {
    expect(taskAgeLabel("nope", NOW, "just now")).toBe("");
  });
});
