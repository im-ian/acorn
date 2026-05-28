import { describe, expect, it } from "vitest";
import {
  findConversationPromptTarget,
  scanForContextPrompt,
  type TerminalBufferLike,
} from "./terminalConversation";

type LineInput = string | { text: string; wrapped?: boolean };

function makeBuffer(lines: LineInput[], viewportY = 0): TerminalBufferLike {
  return {
    baseY: Math.max(0, lines.length - 24),
    length: lines.length,
    viewportY,
    getLine(index) {
      const input = lines[index];
      if (input === undefined) return undefined;
      const text = typeof input === "string" ? input : input.text;
      const isWrapped = typeof input === "string" ? false : !!input.wrapped;
      return {
        isWrapped,
        translateToString: () => text,
      };
    },
  };
}

describe("terminal conversation prompt scanning", () => {
  it("scans upward for the prompt currently in viewport context", () => {
    const buf = makeBuffer([
      "shell output",
      "› first prompt",
      "  pasted continuation",
      "● assistant reply",
      "› second prompt",
      { text: "wrapped continuation", wrapped: true },
      "plain reply text",
    ]);

    expect(scanForContextPrompt(buf, 6)).toEqual({
      markerRow: 4,
      prompt: "second prompt\nwrapped continuation",
    });
  });

  it("finds previous and next prompt anchors relative to viewport top", () => {
    const buf = makeBuffer(
      [
        "intro",
        "› first prompt",
        "first answer",
        "› second prompt",
        "second answer",
        "› third prompt",
        "third answer",
      ],
      5,
    );

    expect(findConversationPromptTarget(buf, "previous")).toEqual({
      markerRow: 3,
      prompt: "second prompt",
    });
    expect(findConversationPromptTarget(buf, "next")).toBeNull();
    expect(findConversationPromptTarget(buf, "previous", 7)).toEqual({
      markerRow: 5,
      prompt: "third prompt",
    });
    expect(findConversationPromptTarget(buf, "next", 3)).toEqual({
      markerRow: 5,
      prompt: "third prompt",
    });
  });

  it("treats a prompt at the top as the current anchor", () => {
    const buf = makeBuffer([
      "› first prompt",
      "first answer",
      "› second prompt",
      "second answer",
    ]);

    expect(findConversationPromptTarget(buf, "previous", 2)).toEqual({
      markerRow: 0,
      prompt: "first prompt",
    });
    expect(findConversationPromptTarget(buf, "next", 2)).toBeNull();
  });
});
