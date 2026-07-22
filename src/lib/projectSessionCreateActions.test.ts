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
      goal: undefined,
      terminal: "newSession",
      isolated: "newIsolatedSession",
      chat: undefined,
      control: "newControlSession",
    });
  });

  it("keeps Goal as a configured dialog flow", () => {
    expect(PROJECT_SESSION_CREATE_ACTIONS[0]).toMatchObject({
      id: "goal",
      flow: "goal",
      labelKey: "sidebar.actions.newAutonomousGoalSession",
    });
    expect(
      PROJECT_SESSION_CREATE_ACTIONS.filter(
        (action) => action.flow === "direct",
      ),
    ).toHaveLength(4);
  });
});
