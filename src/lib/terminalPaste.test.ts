import { describe, expect, it } from "vitest";
import {
  CODEX_IMAGE_PASTE_CONTROL,
  getClipboardImageFile,
  hasClipboardImagePayload,
  terminalPasteAction,
  type ClipboardImageFile,
} from "./terminalPaste";

it("keeps Codex fallback wired to Ctrl+V", () => {
  expect(CODEX_IMAGE_PASTE_CONTROL).toBe("\x16");
});

describe("terminalPasteAction", () => {
  it("defers image-only paste so the terminal can fallback after native paste", () => {
    expect(
      terminalPasteAction({
        text: "",
        hasImagePayload: true,
      }),
    ).toEqual({ kind: "deferImageAttachment" });
  });

  it("handles empty non-image paste without touching the browser path", () => {
    expect(
      terminalPasteAction({
        text: "",
        hasImagePayload: false,
      }),
    ).toEqual({ kind: "handled" });
  });

  it("pastes text through xterm even when files are also present", () => {
    expect(
      terminalPasteAction({
        text: "hello",
        hasImagePayload: true,
      }),
    ).toEqual({ kind: "pasteText", text: "hello" });
  });
});

describe("clipboard image detection", () => {
  const imageFile: ClipboardImageFile = {
    name: "screenshot.png",
    type: "image/png",
    arrayBuffer: async () => new ArrayBuffer(0),
  };

  it("returns image files exposed through files", () => {
    expect(getClipboardImageFile({ files: { length: 1, 0: imageFile } })).toBe(
      imageFile,
    );
  });

  it("returns image files exposed through clipboard items", () => {
    expect(
      getClipboardImageFile({
        files: { length: 0 },
        items: {
          length: 1,
          0: { kind: "file", type: "image/png", getAsFile: () => imageFile },
        },
      }),
    ).toBe(imageFile);
  });

  it("accepts image payloads exposed only through clipboard items", () => {
    expect(
      hasClipboardImagePayload({
        files: { length: 0 },
        items: { length: 1, 0: { kind: "string", type: "image/png" } },
      }),
    ).toBe(true);
  });

  it("accepts image payloads exposed only through clipboard types", () => {
    expect(
      hasClipboardImagePayload({
        files: { length: 0 },
        items: { length: 0 },
        types: { length: 1, 0: "image/tiff" },
      }),
    ).toBe(true);
  });

  it("accepts file payloads exposed only through clipboard types", () => {
    expect(
      hasClipboardImagePayload({
        files: { length: 0 },
        items: { length: 0 },
        types: { length: 1, 0: "Files" },
      }),
    ).toBe(true);
  });

  it("rejects plain text clipboard payloads", () => {
    expect(
      hasClipboardImagePayload({
        files: { length: 0 },
        items: { length: 1, 0: { kind: "string", type: "text/plain" } },
        types: { length: 1, 0: "text/plain" },
      }),
    ).toBe(false);
  });
});
