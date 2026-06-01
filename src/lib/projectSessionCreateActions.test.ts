import { describe, expect, it } from "vitest";
import { PROJECT_SESSION_CREATE_ACTIONS } from "./projectSessionCreateActions";

describe("project session create actions", () => {
  it("exposes terminal, isolated, control, and chat actions for the project dropdown", () => {
    expect(PROJECT_SESSION_CREATE_ACTIONS.map((action) => action.id)).toEqual([
      "terminal",
      "isolated",
      "control",
      "chat",
    ]);
  });

  it("maps the chat action to a regular chat-mode session", () => {
    expect(PROJECT_SESSION_CREATE_ACTIONS.find((action) => action.id === "chat")).toMatchObject({
      isolated: false,
      kind: "regular",
      mode: "chat",
    });
  });
});
