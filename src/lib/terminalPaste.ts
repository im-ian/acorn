export const AGENT_IMAGE_PASTE_CONTROL = "\x16";

type TerminalPasteInput = {
  text: string;
  hasFilePayload: boolean;
  imagePasteShortcutActive: boolean;
};

type ClipboardFilePayloadInput = {
  files?: { length: number } | null;
  items?: {
    length: number;
    [index: number]: ClipboardItemLike | undefined;
  } | null;
  types?:
    | { length: number; [index: number]: string | undefined }
    | readonly string[]
    | null;
};

type ClipboardItemLike = {
  kind?: string;
  type?: string;
};

export type TerminalPasteAction =
  | { kind: "native" }
  | { kind: "pasteText"; text: string }
  | { kind: "send"; data: string }
  | { kind: "handled" };

export function hasClipboardFilePayload(
  data: ClipboardFilePayloadInput | null | undefined,
): boolean {
  if (!data) return false;
  if ((data.files?.length ?? 0) > 0) return true;

  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.kind === "file" || item?.type?.startsWith("image/")) {
        return true;
      }
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
  hasFilePayload,
  imagePasteShortcutActive,
}: TerminalPasteInput): TerminalPasteAction {
  if (text) {
    return { kind: "pasteText", text };
  }
  if (hasFilePayload) {
    return imagePasteShortcutActive
      ? { kind: "send", data: AGENT_IMAGE_PASTE_CONTROL }
      : { kind: "native" };
  }
  return { kind: "handled" };
}
