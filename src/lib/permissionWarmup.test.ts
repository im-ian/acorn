import { describe, expect, it } from "vitest";
import {
  hasDeniedFolderPermission,
  isMacPlatform,
} from "./permissionWarmup";

describe("permission warmup gate", () => {
  it("only targets macOS-like platforms", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("Win32")).toBe(false);
  });

  it("flags denied probe results for restart-time attention", () => {
    expect(
      hasDeniedFolderPermission([
        {
          id: "desktop",
          path: "/Users/tester/Desktop",
          status: "ok",
          error: null,
        },
        {
          id: "documents",
          path: "/Users/tester/Documents",
          status: "missing",
          error: null,
        },
      ]),
    ).toBe(false);
    expect(
      hasDeniedFolderPermission([
        {
          id: "downloads",
          path: "/Users/tester/Downloads",
          status: "denied",
          error: "Operation not permitted",
        },
      ]),
    ).toBe(true);
  });
});
