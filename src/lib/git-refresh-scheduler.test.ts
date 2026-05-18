import { describe, expect, it } from "vitest";
import { planGitRefresh, type GitRefreshInput } from "./git-refresh-scheduler";

const base: GitRefreshInput = {
  now: 10_000,
  lastSuccessAt: null,
  inFlight: false,
  focused: true,
  huge: false,
  trigger: "fs-event",
  dotgitChanged: false,
  hasWorkingTreeChange: true,
};

describe("planGitRefresh", () => {
  it("on first mount runs immediately", () => {
    expect(planGitRefresh({ ...base, trigger: "mount", lastSuccessAt: null })).toEqual({
      action: "run",
      debounceMs: 0,
    });
  });

  it("queues for focus when window unfocused", () => {
    expect(planGitRefresh({ ...base, focused: false })).toEqual({
      action: "defer-until-focus",
    });
  });

  it("skips when in-flight", () => {
    expect(planGitRefresh({ ...base, inFlight: true })).toEqual({
      action: "coalesce-with-inflight",
    });
  });

  it("debounces 1000ms for ordinary fs events", () => {
    expect(planGitRefresh({ ...base, lastSuccessAt: 5_000 })).toEqual({
      action: "run",
      debounceMs: 1000,
    });
  });

  it("respects 5s quiet window after last success", () => {
    expect(planGitRefresh({ ...base, lastSuccessAt: 8_500, now: 10_000 })).toEqual({
      action: "defer",
      waitMs: 3500,
    });
  });

  it("runs on dotgit_changed even inside quiet window when wait would be short", () => {
    // elapsed = 4500 → remaining = 500 ≤ debounce floor (1000ms) → just run.
    expect(
      planGitRefresh({
        ...base,
        dotgitChanged: true,
        lastSuccessAt: 5_500,
        now: 10_000,
      }),
    ).toEqual({ action: "run", debounceMs: 1000 });
  });

  it("skips fs-event triggers when huge=true", () => {
    expect(planGitRefresh({ ...base, huge: true })).toEqual({ action: "skip-huge" });
  });

  it("still runs huge repo on explicit user trigger", () => {
    expect(planGitRefresh({ ...base, huge: true, trigger: "user" })).toEqual({
      action: "run",
      debounceMs: 0,
    });
  });

  it("skips when no working-tree change and no dotgit change", () => {
    expect(
      planGitRefresh({
        ...base,
        hasWorkingTreeChange: false,
        dotgitChanged: false,
      }),
    ).toEqual({ action: "skip-nothing-changed" });
  });
});
