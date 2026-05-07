import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveStartupCommand, type AcornSettings } from "./settings";

function withStartup(
  patch: Partial<AcornSettings["sessionStartup"]>,
): AcornSettings {
  return {
    ...DEFAULT_SETTINGS,
    sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, ...patch },
  };
}

describe("resolveStartupCommand", () => {
  it("returns claude with no args for the default `claude` mode", () => {
    expect(resolveStartupCommand(DEFAULT_SETTINGS)).toEqual({
      command: "claude",
      args: [],
    });
  });

  it("returns empty command for `terminal` mode (Rust falls back to $SHELL)", () => {
    expect(resolveStartupCommand(withStartup({ mode: "terminal" }))).toEqual({
      command: "",
      args: [],
    });
  });

  it("falls back to claude when custom command is blank", () => {
    expect(
      resolveStartupCommand(withStartup({ mode: "custom", customCommand: "" })),
    ).toEqual({ command: "claude", args: [] });
  });

  it("falls back to claude when custom command is whitespace only", () => {
    expect(
      resolveStartupCommand(
        withStartup({ mode: "custom", customCommand: "   \t  " }),
      ),
    ).toEqual({ command: "claude", args: [] });
  });

  it("tokenises a custom command on whitespace", () => {
    expect(
      resolveStartupCommand(
        withStartup({ mode: "custom", customCommand: "code --wait ." }),
      ),
    ).toEqual({ command: "code", args: ["--wait", "."] });
  });

  it("collapses consecutive whitespace when tokenising", () => {
    expect(
      resolveStartupCommand(
        withStartup({ mode: "custom", customCommand: "bash   -lc   echo" }),
      ),
    ).toEqual({ command: "bash", args: ["-lc", "echo"] });
  });
});
