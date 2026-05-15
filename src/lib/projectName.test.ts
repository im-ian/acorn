import { describe, expect, it } from "vitest";
import { validateProjectName } from "./projectName";

describe("validateProjectName", () => {
  it("rejects names that are not a single folder component", () => {
    expect(validateProjectName("").kind).toBe("hard");
    expect(validateProjectName(".").kind).toBe("hard");
    expect(validateProjectName("..").kind).toBe("hard");
    expect(validateProjectName("parent/app").kind).toBe("hard");
  });

  it("warns for names likely to exceed common macOS/Linux component limits", () => {
    expect(validateProjectName("a".repeat(256))).toMatchObject({
      kind: "safe",
      reason: "component_too_long",
    });
  });

  it("accepts ordinary macOS/Linux folder names", () => {
    expect(validateProjectName("fresh-app")).toEqual({ kind: "ok" });
    expect(validateProjectName("Fresh_App 2")).toEqual({ kind: "ok" });
    expect(validateProjectName("CON")).toEqual({ kind: "ok" });
    expect(validateProjectName("foo:bar")).toEqual({ kind: "ok" });
    expect(validateProjectName("name.")).toEqual({ kind: "ok" });
    expect(validateProjectName("parent\\app")).toEqual({ kind: "ok" });
  });
});
