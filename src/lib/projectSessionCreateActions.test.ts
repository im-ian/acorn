import { describe, expect, it } from "vitest";
import {
  PROJECT_SESSION_CREATE_ACTIONS,
  PROJECT_SESSION_CREATE_MENU,
} from "./projectSessionCreateActions";

describe("project session create actions", () => {
  it("exposes regular, isolated, chat, and control actions for the project dropdown", () => {
    expect(PROJECT_SESSION_CREATE_ACTIONS.map((action) => action.id)).toEqual([
      "terminal",
      "isolated",
      "chat",
      "control",
    ]);
  });

  it("maps the chat action to a regular chat-mode session", () => {
    expect(
      PROJECT_SESSION_CREATE_ACTIONS.find((action) => action.id === "chat"),
    ).toMatchObject({
      isolated: false,
      kind: "regular",
      mode: "chat",
    });
  });

  it("groups control after a separator in the create menu", () => {
    expect(
      PROJECT_SESSION_CREATE_MENU.map((item) =>
        item.type === "separator" ? "separator" : item.action.id,
      ),
    ).toEqual(["terminal", "isolated", "chat", "separator", "control"]);
  });
});
