import { describe, expect, it } from "vitest";

import { summarizeMergeChecks } from "./mergeChecksGate";
import type { PullRequestCheck } from "./types";

function check(partial: Partial<PullRequestCheck>): PullRequestCheck {
  return {
    name: "web",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    started_at: null,
    completed_at: null,
    url: null,
    workflow_name: null,
    ...partial,
  };
}

describe("summarizeMergeChecks", () => {
  it("blocks an empty check list while GitHub still calls the PR unstable", () => {
    expect(summarizeMergeChecks("UNSTABLE", [])).toEqual({
      blocked: true,
      failed: 0,
      pending: 0,
    });
  });

  it("blocks an empty check list while GitHub has no verdict yet", () => {
    expect(summarizeMergeChecks("UNKNOWN", [])).toEqual({
      blocked: true,
      failed: 0,
      pending: 0,
    });
  });

  it("clears a PR no workflow matches", () => {
    expect(summarizeMergeChecks("CLEAN", [])).toEqual({
      blocked: false,
      failed: 0,
      pending: 0,
    });
  });

  it("clears a PR whose checks all passed", () => {
    expect(summarizeMergeChecks("CLEAN", [check({}), check({})])).toEqual({
      blocked: false,
      failed: 0,
      pending: 0,
    });
  });

  it("counts failures and still blocks when GitHub reports clean", () => {
    expect(
      summarizeMergeChecks("CLEAN", [check({ conclusion: "FAILURE" }), check({})]),
    ).toEqual({ blocked: true, failed: 1, pending: 0 });
  });

  it("counts an in-flight check as pending", () => {
    expect(summarizeMergeChecks("UNSTABLE", [check({ status: "IN_PROGRESS" })])).toEqual({
      blocked: true,
      failed: 0,
      pending: 1,
    });
  });

  it("treats a missing verdict as count-only", () => {
    expect(summarizeMergeChecks(null, [])).toEqual({
      blocked: false,
      failed: 0,
      pending: 0,
    });
    expect(summarizeMergeChecks(null, [check({ conclusion: "TIMED_OUT" })])).toEqual({
      blocked: true,
      failed: 1,
      pending: 0,
    });
  });

  it("leaves branch-shaped states to the caller", () => {
    for (const state of ["BEHIND", "DIRTY", "DRAFT", "BLOCKED", "HAS_HOOKS"]) {
      expect(summarizeMergeChecks(state, [check({})]).blocked).toBe(false);
    }
  });
});
