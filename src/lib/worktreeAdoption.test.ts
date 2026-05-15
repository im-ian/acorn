import { describe, expect, it } from "vitest";
import {
  chooseWorktreeToAdoptAfterExit,
  commandRequestsWorktreeAdoption,
  type WorktreeAdoptionIntent,
} from "./worktreeAdoption";

describe("chooseWorktreeToAdoptAfterExit", () => {
  const before = ["/repo/.acorn/worktrees/existing"];
  const after = [
    "/repo/.acorn/worktrees/existing",
    "/repo/.claude/worktrees/fresh",
  ];

  it("does not adopt a repo-global fresh worktree without an explicit intent", () => {
    expect(
      chooseWorktreeToAdoptAfterExit({
        before,
        after,
        intent: { kind: "none" },
      }),
    ).toBeNull();
  });

  it("adopts the fresh worktree only when this spawn cycle requested adoption", () => {
    expect(
      chooseWorktreeToAdoptAfterExit({
        before,
        after,
        intent: { kind: "after-exit" },
      }),
    ).toBe("/repo/.claude/worktrees/fresh");
  });

  it("keeps adoption disabled after the one-shot intent is consumed", () => {
    const consumed: WorktreeAdoptionIntent = { kind: "none" };

    expect(
      chooseWorktreeToAdoptAfterExit({
        before,
        after,
        intent: consumed,
      }),
    ).toBeNull();
  });

  it("adopts a fresh worktree observed as this session's live cwd", () => {
    expect(
      chooseWorktreeToAdoptAfterExit({
        before,
        after,
        intent: { kind: "none" },
        observedLinkedWorktreePath: "/repo/.claude/worktrees/fresh",
      }),
    ).toBe("/repo/.claude/worktrees/fresh");
  });

  it("does not adopt an unobserved fresh worktree", () => {
    expect(
      chooseWorktreeToAdoptAfterExit({
        before,
        after,
        intent: { kind: "none" },
        observedLinkedWorktreePath: "/repo/.claude/worktrees/other",
      }),
    ).toBeNull();
  });
});

describe("commandRequestsWorktreeAdoption", () => {
  it("recognizes explicit claude worktree commands", () => {
    expect(commandRequestsWorktreeAdoption("claude --worktree")).toBe(true);
    expect(commandRequestsWorktreeAdoption("claude -w")).toBe(true);
  });

  it("does not infer adoption from unrelated commands", () => {
    expect(commandRequestsWorktreeAdoption("exit")).toBe(false);
    expect(commandRequestsWorktreeAdoption("git worktree add ../x")).toBe(false);
    expect(commandRequestsWorktreeAdoption("codex -w")).toBe(false);
  });
});
