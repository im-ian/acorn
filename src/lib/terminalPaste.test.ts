import { describe, expect, it } from "vitest";
import {
  AGENT_IMAGE_PASTE_CONTROL,
  hasClipboardFilePayload,
  terminalPasteAction,
} from "./terminalPaste";

describe("terminalPasteAction", () => {
  it("routes image-only paste to the agent Ctrl+V image attachment path", () => {
    expect(
      terminalPasteAction({
        text: "",
        hasFilePayload: true,
        imagePasteShortcutActive: true,
      }),
    ).toEqual({ kind: "send", data: AGENT_IMAGE_PASTE_CONTROL });
  });

  it("keeps non-agent image-only paste on the native path", () => {
    expect(
      terminalPasteAction({
        text: "",
        hasFilePayload: true,
        imagePasteShortcutActive: false,
      }),
    ).toEqual({ kind: "native" });
  });

  it("pastes text through xterm even when files are also present", () => {
    expect(
      terminalPasteAction({
        text: "hello",
        hasFilePayload: true,
        imagePasteShortcutActive: true,
      }),
    ).toEqual({ kind: "pasteText", text: "hello" });
  });
});

describe("hasClipboardFilePayload", () => {
  it("accepts file payloads exposed through files", () => {
    expect(hasClipboardFilePayload({ files: { length: 1 } })).toBe(true);
  });

  it("accepts image payloads exposed only through clipboard items", () => {
    expect(
      hasClipboardFilePayload({
        files: { length: 0 },
        items: { length: 1, 0: { kind: "string", type: "image/png" } },
      }),
    ).toBe(true);
  });

  it("accepts image payloads exposed only through clipboard types", () => {
    expect(
      hasClipboardFilePayload({
        files: { length: 0 },
        items: { length: 0 },
        types: { length: 1, 0: "image/tiff" },
      }),
    ).toBe(true);
  });

  it("rejects plain text clipboard payloads", () => {
    expect(
      hasClipboardFilePayload({
        files: { length: 0 },
        items: { length: 1, 0: { kind: "string", type: "text/plain" } },
        types: { length: 1, 0: "text/plain" },
      }),
    ).toBe(false);
  });
});
