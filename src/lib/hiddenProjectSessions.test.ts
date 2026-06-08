import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIDDEN_PROJECT_SESSIONS_STORAGE_KEY,
  hideProjectSession,
  loadHiddenProjectSessionIds,
  showProjectSession,
  showProjectSessions,
  subscribeHiddenProjectSessions,
} from "./hiddenProjectSessions";

describe("hidden project sessions", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("loads only string ids from persisted storage", () => {
    localStorage.setItem(
      HIDDEN_PROJECT_SESSIONS_STORAGE_KEY,
      JSON.stringify(["s-1", 2, null, "s-2"]),
    );

    expect(Array.from(loadHiddenProjectSessionIds()).sort()).toEqual([
      "s-1",
      "s-2",
    ]);
  });

  it("hides and shows individual sessions", () => {
    hideProjectSession("s-1");
    hideProjectSession("s-2");
    showProjectSession("s-1");

    expect(Array.from(loadHiddenProjectSessionIds())).toEqual(["s-2"]);
  });

  it("shows a batch of sessions", () => {
    hideProjectSession("s-1");
    hideProjectSession("s-2");
    hideProjectSession("s-3");
    showProjectSessions(["s-1", "s-3"]);

    expect(Array.from(loadHiddenProjectSessionIds())).toEqual(["s-2"]);
  });

  it("notifies same-window subscribers when ids change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHiddenProjectSessions(listener);

    hideProjectSession("s-1");
    showProjectSession("s-1");
    unsubscribe();
    hideProjectSession("s-2");

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
