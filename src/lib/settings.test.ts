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
  it("returns empty command for the default `terminal` mode (Rust falls back to $SHELL)", () => {
    expect(resolveStartupCommand(DEFAULT_SETTINGS)).toEqual({
      command: "",
      args: [],
    });
  });

  it("returns claude with no args for `claude` mode", () => {
    expect(resolveStartupCommand(withStartup({ mode: "claude" }))).toEqual({
      command: "claude",
      args: [],
    });
  });

  it("falls back to $SHELL (empty command) when custom command is blank", () => {
    expect(
      resolveStartupCommand(withStartup({ mode: "custom", customCommand: "" })),
    ).toEqual({ command: "", args: [] });
  });

  it("falls back to $SHELL (empty command) when custom command is whitespace only", () => {
    expect(
      resolveStartupCommand(
        withStartup({ mode: "custom", customCommand: "   \t  " }),
      ),
    ).toEqual({ command: "", args: [] });
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
