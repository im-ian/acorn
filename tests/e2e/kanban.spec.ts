import { test, expect, pressHotkey } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

function project(repoPath: string, name: string, position: number) {
  return {
    repo_path: repoPath,
    name,
    created_at: "2026-01-01T00:00:00Z",
    position,
  };
}

function session(
  id: string,
  name: string,
  status: "ready" | "working" | "waiting_for_input" | "errored",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    repo_path: "/tmp/demo",
    worktree_path: `/tmp/demo/.worktrees/${id}`,
    branch: `feat/${id}`,
    isolated: false,
    status,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:05Z",
    last_message: null,
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

test.describe("workspace kanban mode", () => {
  test("derives lifecycle from agent work instead of shared Git state", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("new-session", "new session", "ready"),
      session("worked-session", "worked session", "ready", {
        last_user_message: "Implement the requested change",
        last_agent_message: "Implemented and committed the change",
      }),
      session("shell-process", "shell process", "working"),
      session("agent-process", "agent process", "working", {
        agent_provider: "codex",
      }),
    ]);
    await tauri.handle("fs_git_status", (args) => {
      const repoRoot = (args as { repoRoot?: string }).repoRoot ?? "";
      return {
        statuses: repoRoot.endsWith("/new-session")
          ? {
              "src/App.tsx": {
                kind: "modified",
                additions: 0,
                deletions: 0,
              },
            }
          : {},
        huge: false,
        limit: 10_000,
      };
    });
    await tauri.respond("fs_git_diff_stats", {
      "src/App.tsx": { additions: 19, deletions: 3 },
    });

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const newSessionCard = board.locator(
      'section[aria-label="Idle"] [data-kanban-session-id="new-session"]',
    );
    const workedSessionCard = board.locator(
      'section[aria-label="Review"] [data-kanban-session-id="worked-session"]',
    );
    const shellProcessCard = board.locator(
      'section[aria-label="Idle"] [data-kanban-session-id="shell-process"]',
    );
    const agentProcessCard = board.locator(
      'section[aria-label="Working"] [data-kanban-session-id="agent-process"]',
    );
    await expect(newSessionCard).toBeVisible();
    await expect(workedSessionCard).toBeVisible();
    await expect(shellProcessCard).toBeVisible();
    await expect(agentProcessCard).toBeVisible();
    await expect(
      newSessionCard.getByTestId("workspace-kanban-card-diff"),
    ).toContainText("+19-3");
  });

  test("keeps surviving cards in their lifecycle columns while deleting a completed session", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: true,
            confirmDeleteIsolatedWorktrees: true,
            showRestartPromptOnExit: true,
          },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __kanbanSessionRemoved?: boolean };
      const survivor = {
        id: "survivor",
        name: "survivor",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.worktrees/survivor",
        branch: "feat/survivor",
        isolated: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: true,
      };
      if (w.__kanbanSessionRemoved) return [survivor];
      return [
        {
          id: "completed",
          name: "completed",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo/.worktrees/completed",
          branch: "feat/completed",
          isolated: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:05Z",
          last_message: null,
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          in_worktree: true,
        },
        {
          ...survivor,
          last_user_message: "Implement the lifecycle refresh fix",
          last_agent_message: "The lifecycle refresh fix is ready",
          agent_activity_at: "2026-01-01T00:00:04Z",
        },
      ];
    });
    await tauri.handle("remove_session", () => {
      const w = window as unknown as { __kanbanSessionRemoved?: boolean };
      w.__kanbanSessionRemoved = true;
      return {
        token: "kanban-removal-token",
        repoPath: "/tmp/demo",
        worktreePath: "/tmp/demo/.worktrees/completed",
        gitCommonDir: "/tmp/demo/.git",
      };
    });

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const completedCard = board.locator(
      '[data-kanban-session-id="completed"]',
    );
    await completedCard.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as done" }).click();
    await expect(
      board.locator(
        'section[aria-label="Done"] [data-kanban-session-id="completed"]',
      ),
    ).toBeVisible();

    await expect(page.getByRole("menu")).toHaveCount(0);
    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^completed worktree/ })
      .first()
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Remove Session", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Remove + delete worktree" })
      .click();

    await expect(
      page.getByText(/Removing completed worktree in \d+s/),
    ).toBeVisible();
    await expect(
      board.locator(
        'section[aria-label="Review"] [data-kanban-session-id="survivor"]',
      ),
    ).toBeVisible();
  });

  test("updates card PR metadata when the PR list refresh discovers a new PR", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("runner", "runner", "working", {
        agent_provider: "codex",
      }),
    ]);
    await tauri.handle("detect_session_statuses", (args) => {
      const ids = Array.isArray((args as { ids?: unknown }).ids)
        ? ((args as { ids: string[] }).ids)
        : [];
      return ids.map((id) => ({
        id,
        status: "working",
        branch: "feat/runner",
        last_message: null,
        last_user_message: null,
        last_agent_message: null,
      }));
    });
    await tauri.handle("list_pull_requests", (args) => {
      const w = window as unknown as {
        __kanbanPrCreated?: boolean;
        __kanbanCurrentPrQueries?: number;
        __kanbanOpenPrRefreshes?: number;
      };
      const pr = {
        number: 77,
        title: "Add kanban PR context",
        state: "OPEN",
        author: "ian",
        head_branch: "feat/runner",
        base_branch: "main",
        url: "https://github.com/im-ian/acorn/pull/77",
        updated_at: "2026-01-01T00:00:00Z",
        is_draft: false,
        checks: null,
        labels: [],
      };
      const created = w.__kanbanPrCreated === true;
      if (args?.query === "head:feat/runner") {
        w.__kanbanCurrentPrQueries = (w.__kanbanCurrentPrQueries ?? 0) + 1;
        return {
          kind: "ok",
          account: "test",
          items: created ? [pr] : [],
        };
      }
      if (args?.state === "open" && !args?.query) {
        w.__kanbanOpenPrRefreshes = (w.__kanbanOpenPrRefreshes ?? 0) + 1;
        return {
          kind: "ok",
          account: "test",
          items: created ? [pr] : [],
        };
      }
      return { kind: "ok", account: "test", items: [] };
    });

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    await expect(board).toBeVisible();
    const runnerCard = board.locator('[data-kanban-session-id="runner"]');
    await expect(runnerCard).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __kanbanCurrentPrQueries?: number;
                }
              ).__kanbanCurrentPrQueries ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    await expect(runnerCard).not.toContainText("PR #77");

    await page.evaluate(() => {
      (window as unknown as { __kanbanPrCreated?: boolean })
        .__kanbanPrCreated = true;
    });
    await page.getByRole("button", { name: "GitHub" }).click();
    const refresh = page.locator("aside").getByRole("button", {
      name: "Refresh",
    });
    await expect(refresh).toBeEnabled();
    await refresh.click();

    await expect(
      runnerCard.getByTestId("workspace-kanban-card-context"),
    ).toContainText("PR #77");
  });

  test("moves a merged PR session to Done after the worktree returns to main", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("merge-runner", "merge runner", "ready", {
        branch: "feat/merge-runner",
        status_reason: "turn_complete",
        last_user_message: "Merge the pull request",
        last_user_message_at: "2026-01-02T00:00:00Z",
        last_agent_message: "Merged and cleaned up the branch",
        agent_activity_at: "2026-01-02T00:10:40Z",
      }),
    ]);
    await tauri.handle("detect_session_statuses", (args) => {
      const ids = Array.isArray((args as { ids?: unknown }).ids)
        ? ((args as { ids: string[] }).ids)
        : [];
      const merged = (
        window as unknown as { __kanbanMergeCompleted?: boolean }
      ).__kanbanMergeCompleted;
      return ids.map((id) => ({
        id,
        status: "ready",
        status_reason: "turn_complete",
        branch: merged ? "main" : "feat/merge-runner",
        last_user_message: "Merge the pull request",
        last_user_message_at: "2026-01-02T00:00:00Z",
        last_agent_message: "Merged and cleaned up the branch",
        agent_activity_at: "2026-01-02T00:10:40Z",
      }));
    });
    await tauri.handle("list_pull_requests", () => {
      const merged = (
        window as unknown as { __kanbanMergeCompleted?: boolean }
      ).__kanbanMergeCompleted;
      return {
        kind: "ok",
        account: "test",
        items: [
          {
            number: 604,
            title: "Keep merged sessions linked",
            state: merged ? "MERGED" : "OPEN",
            author: "ian",
            head_branch: "feat/merge-runner",
            base_branch: "main",
            url: "https://github.com/im-ian/acorn/pull/604",
            updated_at: "2026-01-02T00:10:13Z",
            closed_at: merged ? "2026-01-02T00:10:13Z" : null,
            merged_at: merged ? "2026-01-02T00:10:13Z" : null,
            is_draft: false,
            checks: null,
            labels: [],
          },
        ],
      };
    });

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const card = board.locator('[data-kanban-session-id="merge-runner"]');
    await expect(
      board.locator(
        'section[aria-label="Review"] [data-kanban-session-id="merge-runner"]',
      ),
    ).toBeVisible();
    await expect(card.getByTestId("workspace-kanban-card-pr")).toContainText(
      "#604",
    );

    await page.evaluate(() => {
      (
        window as unknown as { __kanbanMergeCompleted?: boolean }
      ).__kanbanMergeCompleted = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(
      board.locator(
        'section[aria-label="Done"] [data-kanban-session-id="merge-runner"]',
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText("main");
    await expect(card.getByTestId("workspace-kanban-card-pr")).toContainText(
      "#604",
    );
  });

  test("tracks a PR in Panes before Kanban is opened after merge", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("pane-merge-runner", "pane merge runner", "ready", {
        branch: "feat/pane-merge-runner",
        status_reason: "turn_complete",
        last_user_message: "Merge from the pane view",
        last_user_message_at: "2026-01-02T00:00:00Z",
        last_agent_message: "Merged and returned to main",
        agent_activity_at: "2026-01-02T00:10:40Z",
      }),
    ]);
    await tauri.handle("detect_session_statuses", (args) => {
      const ids = Array.isArray((args as { ids?: unknown }).ids)
        ? ((args as { ids: string[] }).ids)
        : [];
      const merged = (
        window as unknown as { __paneMergeCompleted?: boolean }
      ).__paneMergeCompleted;
      return ids.map((id) => ({
        id,
        status: "ready",
        status_reason: "turn_complete",
        branch: merged ? "main" : "feat/pane-merge-runner",
        last_user_message: "Merge from the pane view",
        last_user_message_at: "2026-01-02T00:00:00Z",
        last_agent_message: "Merged and returned to main",
        agent_activity_at: "2026-01-02T00:10:40Z",
      }));
    });
    await tauri.handle("list_pull_requests", () => {
      const w = window as unknown as {
        __paneMergeCompleted?: boolean;
        __panePrQueries?: number;
      };
      w.__panePrQueries = (w.__panePrQueries ?? 0) + 1;
      const merged = w.__paneMergeCompleted === true;
      return {
        kind: "ok",
        account: "test",
        items: [
          {
            number: 605,
            title: "Track PRs outside Kanban",
            state: merged ? "MERGED" : "OPEN",
            author: "ian",
            head_branch: "feat/pane-merge-runner",
            base_branch: "main",
            url: "https://github.com/im-ian/acorn/pull/605",
            updated_at: "2026-01-02T00:10:13Z",
            closed_at: merged ? "2026-01-02T00:10:13Z" : null,
            merged_at: merged ? "2026-01-02T00:10:13Z" : null,
            is_draft: false,
            checks: null,
            labels: [],
          },
        ],
      };
    });

    await page.goto("/");
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Panes",
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as { __panePrQueries?: number }
              ).__panePrQueries ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    await page.evaluate(() => {
      (
        window as unknown as { __paneMergeCompleted?: boolean }
      ).__paneMergeCompleted = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(
      page.getByRole("button", { name: /pane merge runner main/ }),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const card = board.locator(
      'section[aria-label="Done"] [data-kanban-session-id="pane-merge-runner"]',
    );
    await expect(card).toBeVisible();
    await expect(card.getByTestId("workspace-kanban-card-pr")).toContainText(
      "#605",
    );
  });

  test("groups active workspace sessions by lifecycle and opens a card terminal popover", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("needs-review", "needs-review", "waiting_for_input", {
        agent_provider: "claude",
      }),
      session("runner", "runner", "working", {
        agent_provider: "codex",
      }),
      session("alpha", "alpha", "ready", {
        updated_at: "2026-01-01T00:00:01Z",
      }),
      session("shell", "shell", "ready", {
        branch: "shell",
      }),
      session("broken", "broken", "errored", {
        agent_provider: "codex",
        last_message: "Tests failed in popover state handling.",
        worktree_path:
          "/tmp/demo/.worktrees/broken-session-with-a-very-long-worktree-directory-name-that-should-wrap-inside-the-card-tooltip",
      }),
    ]);
    await tauri.handle("detect_session_statuses", (args) => {
      const ids = Array.isArray((args as { ids?: unknown }).ids)
        ? ((args as { ids: string[] }).ids)
        : [];
      const statuses: Record<string, string> = {
        "needs-review": "waiting_for_input",
        runner: "working",
        alpha: "ready",
        shell: "ready",
        broken: "errored",
      };
      return ids.map((id) => {
        const update: Record<string, unknown> = {
          id,
          status: statuses[id] ?? "ready",
          branch: id === "shell" ? "shell" : `feat/${id}`,
          last_message:
            id === "broken"
              ? "Updated from status polling."
              : null,
          last_user_message:
            id === "broken" ? "Please check the failed tests." : null,
          last_agent_message:
            id === "broken" ? "Updated from status polling." : null,
        };
        if (id === "runner") {
          update.git_context_path = "/tmp/demo-live-worktree";
          update.active_processes = [
            { pid: 11, name: "codex", depth: 2 },
            { pid: 12, name: "rg", depth: 3 },
            { pid: 13, name: "node", depth: 3 },
          ];
        }
        return update;
      });
    });
    await tauri.handle("list_pull_requests", (args) => {
      if (args?.query === "head:shell") {
        return {
          kind: "ok",
          account: "test",
          items: [
            {
              number: 42,
              title: "Add kanban overlay header affordances",
              state: "OPEN",
              author: "ian",
              head_branch: "shell",
              base_branch: "main",
              url: "https://github.com/im-ian/acorn/pull/42",
              updated_at: "2026-01-01T00:00:00Z",
              is_draft: false,
              checks: null,
              labels: [],
            },
          ],
        };
      }
      if (args?.query !== "head:feat/runner") {
        return { kind: "ok", items: [], account: "test" };
      }
      return {
        kind: "ok",
        account: "test",
        items: [
          {
            number: 77,
            title: "Add kanban PR context",
            state: "OPEN",
            author: "ian",
            head_branch: "feat/runner",
            base_branch: "main",
            url: "https://github.com/im-ian/acorn/pull/77",
            updated_at: "2026-01-01T00:00:00Z",
            is_draft: false,
            checks: null,
            labels: [],
          },
        ],
      };
    });
    await tauri.handle("plugin:opener|open_url", (args) => {
      const w = window as unknown as {
        __openUrlCalls?: Array<{ url?: string }>;
      };
      w.__openUrlCalls = w.__openUrlCalls ?? [];
      w.__openUrlCalls.push(args as { url?: string });
      return null;
    });

    await page.goto("/");

    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Panes",
    );
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    await expect(board).toBeVisible();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    await expect(page.getByTestId("sidebar-kanban-workspace-row")).toHaveCount(
      0,
    );
    const createSessionButton = board.getByRole("button", {
      name: "Create session",
    });
    await expect(createSessionButton).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Reset sizes" }),
    ).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Equalize sizes" }),
    ).toBeVisible();
    await createSessionButton.click();
    const newSessionMenuItem = page.getByRole("menuitem", {
      name: "New session",
    });
    await expect(newSessionMenuItem).toBeVisible();
    await expect(newSessionMenuItem.locator("kbd")).toHaveText(
      /^(⌘T|Ctrl\+T)$/,
    );
    await expect(
      page.getByRole("menuitem", { name: "New worktree session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New chat session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New worktree session" }).locator("kbd"),
    ).not.toBeEmpty();
    await expect(
      page.getByRole("menuitem", { name: "New chat session" }).locator("kbd"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "New control session" }).locator("kbd"),
    ).not.toBeEmpty();
    await page.keyboard.press("Escape");

    await expect(
      board.getByRole("heading", { name: "Waiting" }),
    ).toBeVisible();
    await expect(board.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(board.getByRole("heading", { name: "Working" })).toBeVisible();
    await expect(board.getByRole("heading", { name: "Idle" })).toBeVisible();
    await expect(
      board.getByRole("heading", { name: "Done" }),
    ).toBeVisible();
    await expect(
      board.locator("section > header h2"),
    ).toHaveText(["Idle", "Working", "Waiting", "Review", "Done"]);

    const filterInput = board.getByLabel("Filter sessions");
    await expect(filterInput).toBeVisible();
    await filterInput.fill("shell");
    await expect(
      board.getByRole("button", { name: "Open shell" }),
    ).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Open runner" }),
    ).toBeHidden();
    await filterInput.fill("");

    await board.getByLabel("Sort sessions").selectOption("name-asc");
    const idleCards = board.locator(
      'section[aria-label="Idle"] [data-testid="workspace-kanban-card"]',
    );
    await expect(idleCards).toHaveCount(2);
    await expect(idleCards.nth(0)).toHaveAttribute(
      "data-kanban-session-id",
      "alpha",
    );
    await expect(idleCards.nth(1)).toHaveAttribute(
      "data-kanban-session-id",
      "shell",
    );

    await expect(
      board.getByRole("button", { name: "Open needs-review" }),
    ).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Open runner" }),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="needs-review"]')
        .locator('[data-kanban-agent-icon="claude"]'),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="broken"]')
        .locator('[data-kanban-agent-icon="codex"]'),
    ).toBeVisible();
    const brokenCard = board.locator('[data-kanban-session-id="broken"]');
    await expect(
      brokenCard.getByTestId("workspace-kanban-card-meta"),
    ).toContainText("feat/broken");
    await expect(brokenCard).not.toContainText("Error");
    await expect(
      brokenCard.getByTestId("workspace-kanban-card-last-message"),
    ).toContainText("Updated from status polling.");
    await expect(
      brokenCard.getByTestId("workspace-kanban-card-user-message"),
    ).toContainText("Please check the failed tests.");
    await expect(
      brokenCard.getByTestId("workspace-kanban-card-agent-message"),
    ).toContainText("Updated from status polling.");
    await brokenCard.hover();
    const cardTooltip = page.getByRole("tooltip");
    await expect(cardTooltip).toBeVisible();
    await expect(cardTooltip).toContainText("Title");
    await expect(cardTooltip).toContainText("broken");
    await expect(cardTooltip).toContainText("Last user message");
    await expect(cardTooltip).toContainText("Please check the failed tests.");
    await expect(cardTooltip).toContainText("Last agent message");
    await expect(cardTooltip).toContainText("Updated from status polling.");
    await expect(cardTooltip).toContainText("Branch");
    await expect(cardTooltip).toContainText("feat/broken");
    await expect(cardTooltip).toContainText("Worktree");
    await expect(cardTooltip).toContainText(
      "/tmp/demo/.worktrees/broken-session-with-a-very-long-worktree-directory-name-that-should-wrap-inside-the-card-tooltip",
    );
    const tooltipMetrics = await cardTooltip.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const node = el as HTMLElement;
      return {
        clientWidth: node.clientWidth,
        left: rect.left,
        right: rect.right,
        scrollWidth: node.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(tooltipMetrics.left).toBeGreaterThanOrEqual(0);
    expect(tooltipMetrics.right).toBeLessThanOrEqual(
      tooltipMetrics.viewportWidth,
    );
    expect(tooltipMetrics.scrollWidth).toBeLessThanOrEqual(
      tooltipMetrics.clientWidth + 1,
    );
    await page.mouse.move(0, 0);
    await expect(cardTooltip).toHaveCount(0);
    await expect(
      board
        .locator('[data-kanban-session-id="runner"]')
        .locator('[data-kanban-agent-icon="codex"]'),
    ).toBeVisible();
    const runnerCard = board.locator('[data-kanban-session-id="runner"]');
    const runnerContext = runnerCard.getByTestId(
      "workspace-kanban-card-context",
    );
    await expect(runnerContext).toHaveText(/PR #77\s*·\s*codex, rg \+1/);
    const runnerPrButton = runnerContext.getByRole("button", {
      name: "Open PR #77",
    });
    await expect(runnerPrButton).toBeVisible();
    await expect(runnerPrButton).toHaveClass(/text-emerald-400/);
    await runnerPrButton.click();
    const openedUrls = await page.evaluate(
      () =>
        (
          (window as unknown as {
            __openUrlCalls?: Array<{ url?: string }>;
          }).__openUrlCalls ?? []
        ).map((call) => call.url),
    );
    expect(openedUrls).toEqual([
      "https://github.com/im-ian/acorn/pull/77",
    ]);
    await runnerCard.hover();
    const runnerTooltip = page.getByRole("tooltip");
    await expect(runnerTooltip).toContainText("Open PR");
    await expect(runnerTooltip).toContainText("#77 Add kanban PR context");
    await expect(runnerTooltip).toContainText("Processes");
    await expect(runnerTooltip).toContainText("codex, rg, node");
    await page.mouse.move(0, 0);
    await expect(runnerTooltip).toHaveCount(0);
    await expect(
      board
        .locator('[data-kanban-session-id="shell"]')
        .locator('[data-kanban-session-icon="terminal"]'),
    ).toBeVisible();
    const shellCard = board.locator('[data-kanban-session-id="shell"]');
    await expect(
      shellCard.getByTestId("workspace-kanban-card-branch"),
    ).toHaveText("shell");
    await expect(
      shellCard.getByTestId("workspace-kanban-card-worktree"),
    ).toHaveText("shell");
    const shellCardWidths = await board
      .locator('[data-kanban-session-id="shell"]')
      .evaluate((button) => {
        const wrapper = button.parentElement;
        const list = wrapper?.parentElement;
        if (!wrapper || !list) {
          throw new Error("missing kanban card wrapper");
        }
        const listStyle = window.getComputedStyle(list);
        const listContentWidth =
          list.getBoundingClientRect().width -
          parseFloat(listStyle.paddingLeft) -
          parseFloat(listStyle.paddingRight);
        return {
          card: button.getBoundingClientRect().width,
          wrapper: wrapper.getBoundingClientRect().width,
          listContent: listContentWidth,
        };
      });
    expect(
      Math.abs(shellCardWidths.card - shellCardWidths.wrapper),
    ).toBeLessThan(1);
    expect(
      Math.abs(shellCardWidths.wrapper - shellCardWidths.listContent),
    ).toBeLessThan(1);

    const kanbanScroll = page.getByTestId("workspace-kanban-scroll");
    const kanbanColumnWidths = () =>
      board
        .locator("[data-kanban-column-stage]")
        .evaluateAll((columns) =>
          columns.map((column) => column.getBoundingClientRect().width),
        );
    const kanbanFitMetrics = () =>
      board
        .locator("[data-kanban-column-stage]")
        .evaluateAll((columns) => {
          const firstColumn = columns[0];
          if (!firstColumn) throw new Error("missing kanban columns");
          const row = firstColumn.parentElement?.parentElement;
          if (!row) throw new Error("missing kanban row");
          const rowStyle = window.getComputedStyle(row);
          const paddingX =
            parseFloat(rowStyle.paddingLeft) +
            parseFloat(rowStyle.paddingRight);
          const handleWidth = Array.from(
            row.querySelectorAll(
              '[data-testid="workspace-kanban-column-resize-handle"]',
            ),
          ).reduce(
            (total, handle) => total + handle.getBoundingClientRect().width,
            0,
          );
          const columnWidths = columns.map(
            (column) => column.getBoundingClientRect().width,
          );
          const usedWidth =
            columnWidths.reduce((total, width) => total + width, 0) +
            handleWidth +
            paddingX;
          return {
            columnWidths,
            unusedWidth: row.getBoundingClientRect().width - usedWidth,
          };
        });
    const columnWidthSpread = (widths: number[]) =>
      Math.max(...widths) - Math.min(...widths);
    const idleColumn = board.locator('[data-kanban-column-stage="idle"]');
    const waitingColumn = board.locator(
      '[data-kanban-column-stage="waiting"]',
    );
    const idleResizeHandle = board
      .locator('[data-kanban-resize-stage="idle"]');
    await expect(idleResizeHandle).toBeVisible();
    const initialFit = await kanbanFitMetrics();
    expect(columnWidthSpread(initialFit.columnWidths)).toBeLessThan(1);
    expect(Math.abs(initialFit.unusedWidth)).toBeLessThan(1);
    const [idleWidthBefore, waitingWidthBefore, scrollWidthBefore] =
      await Promise.all([
        idleColumn.evaluate((column) => column.getBoundingClientRect().width),
        waitingColumn.evaluate((column) =>
          column.getBoundingClientRect().width,
        ),
        kanbanScroll.evaluate((scroll) => scroll.scrollWidth),
      ]);
    await idleResizeHandle.focus();
    for (let i = 0; i < 6; i += 1) {
      await idleResizeHandle.press("Shift+ArrowRight");
    }
    const minimumResizeDelta = 100;
    await expect
      .poll(async () =>
        idleColumn.evaluate((column) => column.getBoundingClientRect().width),
      )
      .toBeGreaterThan(idleWidthBefore + minimumResizeDelta);
    const [idleWidthAfter, waitingWidthAfter, scrollWidthAfter] =
      await Promise.all([
        idleColumn.evaluate((column) => column.getBoundingClientRect().width),
        waitingColumn.evaluate((column) =>
          column.getBoundingClientRect().width,
        ),
        kanbanScroll.evaluate((scroll) => scroll.scrollWidth),
      ]);
    expect(
      waitingWidthAfter,
    ).toBeLessThanOrEqual(waitingWidthBefore);
    expect(scrollWidthAfter).toBeGreaterThanOrEqual(scrollWidthBefore);

    // Equalize distributes the mean width across columns, so every column ends
    // up the same width as the others (distinct from reset, which restores the
    // default responsive basis) and lands between the resized and untouched
    // widths.
    await board.getByRole("button", { name: "Equalize sizes" }).click();
    await expect
      .poll(async () => {
        const metrics = await kanbanFitMetrics();
        return Math.max(
          columnWidthSpread(metrics.columnWidths),
          Math.abs(metrics.unusedWidth),
        );
      })
      .toBeLessThan(1);
    const equalizedWidths = await kanbanColumnWidths();
    const equalizedWidth = equalizedWidths[0] ?? 0;
    expect(equalizedWidth).toBeLessThan(idleWidthAfter);
    expect(equalizedWidth).toBeGreaterThan(waitingWidthAfter);

    await board.getByRole("button", { name: "Reset sizes" }).click();
    await expect
      .poll(async () => {
        const metrics = await kanbanFitMetrics();
        return Math.max(
          columnWidthSpread(metrics.columnWidths),
          Math.abs(metrics.unusedWidth),
        );
      })
      .toBeLessThan(1);

    const shellMenuTarget = board.getByRole("button", { name: "Open shell" });
    const shellMenuTargetBox = await shellMenuTarget.boundingBox();
    expect(shellMenuTargetBox).not.toBeNull();
    if (!shellMenuTargetBox) throw new Error("missing shell card");
    await shellMenuTarget.dispatchEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: shellMenuTargetBox.x + shellMenuTargetBox.width / 2,
      clientY: shellMenuTargetBox.y + shellMenuTargetBox.height / 2,
    });
    await expect(
      page.getByRole("menuitem", { name: "Open shell" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Rename" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Regenerate Name" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Open Work Summary" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Silence Notifications" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Reveal in Finder" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Remove Session" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await board.getByRole("button", { name: "Open shell" }).click();
    const shellPopover = page.getByTestId("kanban-terminal-popover");
    await expect(shellPopover).toBeVisible();
    await expect(
      shellPopover.getByRole("heading", { name: "shell" }),
    ).toBeVisible();
    const shellPopoverPrButton = shellPopover.getByRole("button", {
      name: /Open PR #42: Add kanban overlay header affordances/,
    });
    await expect(shellPopoverPrButton).toBeVisible();
    await expect(page.getByTestId("terminal-popover-body")).toBeVisible();
    await expect(
      page
        .getByTestId("terminal-popover-body")
        .locator('[data-acorn-terminal-slot="shell"] .acorn-terminal-shell'),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("terminal-popover-body")
        .locator(".xterm-helper-textarea"),
    ).toBeFocused();
    await shellPopoverPrButton.click();
    const openedUrlsAfterPopoverPr = await page.evaluate(
      () =>
        (
          (window as unknown as {
            __openUrlCalls?: Array<{ url?: string }>;
          }).__openUrlCalls ?? []
        ).map((call) => call.url),
    );
    expect(openedUrlsAfterPopoverPr).toEqual([
      "https://github.com/im-ian/acorn/pull/77",
      "https://github.com/im-ian/acorn/pull/42",
    ]);
    const headerHandle = page.getByTestId(
      "kanban-terminal-popover-drag-handle",
    );
    const headerBox = await headerHandle.boundingBox();
    expect(headerBox).not.toBeNull();
    if (!headerBox) throw new Error("missing popover header");
    await headerHandle.dispatchEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: headerBox.x + headerBox.width / 2,
      clientY: headerBox.y + headerBox.height / 2,
    });
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Regenerate Name" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Open Work Summary" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Silence Notifications" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Reveal in Finder" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const titleInput = page.getByTestId(
      "kanban-terminal-popover-title-input",
    );
    await expect(titleInput).toBeVisible();
    await titleInput.press("Escape");
    await expect(
      shellPopover.getByRole("heading", { name: "shell" }),
    ).toBeVisible();
    const closePopoverButton = shellPopover.getByRole("button", {
      name: "Close",
    });
    await closePopoverButton.hover();
    const closePopoverTooltip = page.getByRole("tooltip");
    await expect(closePopoverTooltip).toContainText("Close");
    await expect(closePopoverTooltip.locator("kbd")).toHaveText(
      /^(⌘W|Ctrl\+W)$/,
    );
    await page.mouse.move(0, 0);
    await expect(
      page.getByTestId("kanban-terminal-popover-reset-position"),
    ).toBeVisible();
    await expect(
      page.getByTestId("kanban-terminal-popover-reset-size"),
    ).toBeVisible();
    const shellPopoverBoxBefore = await shellPopover.boundingBox();
    expect(shellPopoverBoxBefore).not.toBeNull();
    if (!shellPopoverBoxBefore) throw new Error("missing shell popover");
    const resizeHandle = page.getByTestId("kanban-terminal-popover-resize");
    await expect(resizeHandle).toBeVisible();
    const resizeHandleBox = await resizeHandle.boundingBox();
    expect(resizeHandleBox).not.toBeNull();
    if (!resizeHandleBox) throw new Error("missing popover resize handle");
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2 + 72,
      resizeHandleBox.y + resizeHandleBox.height / 2 + 44,
    );
    await page.mouse.up();
    const shellPopoverBoxAfter = await shellPopover.boundingBox();
    expect(shellPopoverBoxAfter?.width ?? 0).toBeGreaterThan(
      shellPopoverBoxBefore.width + 40,
    );
    expect(shellPopoverBoxAfter?.height ?? 0).toBeGreaterThan(
      shellPopoverBoxBefore.height + 24,
    );
    const expandButton = page.getByTestId("kanban-terminal-popover-expand");
    await expect(expandButton).toHaveAttribute(
      "aria-label",
      "Expand terminal",
    );
    await expandButton.hover();
    await expect(
      page.getByRole("tooltip", { name: "Expand terminal" }),
    ).toBeVisible();
    await expandButton.click();
    await expect(expandButton).toHaveAttribute(
      "aria-label",
      "Restore terminal size",
    );
    await expandButton.hover();
    await expect(
      page.getByRole("tooltip", { name: "Restore terminal size" }),
    ).toBeVisible();
    await expect(resizeHandle).toHaveCount(0);
    const expandedPopoverBox = await shellPopover.boundingBox();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(expandedPopoverBox?.width ?? 0).toBeGreaterThan(
      viewport.width - 24,
    );
    expect(expandedPopoverBox?.height ?? 0).toBeGreaterThan(
      viewport.height - 24,
    );
    await expandButton.click();
    await expect(expandButton).toHaveAttribute(
      "aria-label",
      "Expand terminal",
    );
    await expect(resizeHandle).toBeVisible();
    const restoredPopoverBox = await shellPopover.boundingBox();
    expect(
      Math.abs((restoredPopoverBox?.width ?? 0) - shellPopoverBoxAfter.width),
    ).toBeLessThan(2);
    expect(
      Math.abs((restoredPopoverBox?.height ?? 0) - shellPopoverBoxAfter.height),
    ).toBeLessThan(2);
    const dragHandle = page.getByTestId("kanban-terminal-popover-drag-handle");
    const popoverBoxBeforeDrag = await shellPopover.boundingBox();
    const dragHandleBox = await dragHandle.boundingBox();
    expect(popoverBoxBeforeDrag).not.toBeNull();
    expect(dragHandleBox).not.toBeNull();
    if (!popoverBoxBeforeDrag || !dragHandleBox) {
      throw new Error("missing draggable terminal popover");
    }
    const dragViewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const dragDeltaX =
      dragViewport.width -
        (popoverBoxBeforeDrag.x + popoverBoxBeforeDrag.width) >
      64
        ? 48
        : -48;
    const dragDeltaY =
      dragViewport.height -
        (popoverBoxBeforeDrag.y + popoverBoxBeforeDrag.height) >
      48
        ? 32
        : -32;
    const dragStartX = dragHandleBox.x + Math.min(96, dragHandleBox.width / 2);
    const dragStartY = dragHandleBox.y + dragHandleBox.height / 2;
    await page.mouse.move(dragStartX, dragStartY);
    await page.mouse.down();
    await page.mouse.move(dragStartX + dragDeltaX, dragStartY + dragDeltaY);
    await page.mouse.up();
    const popoverBoxAfterDrag = await shellPopover.boundingBox();
    expect(
      Math.abs((popoverBoxAfterDrag?.x ?? 0) - popoverBoxBeforeDrag.x),
    ).toBeGreaterThan(24);
    expect(
      Math.abs((popoverBoxAfterDrag?.y ?? 0) - popoverBoxBeforeDrag.y),
    ).toBeGreaterThan(16);

    await page.getByTestId("kanban-terminal-popover-reset-position").click();
    const popoverBoxAfterPositionReset = await shellPopover.boundingBox();
    expect(
      Math.abs((popoverBoxAfterPositionReset?.x ?? 0) - popoverBoxBeforeDrag.x),
    ).toBeLessThan(4);
    expect(
      Math.abs((popoverBoxAfterPositionReset?.y ?? 0) - popoverBoxBeforeDrag.y),
    ).toBeLessThan(4);

    await page.getByTestId("kanban-terminal-popover-reset-size").click();
    const popoverBoxAfterSizeReset = await shellPopover.boundingBox();
    expect(
      Math.abs((popoverBoxAfterSizeReset?.width ?? 0) - 560),
    ).toBeLessThan(2);
    expect(
      Math.abs((popoverBoxAfterSizeReset?.height ?? 0) - 420),
    ).toBeLessThan(2);

    await board.getByRole("button", { name: "Open broken" }).click();

    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();
    await expect(
      popover.getByRole("heading", { name: "broken" }),
    ).toBeVisible();
    await expect(
      popover.locator('[data-console-agent-icon="codex"]'),
    ).toBeVisible();
    await expect(page.getByTestId("terminal-popover-body")).toBeVisible();
    const popoverBox = await popover.boundingBox();
    expect(popoverBox?.x).toBeGreaterThanOrEqual(0);
    expect((popoverBox?.x ?? 0) + (popoverBox?.width ?? 0)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
    await expect(
      page
        .getByTestId("terminal-popover-body")
        .locator('[data-acorn-terminal-slot="broken"] .acorn-terminal-shell'),
    ).toBeVisible();
  });

  test("moves between cards with arrow keys and closes the popover from the keyboard", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("alpha", "alpha", "ready", {
        updated_at: "2026-01-01T00:00:01Z",
      }),
      session("shell", "shell", "ready"),
      session("needs-review", "needs-review", "waiting_for_input"),
      session("runner", "runner", "working", {
        agent_provider: "codex",
      }),
      session("broken", "broken", "errored"),
    ]);

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    await expect(board).toBeVisible();
    await board.getByLabel("Sort sessions").selectOption("name-asc");

    const alpha = board.getByRole("button", { name: "Open alpha" });
    const shell = board.getByRole("button", { name: "Open shell" });
    const needsReview = board.getByRole("button", {
      name: "Open needs-review",
    });
    const runner = board.getByRole("button", { name: "Open runner" });
    const broken = board.getByRole("button", { name: "Open broken" });

    await alpha.focus();
    await expect(alpha).toBeFocused();

    await alpha.press("ArrowDown");
    await expect(shell).toBeFocused();

    await shell.press("ArrowRight");
    await expect(runner).toBeFocused();

    await runner.press("ArrowRight");
    await expect(broken).toBeFocused();

    await broken.press("ArrowDown");
    await expect(needsReview).toBeFocused();

    await needsReview.press("ArrowLeft");
    await expect(runner).toBeFocused();

    await runner.press("Enter");
    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();
    await expect(
      popover.getByRole("heading", { name: "runner" }),
    ).toBeVisible();

    await pressHotkey(page, { mod: true, key: "w" });
    await expect(popover).toHaveCount(0);
    await expect(runner).toBeFocused();
  });

  test("card context menu and terminal popover header can rename a session", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "rename-me",
          name: "rename-me",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo/.worktrees/rename-me",
          branch: "feat/rename-me",
          isolated: false,
          project_scoped: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          mode: "terminal",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("rename_session", (args) => {
      const w = window as unknown as {
        __renameCalls?: unknown[];
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__renameCalls = w.__renameCalls ?? [];
      w.__renameCalls.push(args);
      const a = args as { id: string; name: string };
      const current = w.__sessions?.[0] ?? {};
      const updated = { ...current, id: a.id, name: a.name };
      w.__sessions = [updated];
      return updated;
    });

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const card = board.getByRole("button", { name: "Open rename-me" });
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

    const input = board.locator("[data-kanban-card-rename-input]");
    await expect(input).toBeFocused();
    await input.fill("renamed from kanban");
    await input.press("Enter");

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __renameCalls?: unknown[] })
              .__renameCalls?.length ?? 0,
        ),
      )
      .toBe(1);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __renameCalls?: unknown[] }).__renameCalls,
    )) as Array<{ id: string; name: string }>;
    expect(calls[0]).toEqual({
      id: "rename-me",
      name: "renamed from kanban",
    });
    await expect(
      board.getByRole("button", { name: "Open renamed from kanban" }),
    ).toBeVisible();

    await board
      .getByRole("button", { name: "Open renamed from kanban" })
      .click();
    const popover = page.getByTestId("kanban-terminal-popover");
    const heading = popover.getByRole("heading", {
      name: "renamed from kanban",
    });
    await heading.dblclick();
    const popoverTitleInput = page.getByTestId(
      "kanban-terminal-popover-title-input",
    );
    await expect(popoverTitleInput).toBeFocused();
    await popoverTitleInput.fill("renamed from popover");
    await popoverTitleInput.press("Enter");

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __renameCalls?: unknown[] })
              .__renameCalls?.length ?? 0,
        ),
      )
      .toBe(2);
    await expect(
      popover.getByRole("heading", { name: "renamed from popover" }),
    ).toBeVisible();
  });

  test("uses the configured default workspace mode on first project load", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: { defaultWorkspaceViewMode: "kanban" },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("default-kanban", "default-kanban", "ready"),
    ]);

    await page.goto("/");

    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
  });

  test("uses configured kanban terminal popover placement", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: {
            defaultWorkspaceViewMode: "kanban",
            kanbanTerminalPopoverPlacement: "center",
            kanbanTerminalPopoverDefaultSize: "custom",
          },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("centered", "centered", "ready"),
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Open centered" }).click();

    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("missing centered popover");
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(
      8,
    );
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(
      8,
    );
  });

  test("keeps a terminal popover open while editing settings", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("settings-popover", "settings-popover", "ready"),
    ]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();
    await page
      .getByTestId("workspace-kanban")
      .getByRole("button", { name: "Open settings-popover" })
      .click();

    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();

    await pressHotkey(page, { mod: true, key: "," });
    const modal = page.getByRole("dialog", { name: /^(Settings|설정)$/ });
    await expect(modal).toBeVisible();

    await modal
      .getByRole("combobox", { name: "Default workspace mode" })
      .click();
    await page.getByRole("option", { name: "Kanban" }).click();
    await expect(popover).toBeVisible();

    await modal.getByText("Center of screen", { exact: true }).click();
    await modal.getByText("Full screen", { exact: true }).click();
    await expect(popover).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          const settings = raw ? JSON.parse(raw) : null;
          return {
            defaultMode:
              settings?.interface?.defaultWorkspaceViewMode ?? null,
            placement:
              settings?.interface?.kanbanTerminalPopoverPlacement ?? null,
            defaultSize:
              settings?.interface?.kanbanTerminalPopoverDefaultSize ?? null,
          };
        }),
      )
      .toEqual({
        defaultMode: "kanban",
        placement: "center",
        defaultSize: "fullscreen",
      });
  });

  test("uses configured fullscreen kanban terminal popover size", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: {
            defaultWorkspaceViewMode: "kanban",
            kanbanTerminalPopoverPlacement: "card",
            kanbanTerminalPopoverDefaultSize: "fullscreen",
          },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("fullscreen", "fullscreen", "ready"),
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Open fullscreen" }).click();

    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();
    await expect(
      page.getByTestId("kanban-terminal-popover-expand"),
    ).toHaveAttribute("aria-label", "Restore terminal size");
    await expect(page.getByTestId("kanban-terminal-popover-resize")).toHaveCount(
      0,
    );
    const box = await popover.boundingBox();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(box?.width ?? 0).toBeGreaterThan(viewport.width - 24);
    expect(box?.height ?? 0).toBeGreaterThan(viewport.height - 24);
  });

  test("restores kanban or pane mode per project", async ({ page, tauri }) => {
    const alpha = project("/tmp/alpha", "alpha", 0);
    const beta = project("/tmp/beta", "beta", 1);
    await tauri.respond("list_projects", [alpha, beta]);
    await tauri.respond("list_sessions", [
      session("alpha-session", "alpha-session", "ready", {
        repo_path: "/tmp/alpha",
        worktree_path: "/tmp/alpha/.worktrees/alpha-session",
      }),
      session("beta-session", "beta-session", "ready", {
        repo_path: "/tmp/beta",
        worktree_path: "/tmp/beta/.worktrees/beta-session",
      }),
    ]);

    await page.goto("/");

    const modeSelect = page.getByTestId("workspace-view-status");
    await expect(modeSelect).toContainText("Panes");
    await modeSelect.click();
    await page.getByRole("option", { name: "Kanban" }).click();
    await expect(modeSelect).toContainText("Kanban");
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();

    await page.getByRole("button", { name: "Project beta" }).click();
    await expect(modeSelect).toContainText("Panes");
    await expect(page.getByTestId("workspace-kanban")).toHaveCount(0);

    await page.getByRole("button", { name: "Project alpha" }).click();
    await expect(modeSelect).toContainText("Kanban");
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
  });

  test("restores kanban or pane mode between project and instant sessions", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("project-session", "project", "ready", {
        project_scoped: true,
        worktree_path: "/tmp/demo",
      }),
      session("instant-session", "instant", "ready", {
        project_scoped: false,
        worktree_path: "/tmp/demo",
      }),
    ]);

    await page.goto("/");

    const modeSelect = page.getByTestId("workspace-view-status");
    await page.getByRole("button", { name: "project Close session" }).click();
    await expect(page.locator("footer")).toContainText("feat/project-session");
    await expect(modeSelect).toContainText("Panes");
    await modeSelect.click();
    await page.getByRole("option", { name: "Kanban" }).click();
    await expect(modeSelect).toContainText("Kanban");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("acorn-workspaces");
          return raw
            ? JSON.parse(raw).state.workspaces["/tmp/demo"]?.viewMode
            : null;
        }),
      )
      .toBe("kanban");

    const instantArea = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    const instantSession = instantArea.getByRole("button", {
      name: /^instant\b/,
    });
    const clickInstantSession = async () => {
      const box = await instantSession.boundingBox();
      if (!box) throw new Error("instant session row is not visible");
      await page.mouse.click(box.x + 20, box.y + box.height / 2);
    };
    await clickInstantSession();
    await expect(page.locator("footer")).toContainText("feat/instant-session");
    await modeSelect.click();
    await page.getByRole("option", { name: "Panes" }).click();
    await expect(modeSelect).toContainText("Panes");
    await expect(page.getByTestId("workspace-kanban")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("acorn-workspaces");
          const workspace = raw
            ? JSON.parse(raw).state.workspaces["/tmp/demo"]
            : null;
          return workspace
            ? {
                viewMode: workspace.viewMode,
                localViewMode: workspace.localViewMode,
              }
            : null;
        }),
      )
      .toEqual({ viewMode: "kanban", localViewMode: "panes" });

    await page.getByRole("button", { name: "project Close session" }).click();
    await expect(page.locator("footer")).toContainText("feat/project-session");
    await expect(modeSelect).toContainText("Kanban");
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();

    await clickInstantSession();
    await expect(page.locator("footer")).toContainText("feat/instant-session");
    await expect(modeSelect).toContainText("Panes");
    await expect(page.getByTestId("workspace-kanban")).toHaveCount(0);
  });

  test("switches mode after focusing the empty instant sessions area", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: { defaultWorkspaceViewMode: "kanban" },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("project-session", "project", "ready", {
        project_scoped: true,
        worktree_path: "/tmp/demo",
      }),
    ]);

    await page.goto("/");

    const modeSelect = page.getByTestId("workspace-view-status");
    await expect(modeSelect).toContainText("Kanban");
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();

    const instantArea = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    await instantArea
      .getByText("Double-click to start an instant session.")
      .click();
    await modeSelect.click();
    await page.getByRole("option", { name: "Panes" }).click();

    await expect(modeSelect).toContainText("Panes");
    await expect(page.getByTestId("workspace-kanban")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("acorn-workspaces");
          return raw
            ? JSON.parse(raw).state.workspaces["/tmp/demo"]?.viewMode
            : null;
        }),
      )
      .toBe("kanban");
  });

  test("creates regular and worktree sessions from the kanban toolbar", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "seed",
          name: "seed",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          mode: "terminal",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = args as Record<string, unknown>;
      const w = window as unknown as {
        __createSessionCalls?: Array<Record<string, unknown>>;
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(input);
      const id = `created-${w.__createSessionCalls.length}`;
      const repoPath =
        typeof input.repoPath === "string" ? input.repoPath : "/tmp/demo";
      const cwdPath =
        typeof input.cwdPath === "string" ? input.cwdPath : repoPath;
      const isolated = input.isolated === true;
      const session = {
        id,
        name: typeof input.name === "string" ? input.name : id,
        repo_path: repoPath,
        worktree_path: isolated
          ? `${repoPath}/.worktrees/${id}`
          : cwdPath,
        branch: isolated ? `acorn/${id}` : "main",
        isolated,
        project_scoped: input.projectScoped !== false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: typeof input.kind === "string" ? input.kind : "regular",
        mode: typeof input.mode === "string" ? input.mode : "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: isolated,
      };
      w.__sessions = [...(w.__sessions ?? []), session];
      return session;
    });

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const createSessionButton = board.getByRole("button", {
      name: "Create session",
    });
    await createSessionButton.click();
    await page.getByRole("menuitem", { name: "New session" }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __createSessionCalls?: Array<Record<string, unknown>>;
              }
            ).__createSessionCalls?.length ?? 0,
        ),
      )
      .toBe(1);
    await expect(page.getByTestId("kanban-terminal-popover")).toHaveCount(0);
    await createSessionButton.click();
    await page.getByRole("menuitem", { name: "New worktree session" }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __createSessionCalls?: Array<Record<string, unknown>>;
              }
            ).__createSessionCalls?.length ?? 0,
        ),
      )
      .toBe(2);

    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __createSessionCalls?: Array<Record<string, unknown>>;
          }
        ).__createSessionCalls ?? [],
    );
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
    });
    expect(calls[1]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: true,
      kind: "regular",
    });
  });

  test("keeps a chat popover open when choosing a provider", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "seed",
          name: "seed",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          mode: "terminal",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = args as Record<string, unknown>;
      const w = window as unknown as {
        __createSessionCalls?: Array<Record<string, unknown>>;
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(input);
      const id = `created-${w.__createSessionCalls.length}`;
      const repoPath =
        typeof input.repoPath === "string" ? input.repoPath : "/tmp/demo";
      const session = {
        id,
        name: typeof input.name === "string" ? input.name : id,
        repo_path: repoPath,
        worktree_path:
          typeof input.cwdPath === "string" ? input.cwdPath : repoPath,
        branch: "main",
        isolated: input.isolated === true,
        project_scoped: input.projectScoped !== false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: typeof input.kind === "string" ? input.kind : "regular",
        mode: typeof input.mode === "string" ? input.mode : "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
      w.__sessions = [...(w.__sessions ?? []), session];
      return session;
    });

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    await board.getByRole("button", { name: "Create session" }).click();
    await page.getByRole("menuitem", { name: "New chat session" }).click();

    const chatCard = board.locator('[data-kanban-session-id="created-1"]');
    await expect(chatCard).toBeVisible();
    await expect(page.getByTestId("kanban-terminal-popover")).toHaveCount(0);

    await chatCard.click();

    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("chat-popover-body")).toBeVisible();

    const providerSelect = popover.getByRole("combobox", {
      name: "Chat provider",
    });
    await expect(providerSelect).toBeVisible();
    await providerSelect.click();
    await expect(
      page.locator('[data-acorn-floating-layer="select"]'),
    ).toBeVisible();

    await page.getByRole("option", { name: "Codex" }).click();

    await expect(popover).toBeVisible();
    await expect(providerSelect).toContainText("Codex");
  });

  test("opens a terminal popover when selecting a project session from the sidebar in kanban mode", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("alpha", "alpha", "ready"),
      session("shell", "shell", "working", {
        branch: "shell",
      }),
    ]);

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
    await expect(page.getByTestId("kanban-terminal-popover")).toHaveCount(0);

    await page
      .locator("aside")
      .getByRole("button", { name: /shell/ })
      .click();

    const shellPopover = page.getByTestId("kanban-terminal-popover");
    await expect(shellPopover).toBeVisible();
    await expect(
      shellPopover.getByRole("heading", { name: "shell" }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("terminal-popover-body")
        .locator('[data-acorn-terminal-slot="shell"] .acorn-terminal-shell'),
    ).toBeVisible();
  });

  test("keeps the sidebar-opened terminal popover when switching kanban workspaces", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: { defaultWorkspaceViewMode: "kanban" },
        }),
      );
    });
    const alpha = project("/tmp/alpha", "alpha", 0);
    const beta = project("/tmp/beta", "beta", 1);
    await tauri.respond("list_projects", [alpha, beta]);
    await tauri.respond("list_sessions", [
      session("alpha-session", "alpha-session", "ready", {
        repo_path: "/tmp/alpha",
        worktree_path: "/tmp/alpha/.worktrees/alpha-session",
        branch: "feat/alpha",
      }),
      session("beta-session", "beta-session", "working", {
        repo_path: "/tmp/beta",
        worktree_path: "/tmp/beta/.worktrees/beta-session",
        branch: "feat/beta",
      }),
    ]);

    await page.goto("/");

    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    await page
      .locator("aside")
      .getByRole("button", { name: "Project beta" })
      .click();

    const betaPopover = page.getByTestId("kanban-terminal-popover");
    await expect(betaPopover).toBeVisible();
    await expect(
      betaPopover.getByRole("heading", { name: "beta-session" }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("terminal-popover-body")
        .locator(
          '[data-acorn-terminal-slot="beta-session"] .acorn-terminal-shell',
        ),
    ).toBeVisible();
  });

  test("opens a terminal popover when selecting an instant session from the sidebar in kanban mode", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: { defaultWorkspaceViewMode: "kanban" },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("instant-shell", "instant-shell", "ready", {
        repo_path: "/Users/me",
        worktree_path: "/Users/me",
        branch: "home",
        project_scoped: false,
      }),
    ]);

    await page.goto("/");

    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    await expect(page.getByTestId("kanban-terminal-popover")).toHaveCount(0);

    await page
      .locator('[data-local-terminal-area="true"]')
      .getByRole("button", { name: /instant-shell/ })
      .click();

    const instantPopover = page.getByTestId("kanban-terminal-popover");
    await expect(instantPopover).toBeVisible();
    await expect(
      instantPopover.getByRole("heading", { name: "instant-shell" }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("terminal-popover-body")
        .locator(
          '[data-acorn-terminal-slot="instant-shell"] .acorn-terminal-shell',
        ),
    ).toBeVisible();
  });

  test("opens the new terminal popover from the kanban toolbar when enabled", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: { openKanbanTerminalOnSessionCreate: true },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "seed",
          name: "seed",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          mode: "terminal",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = args as Record<string, unknown>;
      const w = window as unknown as {
        __createSessionCalls?: Array<Record<string, unknown>>;
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(input);
      const id = `created-${w.__createSessionCalls.length}`;
      const repoPath =
        typeof input.repoPath === "string" ? input.repoPath : "/tmp/demo";
      const session = {
        id,
        name: typeof input.name === "string" ? input.name : id,
        repo_path: repoPath,
        worktree_path: repoPath,
        branch: "main",
        isolated: false,
        project_scoped: input.projectScoped !== false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: typeof input.kind === "string" ? input.kind : "regular",
        mode: "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
      w.__sessions = [...(w.__sessions ?? []), session];
      return session;
    });

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    await board.getByRole("button", { name: "Create session" }).click();
    await page.getByRole("menuitem", { name: "New session" }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __createSessionCalls?: Array<Record<string, unknown>>;
              }
            ).__createSessionCalls?.length ?? 0,
        ),
      )
      .toBe(1);
    await expect(
      board.locator('[data-kanban-session-id="created-1"]'),
    ).toBeVisible();
    await expect(page.getByTestId("kanban-terminal-popover")).toBeVisible();
    await expect(page.getByTestId("terminal-popover-body")).toBeVisible();
  });
});
