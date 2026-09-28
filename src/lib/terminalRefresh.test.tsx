import { afterEach, describe, expect, it } from "vitest";
import {
  clearRememberedTerminalScrollback,
  rememberTerminalScrollback,
  rememberedTerminalScrollback,
} from "./terminalScrollbackHandoff";
import {
  requestTerminalRefresh,
  terminalRefreshMenuItem,
  terminalRefreshRedraw,
  terminalRefreshRestoreSequence,
  TERMINAL_REFRESH_EVENT,
  type TerminalRefreshModes,
} from "./terminalRefresh";

afterEach(() => {
  clearRememberedTerminalScrollback("session-1");
});

const shellModes: TerminalRefreshModes = {
  alternateScreen: false,
  applicationCursorKeysMode: false,
  applicationKeypadMode: false,
  bracketedPasteMode: true,
  mouseTrackingMode: "none",
  mouseEncoding: "DEFAULT",
};

describe("terminalRefreshRedraw", () => {
  it("redraws a shell with form-feed", () => {
    expect(
      terminalRefreshRedraw({
        buffer: { active: { type: "normal" } },
        modes: { mouseTrackingMode: "none" },
      }),
    ).toBe("form-feed");
  });

  it("redraws a TUI with SIGWINCH instead of a keystroke", () => {
    expect(
      terminalRefreshRedraw({
        buffer: { active: { type: "alternate" } },
        modes: { mouseTrackingMode: "none" },
      }),
    ).toBe("sigwinch");
    expect(
      terminalRefreshRedraw({
        buffer: { active: { type: "normal" } },
        modes: { mouseTrackingMode: "vt200" },
      }),
    ).toBe("sigwinch");
  });
});

describe("terminalRefreshRestoreSequence", () => {
  it("puts a TUI back on the alternate screen with the modes it already set", () => {
    expect(
      terminalRefreshRestoreSequence({
        alternateScreen: true,
        applicationCursorKeysMode: true,
        applicationKeypadMode: true,
        bracketedPasteMode: true,
        mouseTrackingMode: "any",
        mouseEncoding: "SGR",
      }),
    ).toBe(
      "\x1b[?1049h\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?1003h\x1b[?1006h",
    );
  });

  it("keeps a shell prompt's bracketed paste without entering the alt screen", () => {
    expect(terminalRefreshRestoreSequence(shellModes)).toBe("\x1b[?2004h");
  });
});

describe("requestTerminalRefresh", () => {
  it("does not drop the saved screen when no terminal is mounted", () => {
    rememberTerminalScrollback("session-1", "corrupt screen");

    requestTerminalRefresh("session-1");

    expect(rememberedTerminalScrollback("session-1")).toBe("corrupt screen");
  });

  it("lets a mounted terminal own the reset", () => {
    const claimed: string[] = [];
    const onRefresh = (event: Event) => {
      claimed.push(
        (event as CustomEvent<{ sessionId: string }>).detail.sessionId,
      );
      event.preventDefault();
    };
    window.addEventListener(TERMINAL_REFRESH_EVENT, onRefresh);
    try {
      requestTerminalRefresh("session-1");
    } finally {
      window.removeEventListener(TERMINAL_REFRESH_EVENT, onRefresh);
    }

    expect(claimed).toEqual(["session-1"]);
  });
});

describe("terminalRefreshMenuItem", () => {
  it("requests a refresh for that session only", () => {
    const claimed: string[] = [];
    const onRefresh = (event: Event) => {
      claimed.push(
        (event as CustomEvent<{ sessionId: string }>).detail.sessionId,
      );
    };
    window.addEventListener(TERMINAL_REFRESH_EVENT, onRefresh);
    try {
      const item = terminalRefreshMenuItem("Refresh Terminal", "session-1");
      if (!("onClick" in item)) throw new Error("expected a button item");
      item.onClick();
    } finally {
      window.removeEventListener(TERMINAL_REFRESH_EVENT, onRefresh);
    }

    expect(claimed).toEqual(["session-1"]);
  });
});
