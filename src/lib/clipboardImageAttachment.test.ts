import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriFsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
}));

const fileHandleMock = vi.hoisted(() => ({
  write: vi.fn(),
  stat: vi.fn(),
  close: vi.fn(),
}));

const tauriPathMock = vi.hoisted(() => ({
  appLocalDataDir: vi.fn(),
  join: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => tauriFsMock);
vi.mock("@tauri-apps/api/path", () => tauriPathMock);

import {
  CLIPBOARD_ATTACHMENTS_DIR,
  MAX_CLIPBOARD_IMAGE_BYTES,
  saveClipboardImageAttachment,
} from "./clipboardImageAttachment";
import defaultCapabilitiesRaw from "../../src-tauri/capabilities/default.json?raw";

beforeEach(() => {
  tauriPathMock.appLocalDataDir.mockResolvedValue("/app/local");
  tauriPathMock.join.mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/")),
  );
  tauriFsMock.exists.mockResolvedValue(false);
  tauriFsMock.lstat.mockResolvedValue({
    isDirectory: true,
    isSymlink: false,
  });
  tauriFsMock.mkdir.mockResolvedValue(undefined);
  tauriFsMock.remove.mockResolvedValue(undefined);
  let writtenSize = 0;
  fileHandleMock.write.mockImplementation(async (bytes: Uint8Array) => {
    writtenSize = bytes.byteLength;
    return writtenSize;
  });
  fileHandleMock.stat.mockImplementation(async () => ({
    isFile: true,
    isSymlink: false,
    size: writtenSize,
  }));
  fileHandleMock.close.mockResolvedValue(undefined);
  tauriFsMock.open.mockResolvedValue(fileHandleMock);
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
    expect(tauriFsMock.open).toHaveBeenCalledOnce();
    const [path, options] = tauriFsMock.open.mock.calls[0];
    expect(path).toMatch(
      new RegExp(`/app/local/${CLIPBOARD_ATTACHMENTS_DIR}/clipboard-[0-9a-f]{32}\\.png$`),
    );
    expect(options).toMatchObject({ write: true, createNew: true, mode: 0o600 });
    expect(Array.from(fileHandleMock.write.mock.calls[0][0])).toEqual([
      1, 2, 3, 4,
    ]);
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

    const [path] = tauriFsMock.open.mock.calls[0];
    expect(path).toMatch(/\.jpg$/);
  });

  it("rejects a symlinked attachment directory before creating a file", async () => {
    tauriFsMock.exists.mockResolvedValueOnce(true);
    tauriFsMock.lstat.mockResolvedValueOnce({
      isDirectory: false,
      isSymlink: true,
    });

    await expect(
      saveClipboardImageAttachment({
        type: "image/png",
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }),
    ).rejects.toThrow(/not a real directory/);
    expect(tauriFsMock.open).not.toHaveBeenCalled();
  });

  it("rejects a known oversized image before materializing its bytes", async () => {
    const arrayBuffer = vi.fn<() => Promise<ArrayBuffer>>();

    await expect(
      saveClipboardImageAttachment({
        name: "huge.png",
        type: "image/png",
        size: MAX_CLIPBOARD_IMAGE_BYTES + 1,
        arrayBuffer,
      }),
    ).rejects.toThrow(/exceeds/);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(tauriFsMock.open).not.toHaveBeenCalled();
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
    expect(capabilities.permissions).not.toContain("fs:allow-write-file");
  });
});
