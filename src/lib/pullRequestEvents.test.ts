import { describe, expect, it, vi } from "vitest";
import {
  emitPullRequestMutation,
  onPullRequestMutation,
  pullRequestMutationAffectsOpenContext,
  type PullRequestMutationEvent,
} from "./pullRequestEvents";

describe("pullRequestEvents", () => {
  it("notifies subscribers and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onPullRequestMutation(listener);
    const event: PullRequestMutationEvent = {
      kind: "merged",
      repoPath: "/tmp/acorn",
      number: 42,
      headBranch: "feature",
    };

    emitPullRequestMutation(event);
    unsubscribe();
    emitPullRequestMutation({ ...event, number: 43 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("classifies lifecycle and metadata changes that can stale open PR context", () => {
    expect(pullRequestMutationAffectsOpenContext("merged")).toBe(true);
    expect(pullRequestMutationAffectsOpenContext("closed")).toBe(true);
    expect(pullRequestMutationAffectsOpenContext("reopened")).toBe(true);
    expect(pullRequestMutationAffectsOpenContext("draft_changed")).toBe(true);
    expect(pullRequestMutationAffectsOpenContext("edited")).toBe(true);
    expect(pullRequestMutationAffectsOpenContext("checks_changed")).toBe(true);
    expect(pullRequestMutationAffectsOpenContext("commented")).toBe(false);
  });
});
