import {
  test,
  expect,
  pressHotkey,
  seedSettingsLanguage,
} from "./support";

test.describe("command palette", () => {
  test("Korean mode localizes command palette chrome and default commands", async ({
    page,
  }) => {
    await seedSettingsLanguage(page, "ko");

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "p" });

    const palette = page.getByRole("dialog", { name: "명령 팔레트" });
    await expect(palette).toBeVisible();
    await expect(
      palette.getByPlaceholder("명령을 입력하거나 검색하세요..."),
    ).toBeVisible();
    await expect(palette.getByText("세션", { exact: true })).toBeVisible();
    await expect(
      palette.getByRole("option", { name: /새 세션/ }),
    ).toBeVisible();
    await expect(
      palette.getByRole("option", { name: /새 프로젝트/ }),
    ).toBeVisible();
  });

  test("opens with $mod+P and closes with Escape", async ({ page }) => {
    await page.goto("/");

    const palette = page.getByRole("dialog", { name: /Command palette/i });
    await expect(palette).toHaveCount(0);

    await pressHotkey(page, { mod: true, key: "p" });
    await expect(palette).toBeVisible();
    await expect(
      page.getByPlaceholder("Type a command or search..."),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  });

  test("New chat session creates a chat-mode session in the active project", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __chatSessionCreated?: boolean };
      return w.__chatSessionCreated
        ? [
            {
              id: "chat-1",
              name: "demo",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo",
              branch: "main",
              isolated: false,
              project_scoped: true,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              last_message: null,
              title_source: "default",
              kind: "regular",
              mode: "chat",
              owner: { kind: "user" },
              position: null,
              in_worktree: false,
            },
          ]
        : [];
    });
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as {
        __chatSessionCreated?: boolean;
        __createSessionCalls?: unknown[];
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      w.__chatSessionCreated = true;
      return {
        id: "chat-1",
        name: "demo",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "default",
        kind: "regular",
        mode: "chat",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "p" });
    await page.getByRole("option", { name: /New chat session/i }).click();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      repoPath: string;
      kind: string;
      mode: string;
      projectScoped: boolean;
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      kind: "regular",
      mode: "chat",
      projectScoped: true,
    });
  });

  test("shows seeded sessions under Switch session", async ({
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
        id: "s-1",
        name: "feature-branch",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "feature/abc",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
      },
    ]);

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "p" });

    await expect(
      page.getByRole("option", { name: /Switch to feature-branch/i }),
    ).toBeVisible();
  });
});
