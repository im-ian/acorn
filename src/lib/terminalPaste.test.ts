import { describe, expect, it } from "vitest";
import {
  CODEX_IMAGE_PASTE_CONTROL,
  terminalPasteAction,
} from "./terminalPaste";

describe("terminalPasteAction", () => {
  it("routes image-only paste to Codex's Ctrl+V image attachment path", () => {
    expect(
      terminalPasteAction({
        text: "",
        fileCount: 1,
        codexActive: true,
      }),
    ).toEqual({ kind: "send", data: CODEX_IMAGE_PASTE_CONTROL });
  });

  it("keeps non-Codex image-only paste on the native path", () => {
    expect(
      terminalPasteAction({
        text: "",
        fileCount: 1,
        codexActive: false,
      }),
    ).toEqual({ kind: "native" });
  });

  it("pastes text through xterm even when files are also present", () => {
    expect(
      terminalPasteAction({
        text: "hello",
        fileCount: 1,
        codexActive: true,
      }),
    ).toEqual({ kind: "pasteText", text: "hello" });
  });
});
