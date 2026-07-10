import { describe, expect, it } from "vitest";
import {
  createFolderPermissionOutputDetector,
  hasDeniedFolderPermission,
  isMacPlatform,
} from "./permissionWarmup";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

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

  it("detects Homebrew's unreadable current-directory failure", () => {
    const detector = createFolderPermissionOutputDetector();

    expect(
      detector.push(
        bytes(
          "Error: The current working directory must be readable to jthefloor to run brew.\r\n",
        ),
      ),
    ).toBe(true);
  });

  it("detects a Codex permission failure split across output chunks", () => {
    const detector = createFolderPermissionOutputDetector();

    expect(detector.push(bytes("\u001b[31mError: Operation not per"))).toBe(
      false,
    );
    expect(
      detector.push(bytes("mitted (os error 1)\u001b[0m\r\n")),
    ).toBe(true);
  });

  it("ignores unrelated permission errors", () => {
    const detector = createFolderPermissionOutputDetector();

    expect(
      detector.push(bytes("rm: cache.db: Operation not permitted\r\n")),
    ).toBe(false);
    expect(
      detector.push(bytes("Error: current directory is unavailable\r\n")),
    ).toBe(false);
  });

  it("rearms after a permission failure so later commands can trigger another audit", () => {
    const detector = createFolderPermissionOutputDetector();
    const failure = bytes("Error: Operation not permitted (os error 1)\r\n");

    expect(detector.push(new Uint8Array())).toBe(false);
    expect(detector.push(failure)).toBe(true);
    expect(detector.push(bytes("jthefloor@mac . % "))).toBe(false);
    expect(detector.push(failure)).toBe(true);
  });
});
