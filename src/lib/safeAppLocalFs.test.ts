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

vi.mock("@tauri-apps/plugin-fs", () => tauriFsMock);

import { writeNewPrivateFile } from "./safeAppLocalFs";

beforeEach(() => {
  tauriFsMock.open.mockResolvedValue(fileHandleMock);
  tauriFsMock.remove.mockResolvedValue(undefined);
  fileHandleMock.close.mockResolvedValue(undefined);
  vi.clearAllMocks();
});

describe("writeNewPrivateFile", () => {
  it("retries short writes until every byte is persisted", async () => {
    let size = 0;
    fileHandleMock.write.mockImplementation(async (bytes: Uint8Array) => {
      const written = Math.min(2, bytes.byteLength);
      size += written;
      return written;
    });
    fileHandleMock.stat.mockImplementation(async () => ({
      isFile: true,
      isSymlink: false,
      size,
    }));

    await writeNewPrivateFile(
      "/app/local/private.bin",
      new Uint8Array([1, 2, 3, 4, 5]),
      "private file",
    );

    expect(
      fileHandleMock.write.mock.calls.map(([bytes]) => Array.from(bytes)),
    ).toEqual([[1, 2, 3, 4, 5], [3, 4, 5], [5]]);
    expect(fileHandleMock.close).toHaveBeenCalledOnce();
    expect(tauriFsMock.remove).not.toHaveBeenCalled();
  });

  it("removes the new file when a write makes no progress", async () => {
    fileHandleMock.write.mockResolvedValue(0);
    fileHandleMock.stat.mockResolvedValue({
      isFile: true,
      isSymlink: false,
      size: 0,
    });

    await expect(
      writeNewPrivateFile(
        "/app/local/private.bin",
        new Uint8Array([1]),
        "private file",
      ),
    ).rejects.toThrow(/could not be completely written/);

    expect(fileHandleMock.close).toHaveBeenCalledOnce();
    expect(tauriFsMock.remove).toHaveBeenCalledWith("/app/local/private.bin");
  });
});
