import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchLatestReleaseNotes: vi.fn(),
  getVersion: vi.fn(),
  openSafeUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("./releases", () => ({
  fetchLatestReleaseNotes: mocks.fetchLatestReleaseNotes,
}));
vi.mock("./safeOpenUrl", () => ({ openSafeUrl: mocks.openSafeUrl }));

import {
  checkForUpdate,
  isNewerVersion,
  openUpdateDownload,
  validateAvailableUpdate,
  type AvailableUpdate,
} from "./updater";

const update: AvailableUpdate = {
  version: "1.33.0",
  body: "Security fixes",
  htmlUrl: "https://github.com/im-ian/acorn/releases/tag/v1.33.0",
};

beforeEach(() => {
  mocks.fetchLatestReleaseNotes.mockReset();
  mocks.getVersion.mockReset();
  mocks.openSafeUrl.mockReset();
  mocks.getVersion.mockResolvedValue("1.32.1");
  mocks.fetchLatestReleaseNotes.mockResolvedValue({
    ...update,
    publishedAt: "2026-08-12T00:00:00Z",
  });
  mocks.openSafeUrl.mockResolvedValue(true);
});

describe("manual update notification", () => {
  it("compares stable semantic versions without lexical ordering bugs", () => {
    expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.32.1", "1.32.1")).toBe(false);
    expect(isNewerVersion("1.31.9", "1.32.0")).toBe(false);
    expect(() => isNewerVersion("1.32.1-beta.1", "1.32.0")).toThrow(
      /Invalid stable/,
    );
  });

  it("accepts only the exact canonical Acorn release page", () => {
    expect(() => validateAvailableUpdate(update)).not.toThrow();
    for (const htmlUrl of [
      "https://example.invalid/im-ian/acorn/releases/tag/v1.33.0",
      "https://github.com/im-ian/other/releases/tag/v1.33.0",
      "https://github.com/im-ian/acorn/releases/tag/v1.33.0?download=1",
      "https://github.com/im-ian/acorn/releases/tag/v1.34.0",
    ]) {
      expect(() => validateAvailableUpdate({ ...update, htmlUrl })).toThrow(
        /canonical/,
      );
    }
  });

  it("returns metadata only for a newer release", async () => {
    await expect(checkForUpdate()).resolves.toEqual(update);
    mocks.getVersion.mockResolvedValue("1.33.0");
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("opens the validated release page without downloading or installing", async () => {
    await expect(openUpdateDownload(update)).resolves.toBeUndefined();
    expect(mocks.openSafeUrl).toHaveBeenCalledWith(update.htmlUrl);

    mocks.openSafeUrl.mockResolvedValue(false);
    await expect(openUpdateDownload(update)).rejects.toThrow(/Could not open/);
  });
});
