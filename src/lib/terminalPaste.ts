export const CODEX_IMAGE_PASTE_CONTROL = "\x16";

type TerminalPasteInput = {
  text: string;
  fileCount: number;
  codexActive: boolean;
};

export type TerminalPasteAction =
  | { kind: "native" }
  | { kind: "pasteText"; text: string }
  | { kind: "send"; data: string }
  | { kind: "handled" };

export function terminalPasteAction({
  text,
  fileCount,
  codexActive,
}: TerminalPasteInput): TerminalPasteAction {
  if (text) {
    return { kind: "pasteText", text };
  }
  if (fileCount > 0) {
    return codexActive
      ? { kind: "send", data: CODEX_IMAGE_PASTE_CONTROL }
      : { kind: "native" };
  }
  return { kind: "handled" };
}
