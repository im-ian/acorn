import { test, expect, pressHotkey } from "./support";
import type { Locator, Page } from "@playwright/test";

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
      status: "ready",
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
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
}

async function dblclickRowRightSide(page: Page, row: Locator): Promise<void> {
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.dblclick(box!.x + box!.width - 12, box!.y + box!.height / 2);
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

    const stagedButton = page.getByRole("button", { name: "Staged" });
    await stagedButton.hover();
    await expect(page.getByRole("tooltip").locator("kbd")).toHaveText(
      /^(⇧⌘S|Ctrl\+Shift\+S)$/,
    );
    await stagedButton.click();
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

  test("double-clicking a commit opens the diff modal before the diff finishes loading", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_commits", [
      {
        sha: "abc1234567890abcdef1234567890abcdef1234",
        short_sha: "abc1234",
        author: "Test Author",
        author_email: "test@example.com",
        summary: "Large diff commit",
        body: "",
        timestamp: 1_700_000_000,
        pushed: true,
      },
    ]);
    await tauri.handle("commit_diff", (args) => {
      const w = window as unknown as {
        __commitDiffCalls?: unknown[];
        __releaseCommitDiff?: boolean;
      };
      w.__commitDiffCalls = w.__commitDiffCalls ?? [];
      w.__commitDiffCalls.push(args);
      return new Promise((resolve) => {
        const tick = () => {
          if (w.__releaseCommitDiff) {
            resolve({
              files: [
                {
                  old_path: "src/old.ts",
                  new_path: "src/new.ts",
                  patch: "@@ -1 +1 @@\n-old\n+new\n",
                  is_image: false,
                },
              ],
            });
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    });

    await page.goto("/");
    await expect(page.getByText("Large diff commit")).toBeVisible();

    const commitRow = page
      .getByText("Large diff commit")
      .locator("xpath=ancestor::button[1]");
    await dblclickRowRightSide(page, commitRow);

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __commitDiffCalls?: unknown[] })
              .__commitDiffCalls?.length ?? 0,
        ),
      )
      .toBe(1);
    const dialog = page.locator('[role="dialog"]').filter({
      has: page.getByRole("heading", { name: "Large diff commit" }),
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("loading diff...")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).hover();
    await expect(
      page.getByRole("tooltip", { name: "Close" }),
    ).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __releaseCommitDiff?: boolean })
        .__releaseCommitDiff = true;
    });
    await expect(
      dialog.getByRole("button", { name: /new\.ts\s+\+1\s+-1\s+src/ }),
    ).toBeVisible();
    await expect(dialog.getByLabel("loading diff...")).toHaveCount(0);
  });

  test("double-clicking an issue opens its in-app detail modal", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_issues", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 42,
          title: "Render issue detail in app",
          state: "OPEN",
          author: "im-ian",
          url: "https://github.com/im-ian/acorn/issues/42",
          created_at: "2026-05-18T00:00:00Z",
          updated_at: "2026-05-19T00:00:00Z",
          state_reason: null,
          comments: 1,
          labels: [{ name: "enhancement", color: "a2eeef" }],
        },
      ],
    });
    await tauri.respond("get_issue_detail", {
      kind: "ok",
      account: "test-account",
      detail: {
        number: 42,
        title: "Render issue detail in app",
        body:
          "Loaded issue body from gh.\n\n![Issue screenshot](https://example.com/issue.png)",
        state: "OPEN",
        author: "im-ian",
        url: "https://github.com/im-ian/acorn/issues/42",
        created_at: "2026-05-18T00:00:00Z",
        updated_at: "2026-05-19T00:00:00Z",
        state_reason: null,
        labels: [{ name: "enhancement", color: "a2eeef" }],
        comments: [
          {
            id: 4201,
            author: "im-ian",
            author_avatar_url: null,
            body: "Older in-app issue comment.",
            created_at: "2026-05-19T01:00:00Z",
            url: "https://github.com/im-ian/acorn/issues/42#issuecomment-1",
          },
          {
            id: 4202,
            author: "botlesun",
            author_avatar_url: null,
            body: "Newer in-app issue comment.",
            created_at: "2026-05-19T02:00:00Z",
            url: "https://github.com/im-ian/acorn/issues/42#issuecomment-2",
          },
        ],
        assignees: ["im-ian"],
        milestone: "v1",
      },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "Issues" }).click();
    const issueRow = page
      .getByText("Render issue detail in app")
      .locator("xpath=ancestor::li[@role='button'][1]");
    await dblclickRowRightSide(page, issueRow);

    const dialog = page.locator('[role="dialog"]').filter({
      has: page.getByRole("heading", { name: "Render issue detail in app" }),
    });
    await expect(dialog.getByText("Loaded issue body from gh.")).toBeVisible();
    const comments = dialog.locator("section ul > li");
    await expect(comments.nth(0)).toContainText("Older in-app issue comment.");
    await expect(comments.nth(1)).toContainText("Newer in-app issue comment.");

    await dialog.getByRole("img", { name: "Issue screenshot" }).click();
    const imagePreview = page.getByRole("dialog", { name: "Image preview" });
    await expect(imagePreview).toBeVisible();
    await imagePreview
      .getByRole("button", { name: "Open in browser" })
      .hover();
    await expect(
      page.getByRole("tooltip", { name: "Open in browser" }),
    ).toBeVisible();
    await imagePreview.getByRole("button", { name: "Close" }).hover();
    await expect(
      page.getByRole("tooltip", { name: "Close" }),
    ).toBeVisible();
    await imagePreview.getByRole("button", { name: "Close" }).click();
    await expect(imagePreview).toHaveCount(0);

    await dialog.getByRole("button", { name: "Close" }).hover();
    await expect(
      page.getByRole("tooltip", { name: "Close" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Oldest first" }).click();
    await expect(comments.nth(0)).toContainText("Newer in-app issue comment.");
    await expect(comments.nth(1)).toContainText("Older in-app issue comment.");
  });

  test("posting from the issue detail modal appends a comment", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_issues", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 43,
          title: "Comment from issue modal",
          state: "OPEN",
          author: "im-ian",
          url: "https://github.com/im-ian/acorn/issues/43",
          created_at: "2026-05-18T00:00:00Z",
          updated_at: "2026-05-19T00:00:00Z",
          state_reason: null,
          comments: 0,
          labels: [],
        },
      ],
    });
    await tauri.handle("get_issue_detail", () => {
      const w = window as unknown as {
        __issueModalComments?: Array<{ id: number; body: string }>;
      };
      const comments = w.__issueModalComments ?? [];
      return {
        kind: "ok",
        account: "im-ian",
        detail: {
          number: 43,
          title: "Comment from issue modal",
          body: "Issue body",
          state: "OPEN",
          author: "im-ian",
          url: "https://github.com/im-ian/acorn/issues/43",
          created_at: "2026-05-18T00:00:00Z",
          updated_at: "2026-05-19T00:00:00Z",
          state_reason: null,
          labels: [],
          comments: comments.map((comment, index) => ({
            id: comment.id,
            author: "im-ian",
            author_avatar_url: null,
            body: comment.body,
            created_at: `2026-05-19T01:0${index}:00Z`,
            url: `https://github.com/im-ian/acorn/issues/43#issuecomment-${comment.id}`,
          })),
          assignees: [],
          milestone: null,
        },
      };
    });
    await tauri.handle("add_issue_comment", (args) => {
      const w = window as unknown as {
        __issueModalComments?: Array<{ id: number; body: string }>;
        __issueCommentArgs?: unknown[];
      };
      w.__issueModalComments = w.__issueModalComments ?? [];
      w.__issueCommentArgs = w.__issueCommentArgs ?? [];
      w.__issueCommentArgs.push(args);
      w.__issueModalComments.push({
        id: 4300 + w.__issueModalComments.length,
        body: (args as { body?: string }).body ?? "missing body",
      });
      return undefined;
    });
    await tauri.handle("update_github_comment", (args) => {
      const w = window as unknown as {
        __issueModalComments?: Array<{ id: number; body: string }>;
        __issueCommentUpdateArgs?: unknown[];
      };
      w.__issueModalComments = w.__issueModalComments ?? [];
      w.__issueCommentUpdateArgs = w.__issueCommentUpdateArgs ?? [];
      w.__issueCommentUpdateArgs.push(args);
      const comment = w.__issueModalComments.find(
        (item) => item.id === (args as { commentId?: number }).commentId,
      );
      if (comment) comment.body = (args as { body?: string }).body ?? comment.body;
      return undefined;
    });
    await tauri.handle("delete_github_comment", (args) => {
      const w = window as unknown as {
        __issueModalComments?: Array<{ id: number; body: string }>;
        __issueCommentDeleteArgs?: unknown[];
      };
      w.__issueModalComments = w.__issueModalComments ?? [];
      w.__issueCommentDeleteArgs = w.__issueCommentDeleteArgs ?? [];
      w.__issueCommentDeleteArgs.push(args);
      w.__issueModalComments = w.__issueModalComments.filter(
        (item) => item.id !== (args as { commentId?: number }).commentId,
      );
      return undefined;
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "Issues" }).click();
    const issueRow = page
      .getByText("Comment from issue modal")
      .locator("xpath=ancestor::li[@role='button'][1]");
    await dblclickRowRightSide(page, issueRow);

    await page
      .getByLabel("Issue comment")
      .fill("Posted from **Acorn** issue modal.");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Discard comment draft?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByLabel("Issue comment")).toHaveValue(
      "Posted from **Acorn** issue modal.",
    );
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(
      page.getByText("Posted from Acorn issue modal."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Write" }).click();
    await expect(page.getByLabel("Issue comment")).toHaveValue(
      "Posted from **Acorn** issue modal.",
    );
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    await expect(
      page.getByText("Posted from Acorn issue modal."),
    ).toBeVisible();
    await expect(page.getByLabel("Issue comment")).toHaveValue("");

    await page.getByRole("button", { name: "Edit comment" }).click();
    await page
      .getByRole("textbox", { name: "Edit comment" })
      .fill("Edited from **Acorn** issue modal.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByText("Edited from Acorn issue modal."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Delete comment" }).click();
    await expect(
      page.getByRole("dialog", { name: "Delete comment?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByText("Edited from Acorn issue modal."),
    ).toHaveCount(0);

    const call = await page.evaluate(() => {
      const w = window as unknown as { __issueCommentArgs?: unknown[] };
      return w.__issueCommentArgs?.[0];
    });
    expect(call).toEqual({
      repoPath: "/tmp/demo",
      number: 43,
      body: "Posted from **Acorn** issue modal.",
    });
    const updateCall = await page.evaluate(() => {
      const w = window as unknown as { __issueCommentUpdateArgs?: unknown[] };
      return w.__issueCommentUpdateArgs?.[0];
    });
    expect(updateCall).toEqual({
      repoPath: "/tmp/demo",
      accountLogin: "im-ian",
      commentId: 4300,
      body: "Edited from **Acorn** issue modal.",
    });
    const deleteCall = await page.evaluate(() => {
      const w = window as unknown as { __issueCommentDeleteArgs?: unknown[] };
      return w.__issueCommentDeleteArgs?.[0];
    });
    expect(deleteCall).toEqual({
      repoPath: "/tmp/demo",
      accountLogin: "im-ian",
      commentId: 4300,
    });
  });

  test("double-clicking a pull request row opens its in-app detail modal", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_pull_requests", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 87,
          title: "Review full row PR",
          state: "OPEN",
          author: "im-ian",
          head_branch: "feature/full-row",
          base_branch: "main",
          url: "https://github.com/im-ian/acorn/pull/87",
          updated_at: "2026-05-19T00:00:00Z",
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
    });
    await tauri.respond("get_pull_request_detail", {
      kind: "ok",
      account: "test-account",
      detail: {
        number: 87,
        title: "Review full row PR",
        body: "Loaded pull request body from gh.",
        state: "OPEN",
        is_draft: false,
        author: "im-ian",
        head_branch: "feature/full-row",
        base_branch: "main",
        url: "https://github.com/im-ian/acorn/pull/87",
        created_at: "2026-05-18T00:00:00Z",
        updated_at: "2026-05-19T00:00:00Z",
        merged_at: null,
        additions: 12,
        deletions: 3,
        changed_files: 2,
        mergeable: "MERGEABLE",
        labels: [],
        comments: [],
        reviews: [],
        checks: [],
        commits: [],
      },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();

    const prRow = page
      .getByText("Review full row PR")
      .locator("xpath=ancestor::li[@role='button'][1]");
    await dblclickRowRightSide(page, prRow);

    await expect(
      page.getByText("Loaded pull request body from gh."),
    ).toBeVisible();
  });

  test("right-clicking a pull request opens the session for its head branch", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "main-session",
        name: "Main work",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        position: 0,
      },
      {
        id: "pr-session",
        name: "PR work",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/pr-work",
        branch: "feature/pr-session",
        isolated: true,
        status: "ready",
        created_at: "2026-01-01T00:00:01Z",
        updated_at: "2026-01-01T00:00:06Z",
        last_message: null,
        position: 1,
      },
    ]);
    await tauri.respond("list_pull_requests", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 91,
          title: "Open the matching session",
          state: "OPEN",
          author: "im-ian",
          head_branch: "feature/pr-session",
          base_branch: "main",
          url: "https://github.com/im-ian/acorn/pull/91",
          updated_at: "2026-05-19T00:00:00Z",
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();

    const prRow = page
      .getByText("Open the matching session")
      .locator("xpath=ancestor::li[@role='button'][1]");
    await prRow.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open session (PR work)" })
      .click();

    await expect(
      page.locator('[data-tab-drag-handle="pr-session"]').locator(".."),
    ).toHaveClass(/acorn-tab-active-bg/);
  });

  test("posting from the pull request detail modal appends a conversation comment", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_pull_requests", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 88,
          title: "Comment from PR modal",
          state: "OPEN",
          author: "im-ian",
          head_branch: "feature/comment",
          base_branch: "main",
          url: "https://github.com/im-ian/acorn/pull/88",
          updated_at: "2026-05-19T00:00:00Z",
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
    });
    await tauri.handle("get_pull_request_detail", () => {
      const w = window as unknown as {
        __prModalComments?: Array<{ id: number; body: string }>;
      };
      const comments = w.__prModalComments ?? [];
      return {
        kind: "ok",
        account: "im-ian",
        detail: {
          number: 88,
          title: "Comment from PR modal",
          body: "PR body",
          state: "OPEN",
          is_draft: false,
          author: "im-ian",
          head_branch: "feature/comment",
          base_branch: "main",
          url: "https://github.com/im-ian/acorn/pull/88",
          created_at: "2026-05-18T00:00:00Z",
          updated_at: "2026-05-19T00:00:00Z",
          merged_at: null,
          additions: 1,
          deletions: 0,
          changed_files: 1,
          mergeable: "MERGEABLE",
          labels: [],
          comments: comments.map((comment, index) => ({
            id: comment.id,
            author: "im-ian",
            author_avatar_url: null,
            body: comment.body,
            created_at: `2026-05-19T01:1${index}:00Z`,
            url: `https://github.com/im-ian/acorn/pull/88#issuecomment-${comment.id}`,
          })),
          reviews: [],
          checks: [],
          commits: [],
        },
      };
    });
    await tauri.handle("add_pull_request_comment", (args) => {
      const w = window as unknown as {
        __prModalComments?: Array<{ id: number; body: string }>;
        __prCommentArgs?: unknown[];
      };
      w.__prModalComments = w.__prModalComments ?? [];
      w.__prCommentArgs = w.__prCommentArgs ?? [];
      w.__prCommentArgs.push(args);
      w.__prModalComments.push({
        id: 8800 + w.__prModalComments.length,
        body: (args as { body?: string }).body ?? "missing body",
      });
      return undefined;
    });
    await tauri.handle("update_github_comment", (args) => {
      const w = window as unknown as {
        __prModalComments?: Array<{ id: number; body: string }>;
        __prCommentUpdateArgs?: unknown[];
      };
      w.__prModalComments = w.__prModalComments ?? [];
      w.__prCommentUpdateArgs = w.__prCommentUpdateArgs ?? [];
      w.__prCommentUpdateArgs.push(args);
      const comment = w.__prModalComments.find(
        (item) => item.id === (args as { commentId?: number }).commentId,
      );
      if (comment) comment.body = (args as { body?: string }).body ?? comment.body;
      return undefined;
    });
    await tauri.handle("delete_github_comment", (args) => {
      const w = window as unknown as {
        __prModalComments?: Array<{ id: number; body: string }>;
        __prCommentDeleteArgs?: unknown[];
      };
      w.__prModalComments = w.__prModalComments ?? [];
      w.__prCommentDeleteArgs = w.__prCommentDeleteArgs ?? [];
      w.__prCommentDeleteArgs.push(args);
      w.__prModalComments = w.__prModalComments.filter(
        (item) => item.id !== (args as { commentId?: number }).commentId,
      );
      return undefined;
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();
    const prRow = page
      .getByText("Comment from PR modal")
      .locator("xpath=ancestor::li[@role='button'][1]");
    await dblclickRowRightSide(page, prRow);

    await page
      .getByLabel("Pull request comment")
      .fill("Posted from **Acorn** PR modal.");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Discard comment draft?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByLabel("Pull request comment")).toHaveValue(
      "Posted from **Acorn** PR modal.",
    );
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText("Posted from Acorn PR modal.")).toBeVisible();
    await page.getByRole("button", { name: "Write" }).click();
    await expect(page.getByLabel("Pull request comment")).toHaveValue(
      "Posted from **Acorn** PR modal.",
    );
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    await expect(page.getByText("Posted from Acorn PR modal.")).toBeVisible();
    await expect(page.getByLabel("Pull request comment")).toHaveValue("");

    await page.getByRole("button", { name: "Edit comment" }).click();
    await page
      .getByRole("textbox", { name: "Edit comment" })
      .fill("Edited from **Acorn** PR modal.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Edited from Acorn PR modal.")).toBeVisible();

    await page.getByRole("button", { name: "Delete comment" }).click();
    await expect(
      page.getByRole("dialog", { name: "Delete comment?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Edited from Acorn PR modal.")).toHaveCount(0);

    const call = await page.evaluate(() => {
      const w = window as unknown as { __prCommentArgs?: unknown[] };
      return w.__prCommentArgs?.[0];
    });
    expect(call).toEqual({
      repoPath: "/tmp/demo",
      number: 88,
      body: "Posted from **Acorn** PR modal.",
    });
    const updateCall = await page.evaluate(() => {
      const w = window as unknown as { __prCommentUpdateArgs?: unknown[] };
      return w.__prCommentUpdateArgs?.[0];
    });
    expect(updateCall).toEqual({
      repoPath: "/tmp/demo",
      accountLogin: "im-ian",
      commentId: 8800,
      body: "Edited from **Acorn** PR modal.",
    });
    const deleteCall = await page.evaluate(() => {
      const w = window as unknown as { __prCommentDeleteArgs?: unknown[] };
      return w.__prCommentDeleteArgs?.[0];
    });
    expect(deleteCall).toEqual({
      repoPath: "/tmp/demo",
      accountLogin: "im-ian",
      commentId: 8800,
    });
  });

  test("opening PR merge from the context menu shows a skeleton before details load", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_pull_requests", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 17,
          title: "Slow merge PR",
          state: "OPEN",
          author: "im-ian",
          head_branch: "feature/slow-merge",
          base_branch: "main",
          url: "https://github.com/im-ian/acorn/pull/17",
          updated_at: "2026-05-19T00:00:00Z",
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
    });
    await tauri.handle("get_pull_request_detail", (args) => {
      const w = window as unknown as {
        __prDetailCalls?: unknown[];
        __releasePrDetail?: boolean;
      };
      w.__prDetailCalls = w.__prDetailCalls ?? [];
      w.__prDetailCalls.push(args);
      return new Promise((resolve) => {
        const tick = () => {
          if (w.__releasePrDetail) {
            resolve({
              kind: "ok",
              account: "test-account",
              detail: {
                number: 17,
                title: "Slow merge PR",
                body: "Merge body",
                state: "OPEN",
                is_draft: false,
                author: "im-ian",
                head_branch: "feature/slow-merge",
                base_branch: "main",
                url: "https://github.com/im-ian/acorn/pull/17",
                created_at: "2026-05-18T00:00:00Z",
                updated_at: "2026-05-19T00:00:00Z",
                merged_at: null,
                additions: 12,
                deletions: 3,
                changed_files: 2,
                mergeable: "MERGEABLE",
                labels: [],
                comments: [],
                reviews: [],
                checks: [],
                commits: [],
              },
            });
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await expect(page.getByText("Slow merge PR")).toBeVisible();
    await page.getByText("Slow merge PR").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Merge…$/ }).click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __prDetailCalls?: unknown[] })
              .__prDetailCalls?.length ?? 0,
        ),
      )
      .toBe(1);
    const dialog = page.locator('[role="dialog"]').filter({
      has: page.getByRole("heading", { name: "Merge #17" }),
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Loading pull request details..."),
    ).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __releasePrDetail?: boolean }).__releasePrDetail =
        true;
    });
    await expect(dialog.locator("input")).toHaveValue("Slow merge PR");
    await expect(
      dialog.getByLabel("Loading pull request details..."),
    ).toHaveCount(0);
  });

  test("opening PR close from the context menu shows a skeleton before details load", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_pull_requests", {
      kind: "ok",
      account: "test-account",
      items: [
        {
          number: 18,
          title: "Slow close PR",
          state: "OPEN",
          author: "im-ian",
          head_branch: "feature/slow-close",
          base_branch: "main",
          url: "https://github.com/im-ian/acorn/pull/18",
          updated_at: "2026-05-19T00:00:00Z",
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
    });
    await tauri.handle("get_pull_request_detail", (args) => {
      const w = window as unknown as {
        __prDetailCalls?: unknown[];
        __releasePrDetail?: boolean;
      };
      w.__prDetailCalls = w.__prDetailCalls ?? [];
      w.__prDetailCalls.push(args);
      return new Promise((resolve) => {
        const tick = () => {
          if (w.__releasePrDetail) {
            resolve({
              kind: "ok",
              account: "test-account",
              detail: {
                number: 18,
                title: "Slow close PR",
                body: "Close body",
                state: "OPEN",
                is_draft: false,
                author: "im-ian",
                head_branch: "feature/slow-close",
                base_branch: "main",
                url: "https://github.com/im-ian/acorn/pull/18",
                created_at: "2026-05-18T00:00:00Z",
                updated_at: "2026-05-19T00:00:00Z",
                merged_at: null,
                additions: 8,
                deletions: 1,
                changed_files: 1,
                mergeable: "MERGEABLE",
                labels: [],
                comments: [],
                reviews: [],
                checks: [],
                commits: [],
              },
            });
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await expect(page.getByText("Slow close PR")).toBeVisible();
    await page.getByText("Slow close PR").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Close…$/ }).click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __prDetailCalls?: unknown[] })
              .__prDetailCalls?.length ?? 0,
        ),
      )
      .toBe(1);
    const dialog = page.locator('[role="dialog"]').filter({
      has: page.getByRole("heading", { name: "Close #18" }),
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Loading pull request details..."),
    ).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __releasePrDetail?: boolean }).__releasePrDetail =
        true;
    });
    await expect(dialog.getByText("Slow close PR")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Close PR" }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel("Loading pull request details..."),
    ).toHaveCount(0);
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

  test("double-clicking a staged worktree file opens it as a code tab", async ({
    page,
    tauri,
  }) => {
    await seedActiveWorktreeSession(tauri);
    await tauri.respond("list_staged", [
      {
        path: "src/components/Terminal.tsx",
        status: "staged-modified",
      },
    ]);
    await tauri.respond("staged_file_diff", { files: [] });
    await tauri.handle("fs_read_file", (args) => {
      const w = window as unknown as { __readFilePaths?: string[] };
      w.__readFilePaths = w.__readFilePaths ?? [];
      w.__readFilePaths.push((args as { path: string }).path);
      return {
        content: "export function Terminal() {}",
        size: 29,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Staged" }).click();
    const stagedRow = page
      .getByText("src/components/Terminal.tsx")
      .locator("xpath=ancestor::li[1]");
    await dblclickRowRightSide(page, stagedRow);

    await expect(
      page.getByRole("button", { name: /Terminal\.tsx Close tab/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __readFilePaths?: string[] })
              .__readFilePaths ?? [],
        ),
      )
      .toContain("/tmp/demo/.acorn/worktrees/demo-1/src/components/Terminal.tsx");
  });

  test("double-clicking a deleted staged file does not open a code tab", async ({
    page,
    tauri,
  }) => {
    await seedActiveWorktreeSession(tauri);
    await tauri.respond("list_staged", [
      {
        path: "src/deleted.ts",
        status: "staged-deleted",
      },
    ]);
    await tauri.respond("staged_file_diff", {
      files: [
        {
          old_path: "src/deleted.ts",
          new_path: null,
          patch: "@@ -1 +0,0 @@\n-export const gone = true;\n",
          is_image: false,
        },
      ],
    });
    await tauri.handle("fs_read_file", (args) => {
      const w = window as unknown as { __readFilePaths?: string[] };
      w.__readFilePaths = w.__readFilePaths ?? [];
      w.__readFilePaths.push((args as { path: string }).path);
      return {
        content: "",
        size: 0,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Staged" }).click();
    const stagedList = page.locator("#staged-list");
    const deletedRow = stagedList
      .getByText("src/deleted.ts")
      .locator("xpath=ancestor::li[1]");
    await dblclickRowRightSide(page, deletedRow);

    await expect(stagedList.getByText("src/deleted.ts")).toBeVisible();
    await expect(page.getByText(/nothing to open/i)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /deleted\.ts Close tab/ }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __readFilePaths?: string[] })
              .__readFilePaths ?? [],
        ),
      )
      .toEqual([]);

    await stagedList.getByText("src/deleted.ts").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Open in editor" }),
    ).toBeDisabled();
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
    await page.getByRole("button", { name: /^sess main · Ready$/ }).click();
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
        status: "ready",
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
        status: "ready",
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
    await page.getByRole("button", { name: /^sess-a main · Ready$/ }).click();
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
    await page.getByRole("button", { name: /^sess-b main · Ready$/ }).click();
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

  test("same-project worktree pane focus keeps GitHub tabs mounted", async ({
    page,
    tauri,
  }) => {
    const repoPath = "/tmp/demo";
    const worktreeA = "/tmp/demo/.acorn/worktrees/alpha";
    const worktreeB = "/tmp/demo/.acorn/worktrees/beta";

    await tauri.respond("list_projects", [
      {
        repo_path: repoPath,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "s-alpha",
        name: "alpha",
        repo_path: repoPath,
        worktree_path: worktreeA,
        branch: "alpha",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "s-beta",
        name: "beta",
        repo_path: repoPath,
        worktree_path: worktreeB,
        branch: "beta",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("pty_repo_root", (args) => {
      const sessionId = (args as { sessionId?: string }).sessionId;
      if (sessionId === "s-alpha") return "/tmp/demo/.acorn/worktrees/alpha/";
      if (sessionId === "s-beta") return "/tmp/demo/.acorn/worktrees/beta/";
      return null;
    });
    await tauri.handle("list_pull_requests", (args) => {
      const w = window as unknown as {
        __prCalls?: Array<{ repoPath: string; query?: string | null }>;
      };
      w.__prCalls = w.__prCalls ?? [];
      w.__prCalls.push(args as { repoPath: string; query?: string | null });
      return { kind: "ok", items: [], account: null };
    });
    await tauri.handle("list_issues", (args) => {
      const w = window as unknown as { __issueRepoPaths?: string[] };
      w.__issueRepoPaths = w.__issueRepoPaths ?? [];
      w.__issueRepoPaths.push((args as { repoPath: string }).repoPath);
      return { kind: "ok", items: [], account: null };
    });
    await tauri.handle("list_workflow_runs", (args) => {
      const w = window as unknown as { __workflowRepoPaths?: string[] };
      w.__workflowRepoPaths = w.__workflowRepoPaths ?? [];
      w.__workflowRepoPaths.push((args as { repoPath: string }).repoPath);
      return { kind: "ok", items: [], account: null };
    });

    await page.goto("/");
    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^alpha worktree alpha · Ready$/ })
      .click();
    await page.getByRole("button", { name: "GitHub" }).click();
    await expect(page.getByText(/No open pull requests/i)).toBeVisible();

    const indicator = page.locator("[data-active-pane-indicator]");
    const alphaPaneId = await indicator.getAttribute(
      "data-active-pane-indicator",
    );
    expect(alphaPaneId).not.toBeNull();

    await pressHotkey(page, { mod: true, key: "d" });
    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^beta worktree beta · Ready$/ })
      .click();
    await expect(page.locator("[data-pane-body]")).toHaveCount(2);
    await expect(page.getByText(/No open pull requests/i)).toBeVisible();
    await page.getByRole("button", { name: "Closed" }).click();
    await expect(page.getByText(/No closed pull requests/i)).toBeVisible();

    // Let initial PR/Issues/Actions effects and background prefetch settle,
    // then prove same-project pane focus does not remount GitHub tabs.
    await page.waitForTimeout(1_500);
    const initialCalls = await page.evaluate(() => {
      const w = window as unknown as {
        __prCalls?: Array<{ repoPath: string; query?: string | null }>;
        __issueRepoPaths?: string[];
        __workflowRepoPaths?: string[];
      };
      return [
        ...(w.__prCalls ?? [])
          .filter((call) => !call.query?.startsWith("head:"))
          .map((call) => call.repoPath),
        ...(w.__issueRepoPaths ?? []),
        ...(w.__workflowRepoPaths ?? []),
      ];
    });
    const unexpectedInitialPaths = initialCalls.filter(
      (path) => path !== repoPath,
    );
    expect(initialCalls).toContain(repoPath);
    expect(unexpectedInitialPaths).toEqual([]);

    await page.evaluate(() => {
      const w = window as unknown as {
        __prCalls?: Array<{ repoPath: string; query?: string | null }>;
        __issueRepoPaths?: string[];
        __workflowRepoPaths?: string[];
      };
      w.__prCalls = [];
      w.__issueRepoPaths = [];
      w.__workflowRepoPaths = [];
    });

    await page
      .locator(`[data-pane-body="${alphaPaneId}"]`)
      .click({ position: { x: 12, y: 12 } });
    await expect(page.getByText(/No closed pull requests/i)).toBeVisible();
    await page.waitForTimeout(300);

    const calls = await page.evaluate(() => {
      const w = window as unknown as {
        __prCalls?: Array<{ repoPath: string; query?: string | null }>;
        __issueRepoPaths?: string[];
        __workflowRepoPaths?: string[];
      };
      return {
        prs: (w.__prCalls ?? [])
          .filter((call) => !call.query?.startsWith("head:"))
          .map((call) => call.repoPath),
        issues: w.__issueRepoPaths ?? [],
        workflows: w.__workflowRepoPaths ?? [],
      };
    });
    expect(
      [...calls.prs, ...calls.issues, ...calls.workflows].filter(
        (path) => path !== repoPath,
      ),
    ).toEqual([]);
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

  test("local chat focus hides Code and shows local agent history", async ({
    page,
    tauri,
  }) => {
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
        id: "local-codex",
        name: "codex",
        repo_path: "/Users/tester",
        worktree_path: "/Users/tester",
        branch: "HEAD",
        isolated: false,
        project_scoped: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
        agent_provider: "codex",
      },
    ]);
    await tauri.handle("pty_repo_root", () => null);
    await tauri.handle("list_unscoped_agent_history", () => {
      const w = window as unknown as { __unscopedHistoryCalls?: number };
      w.__unscopedHistoryCalls = (w.__unscopedHistoryCalls ?? 0) + 1;
      return [
        {
          provider: "codex",
          id: "codex-local",
          title: "Local Codex session",
          preview: null,
          queued_message_count: 0,
          subagent_transcript_count: 0,
          cwd: "/Users/tester",
          worktree: null,
          transcript_path: "/Users/tester/.codex/session.jsonl",
          updated_at: 1770000000,
          resume_command: "codex resume codex-local",
        },
      ];
    });

    await page.goto("/");
    const chats = page.getByRole("region", { name: "Local terminal sessions" });
    await chats.getByRole("button", { name: /codex/i }).click();

    await expect(
      page.getByRole("button", { name: "Code", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "GitHub", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Agents", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("Local Codex session")).toBeVisible();
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __unscopedHistoryCalls?: number })
                .__unscopedHistoryCalls ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBeGreaterThan(0);
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
        queued_message_count: 0,
        subagent_transcript_count: 0,
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

  test("History provider filter scopes visible rows", async ({
    page,
    tauri,
  }) => {
    await seedActiveSession(tauri);
    await tauri.respond("list_agent_history", [
      {
        provider: "codex",
        id: "codex-filter",
        title: "Codex refactor",
        preview: null,
        queued_message_count: 0,
        subagent_transcript_count: 0,
        cwd: "/tmp/demo",
        worktree: null,
        transcript_path: "/tmp/codex-filter.jsonl",
        updated_at: 1770000000,
        resume_command: "codex resume codex-filter",
      },
      {
        provider: "claude",
        id: "claude-filter",
        title: "Claude outline",
        preview: null,
        queued_message_count: 0,
        subagent_transcript_count: 0,
        cwd: "/tmp/demo",
        worktree: null,
        transcript_path: "/tmp/claude-filter.jsonl",
        updated_at: 1770000001,
        resume_command: "claude --resume claude-filter",
      },
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();

    const filter = page.getByRole("combobox", { name: "Filter by agent" });
    await expect(filter).toContainText("All agents");
    await expect(page.getByText("Codex refactor")).toBeVisible();
    await expect(page.getByText("Claude outline")).toBeVisible();

    await filter.click();
    await page.getByRole("option", { name: "Codex" }).click();
    await expect(page.getByText("Codex refactor")).toBeVisible();
    await expect(page.getByText("Claude outline")).toHaveCount(0);

    await filter.click();
    await page.getByRole("option", { name: "Claude" }).click();
    await expect(page.getByText("Codex refactor")).toHaveCount(0);
    await expect(page.getByText("Claude outline")).toBeVisible();
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
        queued_message_count: 0,
        subagent_transcript_count: 0,
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
      status: "ready",
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
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();
    const historyRow = page
      .getByText("Resume from codex worktree")
      .locator("xpath=ancestor::div[contains(@class, 'rounded-md')][1]");
    await dblclickRowRightSide(page, historyRow);

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
        queued_message_count: 0,
        subagent_transcript_count: 0,
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
        status: "ready",
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
        queued_message_count: 0,
        subagent_transcript_count: 0,
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
      status: "ready",
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
        status: "ready",
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
        queued_message_count: 0,
        subagent_transcript_count: 0,
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

  test("History context menu copies the transcript path", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            const w = window as unknown as { __clipboardWrites?: string[] };
            w.__clipboardWrites = w.__clipboardWrites ?? [];
            w.__clipboardWrites.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    await seedActiveSession(tauri);
    await tauri.handle("list_agent_history", () => [
      {
        provider: "codex",
        id: "codex-copy-path",
        title: "Copy path transcript",
        preview: null,
        queued_message_count: 0,
        subagent_transcript_count: 0,
        cwd: "/tmp/demo",
        worktree: null,
        transcript_path: "/tmp/codex-copy-path.jsonl",
        updated_at: 1770000000,
        resume_command: "codex resume codex-copy-path",
      },
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByText("Copy path transcript").click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Copy transcript path" })
      .click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __clipboardWrites?: string[] })
                .__clipboardWrites?.at(-1) ?? null,
          ),
        { timeout: 3_000 },
      )
      .toBe("/tmp/codex-copy-path.jsonl");
  });
});
