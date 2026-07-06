import { describe, expect, it } from "vitest";
import { planTerminalRestore } from "./terminalRestorePlan";

describe("terminal restore plan", () => {
  it("uses daemon replay when the daemon session is alive", () => {
    expect(
      planTerminalRestore({
        daemonAlive: true,
        handoff: "latest handoff",
        disk: "older disk",
      }),
    ).toEqual({
      snapshot: null,
      source: null,
      replayScrollback: true,
    });
  });

  it("skips disk restore for alive daemon sessions", () => {
    expect(
      planTerminalRestore({
        daemonAlive: true,
        handoff: null,
        disk: "older disk",
      }),
    ).toEqual({
      snapshot: null,
      source: null,
      replayScrollback: true,
    });
  });

  it("uses resident handoff for non-live daemon sessions before disk", () => {
    expect(
      planTerminalRestore({
        daemonAlive: false,
        handoff: "latest handoff",
        disk: "saved disk",
      }),
    ).toEqual({
      snapshot: "latest handoff",
      source: "handoff",
      replayScrollback: false,
    });
  });

  it("uses disk restore for non-live daemon sessions without handoff", () => {
    expect(
      planTerminalRestore({
        daemonAlive: false,
        handoff: null,
        disk: "saved disk",
      }),
    ).toEqual({
      snapshot: "saved disk",
      source: "disk",
      replayScrollback: false,
    });
  });

  it("uses daemon replay when no local snapshot is restored", () => {
    expect(
      planTerminalRestore({
        daemonAlive: false,
        handoff: null,
        disk: null,
      }),
    ).toEqual({
      snapshot: null,
      source: null,
      replayScrollback: true,
    });
  });
});
