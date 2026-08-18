import { test, expect } from "./support";

// Seed a project + session and force list_pull_requests to return the
// no_access listing variant so the NoAccessBanner renders. The banner is
// the canonical CommandHint surface — clicking the `gh auth login` chip
// opens the run/copy dialog without executing anything.
async function seedNoAccess(
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
  await tauri.handle("list_pull_requests", () => ({
    kind: "no_access",
    slug: "acme/widget",
    accounts: [{ login: "alice", has_access: false }],
  }));
}

test.describe("CommandHint via NoAccessBanner", () => {
  test("clicking the gh auth login chip opens the run/copy dialog", async ({
    page,
    tauri,
  }) => {
    await seedNoAccess(tauri);

    await page.goto("/");
    // PRs lives under the GitHub group of the right panel — open the group
    // first so the sub-tab is in the DOM, then click it.
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();

    // Banner renders the command as a clickable chip with title attr.
    const chip = page.getByRole("button", { name: /gh auth login/ });
    await expect(chip).toBeVisible();
    await chip.click();

    // Dialog: title + command preview + Copy + Run buttons.
    await expect(page.getByText(/Run this command\?/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Copy$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Run$/ })).toBeVisible();
  });

  test("Cancel button dismisses without writing to the PTY", async ({
    page,
    tauri,
  }) => {
    await seedNoAccess(tauri);

    await page.goto("/");
    // PRs lives under the GitHub group of the right panel — open the group
    // first so the sub-tab is in the DOM, then click it.
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();
    await page.getByRole("button", { name: /gh auth login/ }).click();
    await page.getByRole("button", { name: /^Cancel$/ }).click();

    await expect(page.getByText(/Run this command\?/i)).toHaveCount(0);
  });

  test("a queued command write failure is visible to the user", async ({
    page,
    tauri,
    errorTracker,
  }) => {
    await seedNoAccess(tauri);
    errorTracker.allow(/\[Terminal\] pending pty_write failed/);

    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __commandRunSessions?: Array<Record<string, unknown>>;
      };
      w.__commandRunSessions ??= [
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
      ];
      return w.__commandRunSessions;
    });
    await tauri.handle("create_session", (args: unknown) => {
      const w = window as unknown as {
        __commandRunSessions?: Array<Record<string, unknown>>;
      };
      const request = args as { name: string; repoPath: string };
      const created = {
        id: "s-command",
        name: request.name,
        repo_path: request.repoPath,
        worktree_path: request.repoPath,
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:01:00Z",
        updated_at: "2026-01-01T00:01:00Z",
        last_message: null,
      };
      w.__commandRunSessions = [...(w.__commandRunSessions ?? []), created];
      return created;
    });
    await tauri.handle("pty_spawn", () => null);
    await tauri.handle("pty_write", () => {
      throw new Error("Permission denied");
    });

    await page.goto("/");
    await page.getByRole("button", { name: "GitHub" }).click();
    await page.getByRole("button", { name: "PRs" }).click();
    await page.getByRole("button", { name: /gh auth login/ }).click();
    await page.getByRole("button", { name: /^Run$/ }).click();

    await expect(
      page.getByText(
        "Failed to run queued terminal command: Permission denied",
      ),
    ).toBeVisible();
    await expect(
      page.locator(".xterm").filter({
        hasText: "Failed to run queued command: Permission denied",
      }),
    ).toHaveCount(1);
  });
});
