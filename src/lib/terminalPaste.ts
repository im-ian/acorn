export const AGENT_IMAGE_PASTE_CONTROL = "\x16";

type TerminalPasteInput = {
  text: string;
  hasImagePayload: boolean;
};

type ClipboardFilePayloadInput = {
  files?: {
    length: number;
    [index: number]: ClipboardImageFile | undefined;
  } | null;
  items?: {
    length: number;
    [index: number]: ClipboardItemLike | undefined;
  } | null;
  types?:
    | { length: number; [index: number]: string | undefined }
    | readonly string[]
    | null;
};

export type ClipboardImageFile = {
  name?: string;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type ClipboardItemLike = {
  kind?: string;
  type?: string;
  getAsFile?: () => ClipboardImageFile | null;
};

export type TerminalPasteAction =
  | { kind: "native" }
  | { kind: "deferImageAttachment" }
  | { kind: "pasteText"; text: string }
  | { kind: "handled" };

const IMAGE_FILE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpg",
  "jpeg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);

function hasImageFileName(name: string | undefined): boolean {
  const match = name?.match(/\.([a-zA-Z0-9]+)$/);
  return match ? IMAGE_FILE_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

function isImageFile(file: ClipboardImageFile | null | undefined): boolean {
  return Boolean(
    file &&
      (file.type?.startsWith("image/") || hasImageFileName(file.name)) &&
      typeof file.arrayBuffer === "function",
  );
}

export function getClipboardImageFile(
  data: ClipboardFilePayloadInput | null | undefined,
): ClipboardImageFile | null {
  if (!data) return null;

  const files = data.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (isImageFile(file)) return file ?? null;
    }
  }

  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.type?.startsWith("image/")) {
        const file = item.getAsFile?.();
        if (isImageFile(file)) return file ?? null;
      }
    }
  }

  return null;
}

export function hasClipboardImagePayload(
  data: ClipboardFilePayloadInput | null | undefined,
): boolean {
  if (!data) return false;
  if (getClipboardImageFile(data)) return true;

  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.type?.startsWith("image/")) return true;
    }
  }

  const types = data.types;
  if (types) {
    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      if (type === "Files" || type?.startsWith("image/")) return true;
    }
  }

  return false;
}

export function terminalPasteAction({
  text,
  hasImagePayload,
}: TerminalPasteInput): TerminalPasteAction {
  if (text) {
    return { kind: "pasteText", text };
  }
  if (hasImagePayload) {
    return { kind: "deferImageAttachment" };
  }
  return { kind: "native" };
}
