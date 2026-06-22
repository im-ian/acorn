import { expect, pressHotkey, test } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const BASE_SESSION = {
  id: "s-1",
  name: "local",
  repo_path: "/tmp/demo",
  worktree_path: "/tmp/demo",
  branch: "main",
  isolated: false,
  status: "idle",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:05Z",
  last_message: null,
};

const TOKEN_USAGE = {
  updated_at: 1779860000,
  metrics: [
    {
      provider: "codex",
      window: "five_hour",
      used_percent: 12,
      remaining_percent: 88,
      reset_at: 1779860400,
      source: "~/.codex/sessions rate_limits",
      error: null,
    },
    {
      provider: "codex",
      window: "weekly",
      used_percent: 34,
      remaining_percent: 66,
      reset_at: 1779930000,
      source: "~/.codex/sessions rate_limits",
      error: null,
    },
    {
      provider: "claude",
      window: "five_hour",
      used_percent: 45,
      remaining_percent: 55,
      reset_at: 1779860400,
      source: "~/.claude/token-widget/claude-rate-limits.json",
      error: null,
    },
    {
      provider: "claude",
      window: "weekly",
      used_percent: 56,
      remaining_percent: 44,
      reset_at: 1779930000,
      source: "~/.claude/token-widget/claude-rate-limits.json",
      error: null,
    },
  ],
};

async function enableAgentTokenUsage(
  page: Parameters<typeof pressHotkey>[0],
): Promise<void> {
  await pressHotkey(page, { mod: true, key: "," });
  const modal = page.getByRole("dialog", { name: "Settings" });
  await modal.getByRole("button", { name: "Appearance", exact: true }).click();
  const checkbox = modal.getByRole("checkbox", { name: /Agent token usage/ });
  if (!(await checkbox.isChecked())) {
    await checkbox.click();
  }
  await page.keyboard.press("Escape");
}

test.describe("status bar", () => {
  test("service status tooltip renders service rows with icons", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("get_acorn_ipc_status", {
      bundled_path: "/tmp/acorn-ipc",
      bundled_exists: true,
      socket_path: "/tmp/acorn-dev/ipc.sock",
      server_running: true,
      shim_paths: [],
    });
    await tauri.respond("daemon_status", {
      running: true,
      enabled: true,
      daemon_version: "test",
      uptime_seconds: 60,
      session_count_total: 2,
      session_count_alive: 2,
      log_path: "/tmp/acorn/daemon.log",
      last_error: null,
    });

    await page.goto("/");

    const serviceButton = page.getByRole("button", { name: "Service status" });
    await expect(serviceButton).toBeVisible();
    await serviceButton.hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("IPC server");
    await expect(tooltip).toContainText("running");
    await expect(tooltip).toContainText("acornd daemon");
    await expect(tooltip).toContainText("running · 2 sessions");
    await expect(tooltip).toContainText("Click for details");
    await expect(tooltip.locator("svg")).toHaveCount(3);
  });

  test("shows only Codex token usage for an active Codex tab", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      { ...BASE_SESSION, name: "codex", agent_provider: "codex" },
    ]);
    await tauri.respond("get_agent_token_usage", TOKEN_USAGE);

    await page.goto("/");
    await enableAgentTokenUsage(page);

    const footer = page.locator("footer");
    const tokenBadge = footer.getByTestId("agent-token-usage");
    await expect(tokenBadge).toBeVisible();
    await expect(tokenBadge).toContainText("tokens:");
    await expect(tokenBadge).toContainText("5h");
    await expect(tokenBadge).toContainText("88%");
    await expect(tokenBadge).toContainText("w");
    await expect(tokenBadge).toContainText("66%");
    await expect(footer.getByRole("img", { name: "Codex" })).toBeVisible();
    await expect(footer.getByText(/Claude/)).toHaveCount(0);
    await expect(footer.getByText(/55%/)).toHaveCount(0);

    await tokenBadge.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("5h");
    await expect(tooltip).toContainText("88% left");
    await expect(tooltip).toContainText("resets in 7m");
    await expect(tooltip).toContainText("weekly");
    await expect(tooltip).toContainText("66% left");
    await expect(tooltip).toContainText("resets in 19h 27m");
    await expect(tooltip.locator("svg")).toHaveCount(5);
    await expect(tooltip).not.toContainText(/used|12%|34%/);
  });

  test("shows only Claude token usage for an active Claude tab", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      { ...BASE_SESSION, name: "claude", agent_provider: "claude" },
    ]);
    await tauri.respond("get_agent_token_usage", TOKEN_USAGE);

    await page.goto("/");
    await enableAgentTokenUsage(page);

    const footer = page.locator("footer");
    const tokenBadge = footer.getByTestId("agent-token-usage");
    await expect(tokenBadge).toBeVisible();
    await expect(tokenBadge).toContainText("tokens:");
    await expect(tokenBadge).toContainText("5h");
    await expect(tokenBadge).toContainText("55%");
    await expect(tokenBadge).toContainText("w");
    await expect(tokenBadge).toContainText("44%");
    await expect(footer.getByRole("img", { name: "Claude" })).toBeVisible();
    await expect(footer.getByText(/Codex/)).toHaveCount(0);
    await expect(footer.getByText(/88%/)).toHaveCount(0);
  });

  test("hides agent token usage for non-agent tabs", async ({ page, tauri }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [{ ...BASE_SESSION, name: "shell" }]);
    await tauri.respond("get_agent_token_usage", TOKEN_USAGE);

    await page.goto("/");
    await enableAgentTokenUsage(page);

    await expect(page.getByText(/^tokens:/)).toHaveCount(0);
  });

  test("uses a generic token icon when agent provider icons are disabled", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      { ...BASE_SESSION, name: "codex", agent_provider: "codex" },
    ]);
    await tauri.respond("get_agent_token_usage", TOKEN_USAGE);
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          statusBar: { showAgentTokenUsage: true },
          sessionDisplay: { icons: { agentProvider: false } },
        }),
      );
    });

    await page.goto("/");

    const footer = page.locator("footer");
    const tokenBadge = footer.getByTestId("agent-token-usage");
    await expect(tokenBadge).toBeVisible();
    await expect(tokenBadge).toContainText("tokens:");
    await expect(tokenBadge).toContainText("5h");
    await expect(tokenBadge).toContainText("88%");
    await expect(tokenBadge).toContainText("w");
    await expect(tokenBadge).toContainText("66%");
    await expect(footer.getByRole("img", { name: "Codex" })).toHaveCount(0);
  });
});
