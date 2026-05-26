import { describe, expect, it } from "vitest";
import {
  isMacPlatform,
  markPermissionWarmupHandled,
  PERMISSION_WARMUP_STORAGE_KEY,
  shouldShowPermissionWarmup,
} from "./permissionWarmup";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) =>
      key === PERMISSION_WARMUP_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === PERMISSION_WARMUP_STORAGE_KEY) value = next;
    },
  };
}

describe("permission warmup gate", () => {
  it("only targets macOS-like platforms", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("Win32")).toBe(false);
  });

  it("shows once per app version on macOS", () => {
    const storage = memoryStorage();

    expect(shouldShowPermissionWarmup("1.2.3", "MacIntel", storage)).toBe(true);
    markPermissionWarmupHandled("1.2.3", storage);
    expect(shouldShowPermissionWarmup("1.2.3", "MacIntel", storage)).toBe(false);
    expect(shouldShowPermissionWarmup("1.2.4", "MacIntel", storage)).toBe(true);
  });

  it("does not show when current version is missing or platform is not macOS", () => {
    const storage = memoryStorage();

    expect(shouldShowPermissionWarmup(null, "MacIntel", storage)).toBe(false);
    expect(shouldShowPermissionWarmup("1.2.3", "Linux x86_64", storage)).toBe(
      false,
    );
  });
});
