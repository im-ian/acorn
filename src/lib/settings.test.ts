import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
  });
});
