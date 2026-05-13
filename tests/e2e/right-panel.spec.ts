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

    await page.getByRole("button", { name: "PRs" }).click();
    // PR tab: when remote isn't GitHub OR list is empty, one of these shows.
    // Mock returns an empty list so the empty-list copy wins.
    await expect(page.getByText(/No .* pull requests/i)).toBeVisible();

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
