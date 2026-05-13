import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
  });
});

describe("sessions AI defaults", () => {
  it("auto-renames AI tabs by default while keeping the setting user-toggleable", () => {
    expect(DEFAULT_SETTINGS.sessions.autoRenameAiTabs).toBe(true);
    expect(DEFAULT_SETTINGS.sessions.includeAiPromptInTabName).toBe(true);
  });
});
