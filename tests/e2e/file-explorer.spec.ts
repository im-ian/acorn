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

  test("previews markdown files from a code viewer tab", async ({
    page,
    tauri,
  }) => {
    const repo = "/tmp/demo";

    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", []);
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo") {
        return { repo_root: "/tmp/demo", entries: [] };
      }
      return {
        repo_root: "/tmp/demo",
        entries: [
          {
            name: "README.md",
            path: "/tmp/demo/README.md",
            is_dir: false,
            is_symlink: false,
            size: 40,
            modified_ms: 0,
            gitignored: false,
          },
        ],
      };
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo/README.md") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "# Project notes\n\n- [x] Markdown preview",
        size: 40,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "README.md" }).dblclick();

    await expect(
      page.getByRole("button", { name: /README\.md Close tab/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Project notes" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Preview" }).click();

    await expect(
      page.getByRole("heading", { name: "Project notes" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Source" })).toBeVisible();
    await expect(page.getByText("Markdown preview")).toBeVisible();
  });

  test("reopens a worktree file tab after switching away and back to its project", async ({
    page,
    tauri,
  }) => {
    const repoA = "/tmp/alpha";
    const repoB = "/tmp/beta";
    const worktreeA = "/tmp/alpha/.worktrees/a-session";

    await tauri.respond("list_projects", [
      {
        repo_path: repoA,
        name: "alpha",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
      {
        repo_path: repoB,
        name: "beta",
        created_at: "2026-01-01T00:00:00Z",
        position: 1,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "a-session",
        name: "a-session",
        repo_path: repoA,
        worktree_path: worktreeA,
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "b-session",
        name: "b-session",
        repo_path: repoB,
        worktree_path: "/tmp/beta/.worktrees/b-session",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/alpha/.worktrees/a-session") {
        return { repo_root: path, entries: [] };
      }
      return {
        repo_root: "/tmp/alpha/.worktrees/a-session",
        entries: [
          {
            name: "README.md",
            path: "/tmp/alpha/.worktrees/a-session/README.md",
            is_dir: false,
            is_symlink: false,
            size: 28,
            modified_ms: 0,
            gitignored: false,
          },
        ],
      };
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/alpha/.worktrees/a-session/README.md") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "# Alpha README\n\nProject A notes",
        size: 28,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "README.md" }).dblclick();
    await expect(
      page.getByRole("button", { name: /README\.md Close tab/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: /a-session Close session/ }).click();
    await page.getByRole("button", { name: "Project beta" }).click();
    await page.getByRole("button", { name: "Project alpha" }).click();
    await page.getByRole("button", { name: /README\.md Close tab/ }).click();

    await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  });
});
