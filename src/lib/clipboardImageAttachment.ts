import { appLocalDataDir, join } from "@tauri-apps/api/path";
import {
  ensureRealDirectory,
  writeNewPrivateFile,
} from "./safeAppLocalFs";

export const CLIPBOARD_ATTACHMENTS_DIR = "clipboard-attachments";
export const MAX_CLIPBOARD_IMAGE_BYTES = 25 * 1024 * 1024;

export interface ClipboardImageAttachmentSource {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface ClipboardImageAttachment {
  path: string;
  fileName: string;
}

const IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

function randomAttachmentToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function extOfName(name: string | undefined): string {
  const match = name?.match(/\.([a-zA-Z0-9]{1,12})$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function extOfImage(source: ClipboardImageAttachmentSource): string {
  return (
    IMAGE_TYPE_EXTENSIONS[source.type?.toLowerCase() ?? ""] ||
    extOfName(source.name) ||
    ".png"
  );
}

export async function saveClipboardImageAttachment(
  source: ClipboardImageAttachmentSource,
): Promise<ClipboardImageAttachment> {
  if (
    source.size !== undefined &&
    (!Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      source.size > MAX_CLIPBOARD_IMAGE_BYTES)
  ) {
    throw new Error(
      `Clipboard image exceeds the ${MAX_CLIPBOARD_IMAGE_BYTES}-byte limit`,
    );
  }

  const buffer = await source.arrayBuffer();
  if (buffer.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(
      `Clipboard image exceeds the ${MAX_CLIPBOARD_IMAGE_BYTES}-byte limit`,
    );
  }
  const bytes = new Uint8Array(buffer);
  const root = await appLocalDataDir();
  const dir = await join(root, CLIPBOARD_ATTACHMENTS_DIR);
  await ensureRealDirectory(dir, "Clipboard attachment directory");

  const storedName = `clipboard-${randomAttachmentToken()}${extOfImage(source)}`;
  const path = await join(dir, storedName);
  await writeNewPrivateFile(path, bytes, "Clipboard image attachment");

  return {
    path,
    fileName: source.name || storedName,
  };
}
