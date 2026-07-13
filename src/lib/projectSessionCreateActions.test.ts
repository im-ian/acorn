import { describe, expect, it } from "vitest";
import { PROJECT_SESSION_CREATE_ACTIONS } from "./projectSessionCreateActions";

describe("PROJECT_SESSION_CREATE_ACTIONS", () => {
  it("maps session actions to their configurable hotkeys", () => {
    expect(
      Object.fromEntries(
        PROJECT_SESSION_CREATE_ACTIONS.map((action) => [
          action.id,
          action.hotkeyId,
        ]),
      ),
    ).toEqual({
      terminal: "newSession",
      isolated: "newIsolatedSession",
      chat: undefined,
      control: "newControlSession",
    });
  });
});
