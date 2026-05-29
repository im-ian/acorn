import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriFsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

const tauriPathMock = vi.hoisted(() => ({
  appLocalDataDir: vi.fn(),
  join: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => tauriFsMock);
vi.mock("@tauri-apps/api/path", () => tauriPathMock);

import {
  CLIPBOARD_ATTACHMENTS_DIR,
  saveClipboardImageAttachment,
} from "./clipboardImageAttachment";
import defaultCapabilitiesRaw from "../../src-tauri/capabilities/default.json?raw";

beforeEach(() => {
  tauriPathMock.appLocalDataDir.mockResolvedValue("/app/local");
  tauriPathMock.join.mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/")),
  );
  tauriFsMock.mkdir.mockResolvedValue(undefined);
  tauriFsMock.writeFile.mockResolvedValue(undefined);
  vi.clearAllMocks();
});

describe("saveClipboardImageAttachment", () => {
  it("writes clipboard image bytes into app-local attachments", async () => {
    const result = await saveClipboardImageAttachment({
      name: "Screenshot 2026-05-29.png",
      type: "image/png",
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });

    expect(tauriFsMock.mkdir).toHaveBeenCalledWith(
      `/app/local/${CLIPBOARD_ATTACHMENTS_DIR}`,
      { recursive: true },
    );
    expect(tauriFsMock.writeFile).toHaveBeenCalledOnce();
    const [path, bytes] = tauriFsMock.writeFile.mock.calls[0];
    expect(path).toMatch(
      new RegExp(`/app/local/${CLIPBOARD_ATTACHMENTS_DIR}/clipboard-[0-9a-f]{8}\\.png$`),
    );
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(result).toEqual({
      path,
      fileName: "Screenshot 2026-05-29.png",
    });
  });

  it("falls back to the image MIME type when the clipboard file has no name", async () => {
    await saveClipboardImageAttachment({
      type: "image/jpeg",
      arrayBuffer: async () => new Uint8Array([5]).buffer,
    });

    const [path] = tauriFsMock.writeFile.mock.calls[0];
    expect(path).toMatch(/\.jpg$/);
  });
});

describe("Tauri clipboard attachment write access", () => {
  it("allows the renderer to persist app-local clipboard attachments", () => {
    const capabilities = JSON.parse(defaultCapabilitiesRaw) as {
      permissions?: Array<string | { identifier?: string; allow?: string[] }>;
    };
    const scope = capabilities.permissions?.find(
      (permission): permission is { identifier: string; allow: string[] } =>
        typeof permission === "object" && permission.identifier === "fs:scope",
    );

    expect(scope?.allow).toContain(`$APPLOCALDATA/${CLIPBOARD_ATTACHMENTS_DIR}`);
    expect(scope?.allow).toContain(
      `$APPLOCALDATA/${CLIPBOARD_ATTACHMENTS_DIR}/**/*`,
    );
  });
});
