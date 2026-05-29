import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";

export const CLIPBOARD_ATTACHMENTS_DIR = "clipboard-attachments";

export interface ClipboardImageAttachmentSource {
  name?: string;
  type?: string;
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

function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;

  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
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
  const root = await appLocalDataDir();
  const dir = await join(root, CLIPBOARD_ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });

  const bytes = new Uint8Array(await source.arrayBuffer());
  const storedName = `clipboard-${shortHash(bytes)}${extOfImage(source)}`;
  const path = await join(dir, storedName);
  await writeFile(path, bytes);

  return {
    path,
    fileName: source.name || storedName,
  };
}
