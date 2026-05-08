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
      startup_mode: "terminal",
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
});
