import { describe, expect, it } from "vitest";
import {
  shouldRepaintTerminalForStatusTransition,
  shouldRepaintTerminalForTranscriptAdvance,
} from "./terminalAttentionRepaint";
import type { SessionStatus } from "./types";

describe("shouldRepaintTerminalForStatusTransition", () => {
  it.each<SessionStatus>(["needs_input", "failed", "completed"])(
    "repaints when a running session transitions to %s",
    (next) => {
      expect(shouldRepaintTerminalForStatusTransition("running", next)).toBe(
        true,
      );
    },
  );

  it("does not repaint repeated attention states", () => {
    expect(
      shouldRepaintTerminalForStatusTransition("needs_input", "needs_input"),
    ).toBe(false);
  });

  it("does not repaint on startup or non-attention transitions", () => {
    expect(shouldRepaintTerminalForStatusTransition(null, "needs_input")).toBe(
      false,
    );
    expect(shouldRepaintTerminalForStatusTransition("idle", "running")).toBe(
      false,
    );
  });
});

describe("shouldRepaintTerminalForTranscriptAdvance", () => {
  it("repaints only when the active terminal owns the advanced transcript", () => {
    expect(
      shouldRepaintTerminalForTranscriptAdvance({
        activeSessionId: "session-a",
        eventSessionId: "session-a",
        isActive: true,
      }),
    ).toBe(true);

    expect(
      shouldRepaintTerminalForTranscriptAdvance({
        activeSessionId: "session-a",
        eventSessionId: "session-b",
        isActive: true,
      }),
    ).toBe(false);

    expect(
      shouldRepaintTerminalForTranscriptAdvance({
        activeSessionId: "session-a",
        eventSessionId: "session-a",
        isActive: false,
      }),
    ).toBe(false);
  });
});
