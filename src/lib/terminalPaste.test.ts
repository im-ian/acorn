import { describe, expect, it } from "vitest";
import {
  AGENT_IMAGE_PASTE_CONTROL,
  getClipboardImageFile,
  hasClipboardImagePayload,
  isTerminalProtocolReply,
  terminalPasteAction,
  type ClipboardImageFile,
} from "./terminalPaste";

it("keeps agent image paste fallback wired to Ctrl+V", () => {
  expect(AGENT_IMAGE_PASTE_CONTROL).toBe("\x16");
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

  it("keeps empty unknown paste on the native path", () => {
    expect(
      terminalPasteAction({
        text: "",
        hasImagePayload: false,
      }),
    ).toEqual({ kind: "native" });
  });

  it("pastes text through xterm even when files are also present", () => {
    expect(
      terminalPasteAction({
        text: "hello",
        hasImagePayload: true,
      }),
    ).toEqual({ kind: "pasteText", text: "hello" });
  });

  it("normalizes Unicode shell separators in pasted text", () => {
    expect(
      terminalPasteAction({
        text: "pnpm\u00a0run\u202fdev",
        hasImagePayload: false,
      }),
    ).toEqual({ kind: "pasteText", text: "pnpm run dev" });
  });

  it("preserves Unicode shell separators when normalization is disabled", () => {
    expect(
      terminalPasteAction({
        text: "pnpm\u00a0run\u202fdev",
        hasImagePayload: false,
        normalizeUnicodeSpaces: false,
      }),
    ).toEqual({ kind: "pasteText", text: "pnpm\u00a0run\u202fdev" });
  });
});

describe("isTerminalProtocolReply", () => {
  it.each([
    ["SGR mouse motion report", "\x1b[<35;55;34M"],
    ["SGR wheel report", "\x1b[<65;55;34M"],
    ["SGR button release report", "\x1b[<0;27;40m"],
    ["concatenated SGR reports", "\x1b[<35;1;1M\x1b[<35;2;1M"],
    ["legacy X10 mouse report", "\x1b[M @B"],
    ["focus in", "\x1b[I"],
    ["focus out", "\x1b[O"],
    ["OSC color query response (ST)", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\"],
    ["OSC color query response (BEL)", "\x1b]11;rgb:0000/0000/0000\x07"],
    ["primary DA response", "\x1b[?1;2c"],
    ["secondary DA response", "\x1b[>0;276;0c"],
    ["DECRPM response", "\x1b[?2026;2$y"],
    ["cursor position report", "\x1b[24;80R"],
  ])("treats %s as protocol chatter", (_label, data) => {
    expect(isTerminalProtocolReply(data)).toBe(true);
  });

  it.each([
    ["plain text", "a"],
    ["enter", "\r"],
    ["ctrl+c", "\x03"],
    ["arrow key", "\x1b[A"],
    ["bracketed paste", "\x1b[200~hello\x1b[201~"],
    ["mouse report followed by typed text", "\x1b[<35;1;1Mhello"],
    ["empty string", ""],
  ])("keeps %s counted as user input", (_label, data) => {
    expect(isTerminalProtocolReply(data)).toBe(false);
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
