import { test, expect } from "./support";

test.describe("file explorer", () => {
  test("keeps expanded worktree folders after opening a file", async ({
    page,
    tauri,
  }) => {
    const repo = "/tmp/demo";
    const worktree = "/tmp/demo-worktree";
    const src = `${worktree}/src`;
    const file = `${src}/App.tsx`;

    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "s-1",
        name: "sess",
        repo_path: repo,
        worktree_path: worktree,
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("pty_repo_root", () => "/tmp/demo-worktree");
    await tauri.handle("fs_list_dir", (args) => {
      const worktree = "/tmp/demo-worktree";
      const src = `${worktree}/src`;
      const file = `${src}/App.tsx`;
      const { path } = args as { path: string };
      if (path === worktree) {
        return {
          repo_root: worktree,
          entries: [
            {
              name: "src",
              path: src,
              is_dir: true,
              is_symlink: false,
              size: 0,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      if (path === src) {
        return {
          repo_root: worktree,
          entries: [
            {
              name: "App.tsx",
              path: file,
              is_dir: false,
              is_symlink: false,
              size: 42,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      return { repo_root: path, entries: [] };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "src" }).click();
    await expect(page.getByRole("button", { name: "App.tsx" })).toBeVisible();

    await page.getByRole("button", { name: "App.tsx" }).dblclick();

    await expect(
      page.getByRole("button", { name: /App\.tsx Close tab/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "App.tsx", exact: true }),
    ).toBeVisible();
  });
});
