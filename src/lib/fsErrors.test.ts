import { describe, expect, it } from "vitest";
import { isMissingPathError } from "./fsErrors";

describe("isMissingPathError", () => {
  it("matches Unix and Windows missing-path IO errors", () => {
    expect(
      isMissingPathError(
        new Error("io error: No such file or directory (os error 2)"),
      ),
    ).toBe(true);
    expect(
      isMissingPathError(
        new Error(
          "io error: The system cannot find the file specified. (os error 2)",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingPathError("The system cannot find the path specified"),
    ).toBe(true);
  });

  it("rejects other filesystem failures so they stay visible", () => {
    expect(isMissingPathError(new Error("permission denied"))).toBe(false);
    expect(
      isMissingPathError(new Error("diff stats unavailable for oversized file")),
    ).toBe(false);
    expect(isMissingPathError("path outside allowed project roots")).toBe(
      false,
    );
  });
});
