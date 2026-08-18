import {
  exists,
  lstat,
  mkdir,
  open,
  remove,
} from "@tauri-apps/plugin-fs";

export async function ensureRealDirectory(
  path: string,
  label: string,
): Promise<void> {
  if (!(await exists(path))) {
    await mkdir(path, { recursive: true });
  }

  const info = await lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`${label} is not a real directory`);
  }
}

export async function writeNewPrivateFile(
  path: string,
  contents: Uint8Array,
  label: string,
): Promise<void> {
  const file = await open(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });

  try {
    let offset = 0;
    while (offset < contents.byteLength) {
      const remaining = contents.byteLength - offset;
      const written = await file.write(contents.subarray(offset));
      if (!Number.isInteger(written) || written <= 0 || written > remaining) {
        throw new Error(`${label} could not be completely written`);
      }
      offset += written;
    }

    const info = await file.stat();
    if (!info.isFile || info.isSymlink || info.size !== contents.byteLength) {
      throw new Error(`${label} changed while it was being written`);
    }
  } catch (error) {
    await file.close().catch(() => {});
    await remove(path).catch(() => {});
    throw error;
  }

  try {
    await file.close();
  } catch (error) {
    await remove(path).catch(() => {});
    throw error;
  }
}
