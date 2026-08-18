import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { isSafeOpenUrl, openSafeUrl } from "./safeOpenUrl";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(true);
});

describe("isSafeOpenUrl", () => {
  it.each([
    "https://github.com/im-ian/acorn",
    "http://localhost:8010/path?q=1",
    "mailto:security@example.com?subject=Report",
  ])("accepts an explicit supported URL: %s", (value) => {
    expect(isSafeOpenUrl(value)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "irc://chat.example/channel",
    "//tracker.example/path",
    "/relative/path",
    String.raw`https:\\tracker.example\path`,
    "https:\n//tracker.example/path",
    " https://tracker.example/path",
    "https://tracker.example/a path",
    "https://user:secret@tracker.example/path",
    String.raw`https://tracker.example\path`,
    `https://tracker.example/${"a".repeat(8 * 1024)}`,
    `https://tracker.example/${"한".repeat(3 * 1024)}`,
    "mailto:",
    "mailto:security@example.com?attach=/etc/passwd",
    "mailto:security@example.com#fragment",
  ])("rejects an unsafe or ambiguous URL: %j", (value) => {
    expect(isSafeOpenUrl(value)).toBe(false);
  });

  it("opens only a URL that passed the shared validator", async () => {
    await expect(
      openSafeUrl("https://github.com/im-ian/acorn"),
    ).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/im-ian/acorn",
    });

    await expect(openSafeUrl("https://user@example.com/")).resolves.toBe(
      false,
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
