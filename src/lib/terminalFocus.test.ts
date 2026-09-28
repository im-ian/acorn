import { afterEach, describe, expect, it } from "vitest";
import {
  clearTerminalFocus,
  queueTerminalFocus,
  rememberTerminalFocus,
  takeTerminalFocus,
  terminalFocusBlockedByTextEntry,
} from "./terminalFocus";

afterEach(() => {
  clearTerminalFocus("s1");
  clearTerminalFocus("s2");
});

describe("terminalFocusBlockedByTextEntry", () => {
  it("keeps real text fields and yields the xterm helper textarea", () => {
    const input = document.createElement("input");
    const field = document.createElement("textarea");
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");

    expect(terminalFocusBlockedByTextEntry(input)).toBe(true);
    expect(terminalFocusBlockedByTextEntry(field)).toBe(true);
    expect(terminalFocusBlockedByTextEntry(editable)).toBe(true);
    expect(terminalFocusBlockedByTextEntry(helper)).toBe(false);
    expect(terminalFocusBlockedByTextEntry(document.body)).toBe(false);
  });
});

describe("pending terminal focus", () => {
  it("is claimed once by the session that was asked to focus", () => {
    rememberTerminalFocus("s1");
    expect(takeTerminalFocus("s2")).toBe(false);
    expect(takeTerminalFocus("s1")).toBe(true);
    expect(takeTerminalFocus("s1")).toBe(false);
  });

  it("queues the focus event and the pending claim together", async () => {
    const seen: string[] = [];
    const onFocus = (event: Event) => {
      seen.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    };
    window.addEventListener("acorn:focus-session", onFocus);
    try {
      queueTerminalFocus("s1");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(seen).toEqual(["s1"]);
      expect(takeTerminalFocus("s1")).toBe(true);
    } finally {
      window.removeEventListener("acorn:focus-session", onFocus);
    }
  });

  it("does not queue focus while a text field holds the keyboard", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const seen: string[] = [];
    const onFocus = () => {
      seen.push("fired");
    };
    window.addEventListener("acorn:focus-session", onFocus);
    try {
      queueTerminalFocus("s1");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(seen).toEqual([]);
      expect(takeTerminalFocus("s1")).toBe(false);
    } finally {
      window.removeEventListener("acorn:focus-session", onFocus);
      input.remove();
    }
  });
});
