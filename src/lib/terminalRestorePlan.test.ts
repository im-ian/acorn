import { describe, expect, it } from "vitest";
import {
  assumeDaemonAliveForRestore,
  isDaemonEnabledFromStorage,
  planTerminalRestore,
  snapshotKeepsAlternateScreen,
  withoutAltScreenEnterPrefix,
} from "./terminalRestorePlan";

const ALT = "\u001b[?1049h";

describe("snapshotKeepsAlternateScreen", () => {
  it("tracks the last alt-screen private mode", () => {
    expect(snapshotKeepsAlternateScreen("plain")).toBe(false);
    expect(snapshotKeepsAlternateScreen(`${ALT}frame`)).toBe(true);
    expect(snapshotKeepsAlternateScreen(`history${ALT}\u001b[Hframe`)).toBe(
      true,
    );
    expect(snapshotKeepsAlternateScreen(`${ALT}frame\u001b[?1049l`)).toBe(
      false,
    );
    expect(snapshotKeepsAlternateScreen("\u001b[?47h")).toBe(true);
    expect(snapshotKeepsAlternateScreen("\u001b[?1049;1000h")).toBe(true);
  });
});

describe("withoutAltScreenEnterPrefix", () => {
  it("strips only a leading alt-screen enter", () => {
    const enter = (text: string) =>
      Uint8Array.from(text, (char) => char.charCodeAt(0));
    const prefix = enter("\u001b[?1049h");
    const rest = enter("\u001b[?1003hframe");
    const combined = new Uint8Array(prefix.length + rest.length);
    combined.set(prefix);
    combined.set(rest, prefix.length);

    expect(Array.from(withoutAltScreenEnterPrefix(combined))).toEqual(
      Array.from(rest),
    );
    expect(Array.from(withoutAltScreenEnterPrefix(enter("\u001b[?1047h")))).toEqual(
      [],
    );
    expect(Array.from(withoutAltScreenEnterPrefix(enter("\u001b[?47hX")))).toEqual(
      Array.from(enter("X")),
    );
    const mouse = enter("\u001b[?1003h");
    expect(withoutAltScreenEnterPrefix(mouse)).toBe(mouse);
    const wrapped = enter("ready\u001b[?1049h");
    expect(withoutAltScreenEnterPrefix(wrapped)).toBe(wrapped);
  });
});

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
      preserveOverlay: false,
    });
  });

  it("paints a live overlay snapshot instead of replaying the ring", () => {
    expect(
      planTerminalRestore({
        daemonAlive: true,
        handoff: `${ALT}cursor in the prompt`,
        disk: "older disk",
      }),
    ).toEqual({
      snapshot: `${ALT}cursor in the prompt`,
      source: "handoff",
      replayScrollback: false,
      preserveOverlay: true,
    });
    expect(
      planTerminalRestore({
        daemonAlive: true,
        handoff: null,
        disk: `scrollback${ALT}still in the tui`,
      }),
    ).toEqual({
      snapshot: `scrollback${ALT}still in the tui`,
      source: "disk",
      replayScrollback: false,
      preserveOverlay: true,
    });
  });

  it("prefers a newer normal-buffer handoff over an alt-screen disk snapshot", () => {
    expect(
      planTerminalRestore({
        daemonAlive: true,
        handoff: "back at the shell",
        disk: `${ALT}old tui`,
      }),
    ).toEqual({
      snapshot: null,
      source: null,
      replayScrollback: true,
      preserveOverlay: false,
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
      preserveOverlay: false,
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
      preserveOverlay: false,
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
      preserveOverlay: false,
    });
  });

  it("treats a failed daemon list as alive when the daemon is enabled", () => {
    expect(
      assumeDaemonAliveForRestore({
        listedAlive: false,
        listFailed: true,
        daemonEnabled: true,
      }),
    ).toBe(true);
    expect(
      assumeDaemonAliveForRestore({
        listedAlive: false,
        listFailed: true,
        daemonEnabled: false,
      }),
    ).toBe(false);
    expect(
      assumeDaemonAliveForRestore({
        listedAlive: true,
        listFailed: false,
        daemonEnabled: true,
      }),
    ).toBe(true);
  });

  it("treats a missing daemon killswitch as enabled", () => {
    expect(isDaemonEnabledFromStorage(() => null)).toBe(true);
    expect(isDaemonEnabledFromStorage(() => "false")).toBe(false);
    expect(isDaemonEnabledFromStorage(() => "true")).toBe(true);
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
      preserveOverlay: false,
    });
  });
});
