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

  it("returns claude with no args for agent mode + claude selected", () => {
    expect(
      resolveStartupCommand({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, selected: "claude" },
        sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, mode: "agent" },
      }),
    ).toEqual({
      command: "claude",
      args: [],
    });
  });

  it("returns gemini with no args for agent mode + gemini selected", () => {
    expect(
      resolveStartupCommand({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, selected: "gemini" },
        sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, mode: "agent" },
      }),
    ).toEqual({
      command: "gemini",
      args: [],
    });
  });

  it("falls back to llama3 for ollama agent with blank model", () => {
    expect(
      resolveStartupCommand({
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          selected: "ollama",
          ollama: { model: "" },
        },
        sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, mode: "agent" },
      }),
    ).toEqual({ command: "ollama", args: ["run", "llama3"] });
  });

  it("uses configured ollama model when set", () => {
    expect(
      resolveStartupCommand({
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          selected: "ollama",
          ollama: { model: "llama3:8b" },
        },
        sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, mode: "agent" },
      }),
    ).toEqual({ command: "ollama", args: ["run", "llama3:8b"] });
  });

  it("agent mode + custom selected uses agents.customCommand", () => {
    expect(
      resolveStartupCommand({
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          selected: "custom",
          customCommand: "codex --reply",
        },
        sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, mode: "agent" },
      }),
    ).toEqual({ command: "codex", args: ["--reply"] });
  });

  it("agent mode + custom selected with blank command falls back to claude", () => {
    expect(
      resolveStartupCommand({
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          selected: "custom",
          customCommand: "",
        },
        sessionStartup: { ...DEFAULT_SETTINGS.sessionStartup, mode: "agent" },
      }),
    ).toEqual({ command: "claude", args: [] });
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

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
  });
});
