import { describe, expect, it } from "vitest";
import {
  clearRememberedTerminalScrollback,
  rememberedTerminalScrollback,
  rememberTerminalScrollback,
} from "./terminalScrollbackHandoff";

describe("terminal scrollback handoff", () => {
  it("keeps the latest non-empty serialized scrollback in memory", () => {
    clearRememberedTerminalScrollback("s1");

    const saved = rememberTerminalScrollback("s1", "before\nlatest\n");

    expect(saved).toBe("before\nlatest\n");
    expect(rememberedTerminalScrollback("s1")).toBe("before\nlatest\n");
  });

  it("drops empty or prompt-only snapshots", () => {
    rememberTerminalScrollback("s2", "real output\n");

    const saved = rememberTerminalScrollback("s2", "% ");

    expect(saved).toBe("");
    expect(rememberedTerminalScrollback("s2")).toBeNull();
  });

  it("clears snapshots by session id", () => {
    rememberTerminalScrollback("s3", "kept\n");
    clearRememberedTerminalScrollback("s3");

    expect(rememberedTerminalScrollback("s3")).toBeNull();
  });
});
