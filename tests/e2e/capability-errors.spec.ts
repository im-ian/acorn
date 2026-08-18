import { expect, test } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

test("shows CLI discovery access errors in Loop model settings", async ({
  page,
  tauri,
}) => {
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.handle("get_goal_agent_capabilities", (args) => ({
    provider: args?.provider === "claude" ? "claude" : "codex",
    installed: false,
    version: null,
    source: "unavailable",
    models: [],
    effort_options: [],
    warning: "CLI discovery failed: Permission denied while reading ~/.zshrc",
  }));

  await page.goto("/");
  await page.getByRole("button", { name: "Project demo" }).hover();
  await page
    .getByRole("button", { name: "Create session in this project" })
    .click();
  await page
    .getByRole("menuitem", { name: "New Loop session", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "New Loop session" });
  await dialog
    .getByRole("button", { name: "Agent & Model", exact: true })
    .click();

  await expect(dialog.locator("[data-goal-capability-warning]")).toContainText(
    "Permission denied while reading ~/.zshrc",
  );
});

test("shows CLI discovery access errors in Graph model settings", async ({
  page,
  tauri,
}) => {
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.handle("get_goal_agent_capabilities", (args) => ({
    provider: args?.provider === "claude" ? "claude" : "codex",
    installed: false,
    version: null,
    source: "unavailable",
    models: [],
    effort_options: [],
    warning: "CLI discovery failed: Permission denied while reading ~/.zshrc",
  }));

  await page.goto("/");
  await page.getByRole("button", { name: "Project demo" }).hover();
  await page
    .getByRole("button", { name: "Create session in this project" })
    .click();
  await page.getByRole("menuitem", { name: "New Graph session" }).click();

  const dialog = page.getByRole("dialog", { name: "New Graph session" });
  await expect(dialog.locator("[data-graph-capability-warning]")).toContainText(
    "Permission denied while reading ~/.zshrc",
  );
});
