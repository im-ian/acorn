import { test, expect, pressHotkey } from "./support";

// Right panel needs an active project + session for the tabs to actually
// render their content. Without that, every tab falls back to "No project
// selected" which trivially passes for any tab assertion.
async function seedActiveSession(
  tauri: { handle: (cmd: string, fn: (args: unknown) => unknown) => Promise<void> },
) {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => [
    {
      id: "s-1",
      name: "sess",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
}

async function seedActiveWorktreeSession(
  tauri: { handle: (cmd: string, fn: (args: unknown) => unknown) => Promise<void> },
) {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => [
    {
      id: "s-1",
      name: "sess",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo/.acorn/worktrees/demo-1",
      branch: "main",
      isolated: true,
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
}

test.describe("right panel: tab switching", () => {
  test("each tab shows its own empty placeholder when seeded with a project", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);

    await page.goto("/");

    // Default tab is Commits — placeholder is "Select a commit to see diff".
    await expect(page.getByText(/Select a commit to see diff/i)).toBeVisible();

    await page.getByRole("button", { name: "Staged" }).click();
    await expect(
      page.getByText(/No staged or modified files/i),
    ).toBeVisible();

    // PRs lives under the GitHub group — switch group first, then sub-tab.
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();
    // PR tab: when remote isn't GitHub OR list is empty, one of these shows.
    // Mock returns an empty list so the empty-list copy wins.
    await expect(page.getByText(/No .* pull requests/i)).toBeVisible();

    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Commits" }).click();
    await expect(page.getByText(/Select a commit to see diff/i)).toBeVisible();
  });

  test("hotkey $mod+Shift+S routes to Staged tab", async ({ page, tauri }) => {
    await seedActiveSession(tauri);

    await page.goto("/");
    // Verify we're not already on Staged.
    await expect(page.getByText(/Select a commit to see diff/i)).toBeVisible();

    await pressHotkey(page, { mod: true, shift: true, key: "S" });

    // After the hotkey, Staged tab content should render.
    await expect(
      page.getByText(/No staged or modified files/i),
    ).toBeVisible();
  });

  test("null read_session_todos does not crash the panel (regression)", async ({
    page,
    tauri,
  }) => {
    // Defensive guard added in src/components/RightPanel.tsx — without it,
    // a null response from read_session_todos crashed `todos.length` and
    // brought down the whole RightPanel via React's error boundary. The
    // global errorTracker fixture asserts no unexpected page errors leaked
    // during this test, so the regression check is implicit.
    await seedActiveSession(tauri);
    await tauri.handle("read_session_todos", () => null);

    await page.goto("/");
    await page.getByRole("button", { name: /^sess main · Idle$/ }).click();
    // Give the polling loop a tick to fetch and apply the null response.
    await expect(page.getByText(/Select a commit to see diff/i)).toBeVisible();
  });

  test("loadMore from previous project does not leak after switch (regression)", async ({
    page,
    tauri,
  }) => {
    // Cross-project leak: CommitsTab.loadMore() has no cancellation guard —
    // if the user scroll-triggers loadMore in project A, then switches to B
    // before the page resolves, project A's commits get appended onto B's
    // list via `setCommits(prev => [...prev, ...page])`. The per-repoPath
    // remount (key={repoPath}) unmounts A's component so its setter no
    // longer reaches the live tree.
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/repo-a",
        name: "repo-a",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
      {
        repo_path: "/tmp/repo-b",
        name: "repo-b",
        created_at: "2026-01-01T00:00:00Z",
        position: 1,
      },
    ]);
    await tauri.handle("list_sessions", () => [
      {
        id: "s-a",
        name: "sess-a",
        repo_path: "/tmp/repo-a",
        worktree_path: "/tmp/repo-a",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "s-b",
        name: "sess-b",
        repo_path: "/tmp/repo-b",
        worktree_path: "/tmp/repo-b",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    // list_commits: page 0 returns 50 commits per repo (so hasMore=true and
    // loadMore can be triggered). Page 1 (offset=50) for repo A is delayed
    // so its resolve races the project switch.
    await tauri.handle("list_commits", (args) => {
      const a = args as { repoPath: string; offset: number; limit: number };
      const isA = a.repoPath.endsWith("repo-a");
      const tag = isA ? "AAA" : "BBB";
      // Trace each call so the test can wait until A's loadMore was issued.
      const w = window as unknown as {
        __listCommitsCalls?: { repoPath: string; offset: number }[];
      };
      w.__listCommitsCalls = w.__listCommitsCalls ?? [];
      w.__listCommitsCalls.push({ repoPath: a.repoPath, offset: a.offset });
      const page0 = Array.from({ length: 50 }, (_, i) => ({
        sha: tag + String(i).padStart(16, "0"),
        short_sha: tag.toLowerCase() + String(i).padStart(4, "0"),
        author: tag + " author",
        summary: "p0 " + tag + " #" + i,
        timestamp: 1700000000 - i,
        pushed: true,
      }));
      const page1 = [
        {
          sha: tag + "PAGE1XXXXXXXXXXX",
          short_sha: tag.toLowerCase() + "p1",
          author: tag + " author",
          summary: "leak-marker-" + tag,
          timestamp: 1699000000,
          pushed: true,
        },
      ];
      const data = a.offset === 0 ? page0 : page1;
      const delayMs = isA && a.offset > 0 ? 700 : 0;
      return new Promise((resolve) => {
        setTimeout(() => resolve(data), delayMs);
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /^sess-a main · Idle$/ }).click();
    // Wait for A's first page to render.
    await expect(page.getByText("p0 AAA #0")).toBeVisible();
    // Trigger loadMore by scrolling the commits panel to the bottom — the
    // virtualizer's `lastItem.index >= commits.length - 1` check fires the
    // page-1 fetch, which is delayed for repo A.
    await page.evaluate(() => {
      const scrollers = document.querySelectorAll(".overflow-y-auto");
      scrollers.forEach((s) => {
        (s as HTMLElement).scrollTop = (s as HTMLElement).scrollHeight;
      });
    });
    // Confirm A's page-1 fetch was actually issued before we switch.
    await page.waitForFunction(() => {
      const w = window as unknown as {
        __listCommitsCalls?: { repoPath: string; offset: number }[];
      };
      return (w.__listCommitsCalls ?? []).some(
        (c) => c.repoPath.endsWith("repo-a") && c.offset > 0,
      );
    });
    // Switch to project B before A's page-1 resolves.
    await page.getByRole("button", { name: /^sess-b main · Idle$/ }).click();
    // Wait for B's first page to render — confirms switch landed.
    await expect(page.getByText("p0 BBB #0")).toBeVisible();
    // Give A's delayed page-1 plenty of time to resolve.
    await page.waitForTimeout(1200);
    // Scroll B to the bottom so any virtualized rows (including a leaked
    // AAA row appended via setCommits) become visible to the assertion.
    await page.evaluate(() => {
      const scrollers = document.querySelectorAll(".overflow-y-auto");
      scrollers.forEach((s) => {
        (s as HTMLElement).scrollTop = (s as HTMLElement).scrollHeight;
      });
    });
    // Regression: A's page-1 marker must never appear in B's panel.
    await expect(page.getByText(/leak-marker-AAA/)).toHaveCount(0);
  });
});

test.describe("right panel: groups", () => {
  test("group buttons restore each group's last sub-tab", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    // GitHub group is visible by default in the mock; align Actions so its
    // empty-state copy matches "ok with no items" rather than "not GitHub".
    await tauri.handle("list_workflow_runs", () => ({
      kind: "ok",
      items: [],
      account: "test-account",
    }));
    await page.goto("/");

    // Pick a non-default sub-tab inside Code so we can prove it's remembered.
    await page.getByRole("button", { name: "Staged" }).click();
    await expect(page.getByText(/No staged or modified files/i)).toBeVisible();

    // Hop to GitHub → land on its default sub-tab (PRs).
    await page.getByRole("button", { name: "GitHub" }).click();
    await expect(page.getByText(/No .* pull requests/i)).toBeVisible();
    // Switch to the other GitHub sub-tab.
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByText(/No workflow runs yet/i)).toBeVisible();

    // Hop back to Code — Staged should be restored, not Commits.
    await page.getByRole("button", { name: "Code" }).click();
    await expect(page.getByText(/No staged or modified files/i)).toBeVisible();

    // Hop back to GitHub — Actions should be restored, not PRs.
    await page.getByRole("button", { name: "GitHub" }).click();
    await expect(page.getByText(/No workflow runs yet/i)).toBeVisible();
  });

  test("GitHub group is hidden when origin is not GitHub", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    // Override the default mock so the probe reports "not GitHub".
    await tauri.handle("github_origin_slug", () => null);

    await page.goto("/");

    // Code group is always there; Agents group is too. GitHub must be gone.
    await expect(page.getByRole("button", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Files", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Staged" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Commits" })).toBeVisible();
    await expect(page.getByRole("button", { name: "GitHub" })).toHaveCount(0);
  });

  test("git-backed tabs are hidden when project is not a git repository", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.handle("is_git_repository", () => false);

    await page.goto("/");

    await expect(page.getByRole("button", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Files", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Staged" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Commits" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "GitHub" })).toHaveCount(0);
  });

  test("History sub-tab is labeled 'History' (renamed from 'Sessions')", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await page.goto("/");

    await page.getByRole("button", { name: "Agents" }).click();
    // The right-panel sub-tab bar surfaces History; scope to it so we don't
    // collide with the sidebar's session list which previously used the
    // "Sessions" label.
    await expect(
      page.getByRole("button", { name: "History" }),
    ).toBeVisible();
  });

  test("History rows surface linked worktree names", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.handle("list_agent_history", () => [
      {
        provider: "claude",
        id: "claude-1",
        title: "Investigate resume flow",
        preview: null,
        cwd: "/tmp/demo/.claude/worktrees/agent-a3f552/src",
        worktree: {
          name: "agent-a3f552",
          path: "/tmp/demo/.claude/worktrees/agent-a3f552",
          exists: true,
        },
        transcript_path: "/tmp/transcript.jsonl",
        updated_at: 1770000000,
        resume_command: "claude --resume claude-1",
      },
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();

    await expect(page.getByText("Investigate resume flow")).toBeVisible();
    await expect(
      page.getByText("agent-a3f552", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("/tmp/demo/.claude/worktrees/agent-a3f552/src", {
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("History resume adopts the source worktree for the new terminal", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.handle("list_agent_history", () => [
      {
        provider: "codex",
        id: "codex-1",
        title: "Resume from codex worktree",
        preview: null,
        cwd: "/tmp/demo/.acorn/worktrees/acorn-2/src",
        worktree: {
          name: "acorn-2",
          path: "/tmp/demo/.acorn/worktrees/acorn-2",
          exists: true,
        },
        transcript_path: "/tmp/codex-rollout.jsonl",
        updated_at: 1770000000,
        resume_command: "codex resume codex-1",
      },
    ]);
    await tauri.handle("create_session", (args) => ({
      id: "created-1",
      name: (args as { name: string }).name,
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    }));
    await tauri.handle("update_session_worktree", (args) => {
      const w = window as unknown as { __worktreeUpdates?: unknown[] };
      w.__worktreeUpdates = w.__worktreeUpdates ?? [];
      w.__worktreeUpdates.push(args);
      return {
        id: "created-1",
        name: "codex resume",
        repo_path: "/tmp/demo",
        worktree_path: (args as { worktreePath: string }).worktreePath,
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByText("Resume from codex worktree").dblclick();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __worktreeUpdates?: unknown[] })
                .__worktreeUpdates?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __worktreeUpdates?: unknown[] })
          .__worktreeUpdates,
    )) as Array<{ id: string; worktreePath: string }>;
    expect(calls[0]).toEqual({
      id: "created-1",
      worktreePath: "/tmp/demo/.acorn/worktrees/acorn-2",
    });
    await expect(
      page.getByRole("dialog", { name: "Running in worktree" }),
    ).toBeVisible();
  });

  test("History run in new terminal hosts resumed sessions in the project root", async ({
    page,
    tauri,
  }) => {
    await seedActiveWorktreeSession(tauri);
    await tauri.handle("list_agent_history", () => [
      {
        provider: "codex",
        id: "codex-root",
        title: "Resume without project duplication",
        preview: null,
        cwd: "/tmp/demo/.acorn/worktrees/demo-1",
        worktree: {
          name: "demo-1",
          path: "/tmp/demo/.acorn/worktrees/demo-1",
          exists: true,
        },
        transcript_path: "/tmp/codex-root.jsonl",
        updated_at: 1770000000,
        resume_command: "codex resume codex-root",
      },
    ]);
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as { __createSessionCalls?: unknown[] };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      return {
        id: "created-root",
        name: (args as { name: string }).name,
        repo_path: (args as { repoPath: string }).repoPath,
        worktree_path: (args as { repoPath: string }).repoPath,
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByText("Resume without project duplication").click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: "Run in new terminal" }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __createSessionCalls?: unknown[] })
                .__createSessionCalls?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{ repoPath: string }>;
    expect(calls[0].repoPath).toBe("/tmp/demo");
  });

  test("History context menu can explicitly resume in a worktree", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.handle("list_agent_history", () => [
      {
        provider: "claude",
        id: "claude-1",
        title: "Resume from claude worktree",
        preview: null,
        cwd: "/tmp/demo/.claude/worktrees/agent-a3f552/src",
        worktree: {
          name: "agent-a3f552",
          path: "/tmp/demo/.claude/worktrees/agent-a3f552",
          exists: true,
        },
        transcript_path: "/tmp/claude.jsonl",
        updated_at: 1770000000,
        resume_command: "claude --resume claude-1",
      },
    ]);
    await tauri.handle("create_session", (args) => ({
      id: "created-2",
      name: (args as { name: string }).name,
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    }));
    await tauri.handle("update_session_worktree", (args) => {
      const w = window as unknown as { __contextWorktreeUpdates?: unknown[] };
      w.__contextWorktreeUpdates = w.__contextWorktreeUpdates ?? [];
      w.__contextWorktreeUpdates.push(args);
      return {
        id: "created-2",
        name: "claude resume",
        repo_path: "/tmp/demo",
        worktree_path: (args as { worktreePath: string }).worktreePath,
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByText("Resume from claude worktree").click({
      button: "right",
    });

    await expect(
      page.getByRole("menu").getByRole("separator"),
    ).toHaveCount(2);
    await page.getByRole("menuitem", { name: "Run in worktree" }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __contextWorktreeUpdates?: unknown[] })
                .__contextWorktreeUpdates?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);
    await expect(
      page.getByRole("dialog", { name: "Running in worktree" }),
    ).toBeVisible();
  });

  test("History transcript trash action requires confirmation and removes the row", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.handle("list_agent_history", () => [
      {
        provider: "claude",
        id: "claude-trash",
        title: "Disposable transcript",
        preview: null,
        cwd: "/tmp/demo",
        worktree: null,
        transcript_path: "/tmp/claude-trash.jsonl",
        updated_at: 1770000000,
        resume_command: "claude --resume claude-trash",
      },
    ]);
    await tauri.handle("trash_agent_history_transcript", (args) => {
      const w = window as unknown as { __trashTranscriptCalls?: unknown[] };
      w.__trashTranscriptCalls = w.__trashTranscriptCalls ?? [];
      w.__trashTranscriptCalls.push(args);
      return undefined;
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByText("Disposable transcript").click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Move transcript to Trash..." })
      .click();

    await expect(
      page.getByRole("dialog", { name: "Move transcript to Trash?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Move to Trash" }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __trashTranscriptCalls?: unknown[] })
                .__trashTranscriptCalls?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __trashTranscriptCalls?: unknown[] })
          .__trashTranscriptCalls,
    )) as Array<{ provider: string; id: string; transcriptPath: string }>;
    expect(calls[0]).toEqual({
      provider: "claude",
      id: "claude-trash",
      transcriptPath: "/tmp/claude-trash.jsonl",
    });
    await expect(page.getByText("Disposable transcript")).toHaveCount(0);
  });
});
