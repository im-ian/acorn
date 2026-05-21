import {
  test,
  expect,
  pressHotkey,
  seedSettingsLanguage,
} from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const SESSION = {
  id: "s-1",
  name: "alpha",
  repo_path: "/tmp/demo",
  worktree_path: "/tmp/demo",
  branch: "main",
  isolated: false,
  status: "idle" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:05Z",
  last_message: null,
};

test.describe("pane / sidebar shortcuts", () => {
  test("Korean mode localizes empty pane guidance", async ({ page, tauri }) => {
    await seedSettingsLanguage(page, "ko");
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", []);

    await page.goto("/");

    await expect(
      page.getByText(/여기에 탭을 놓거나 더블 클릭해 세션을 시작하세요/),
    ).toBeVisible();
  });

  // react-resizable-panels publishes the current size on `data-panel-size`
  // (string, e.g. "18.0" for the default 18%). Collapsed panels get "0.0".
  test("$mod+B collapses then re-expands the sidebar", async ({ page }) => {
    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    await expect(sidebar).not.toHaveAttribute("data-panel-size", "0.0");

    await pressHotkey(page, { mod: true, key: "b" });
    await expect(sidebar).toHaveAttribute("data-panel-size", "0.0");

    await pressHotkey(page, { mod: true, key: "b" });
    await expect(sidebar).not.toHaveAttribute("data-panel-size", "0.0");
  });

  test("$mod+J collapses then re-expands the right panel", async ({ page }) => {
    await page.goto("/");

    const right = page.locator('[data-panel-id="right"]');
    await expect(right).not.toHaveAttribute("data-panel-size", "0.0");

    await pressHotkey(page, { mod: true, key: "j" });
    await expect(right).toHaveAttribute("data-panel-size", "0.0");

    await pressHotkey(page, { mod: true, key: "j" });
    await expect(right).not.toHaveAttribute("data-panel-size", "0.0");
  });

  test("$mod+D splits the focused pane horizontally", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);

    await page.goto("/");

    // Activate the session so a pane is focused with content.
    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first()
      .click();

    const panes = page.locator("[data-pane-body]");
    await expect(panes).toHaveCount(1);

    await pressHotkey(page, { mod: true, key: "d" });
    await expect(panes).toHaveCount(2);

    // Horizontal split = side-by-side. Vertical split via $mod+Shift+D.
    await pressHotkey(page, { mod: true, shift: true, key: "D" });
    await expect(panes).toHaveCount(3);
  });

  test("focused pane renders a small active indicator", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);

    await page.goto("/");

    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first()
      .click();

    const indicator = page.locator("[data-active-pane-indicator]");
    await expect(indicator).toHaveCount(1);
    const initialPaneId = await indicator.getAttribute(
      "data-active-pane-indicator",
    );

    const box = await indicator.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeLessThanOrEqual(3);
    expect(box?.height).toBeGreaterThanOrEqual(40);

    await pressHotkey(page, { mod: true, key: "d" });
    await expect(page.locator("[data-pane-body]")).toHaveCount(2);
    await expect(indicator).toHaveCount(1);
    const splitPaneId = await indicator.getAttribute(
      "data-active-pane-indicator",
    );
    expect(splitPaneId).not.toBe(initialPaneId);

    await page
      .locator(`[data-pane-body="${initialPaneId}"]`)
      .click({ position: { x: 12, y: 12 } });
    await expect(indicator).toHaveCount(1);
    await expect(indicator).toHaveAttribute(
      "data-active-pane-indicator",
      initialPaneId ?? "",
    );
  });

  test("tab close button has a reliable hit area outside the drag handle", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);

    await page.goto("/");

    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first()
      .click();

    const closeButton = page.locator('[data-tab-close-button="s-1"]');
    const dragHandle = page.locator('[data-tab-drag-handle="s-1"]');
    await expect(closeButton).toBeVisible();
    await expect(dragHandle).toBeVisible();

    await expect(closeButton).toHaveAttribute("draggable", "false");
    await expect(dragHandle).toHaveAttribute("draggable", "true");

    const geometry = await page.evaluate(() => {
      const close = document.querySelector(
        '[data-tab-close-button="s-1"]',
      );
      const handle = document.querySelector(
        '[data-tab-drag-handle="s-1"]',
      );
      if (!close || !handle) return null;
      const closeRect = close.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      return {
        closeWidth: closeRect.width,
        closeHeight: closeRect.height,
        closeLeft: closeRect.left,
        handleRight: handleRect.right,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry?.closeWidth).toBeGreaterThanOrEqual(24);
    expect(geometry?.closeHeight).toBeGreaterThanOrEqual(24);
    expect(geometry?.handleRight).toBeLessThanOrEqual(
      geometry?.closeLeft ?? 0,
    );

    await closeButton.click({ position: { x: 1, y: 12 } });
    await expect(
      page.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();
  });

  test("tab drag remains available after entering rename mode", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);

    await page.goto("/");

    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first()
      .click();

    const dragHandle = page.locator('[data-tab-drag-handle="s-1"]');
    await dragHandle.dblclick();

    const renameInput = page.locator("[data-tab-rename-input]");
    await expect(renameInput).toBeFocused();
    await expect(renameInput).toHaveAttribute("draggable", "false");
    await expect(dragHandle).toHaveAttribute("draggable", "true");

    await page.evaluate(() => {
      const handle = document.querySelector(
        '[data-tab-drag-handle="s-1"]',
      );
      if (!handle) throw new Error("missing tab drag handle");
      const event = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      });
      handle.dispatchEvent(event);
    });

    await expect(renameInput).toHaveCount(0);
  });

  test("$mod+Alt+E dispatches equalize panes", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      window.addEventListener("acorn:equalize-panes", () => {
        document.documentElement.dataset.equalizePanes = "true";
      });
    });

    await pressHotkey(page, { mod: true, alt: true, key: "e" });

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.equalizePanes),
      )
      .toBe("true");
  });

  test("$mod+W triggers the remove-session confirm flow for the active tab", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    // After remove_session fires, list_sessions returns empty so the pane
    // visibly empties to the "Drop a tab here" placeholder.
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __removed?: boolean };
      return w.__removed
        ? []
        : [
            {
              id: "s-1",
              name: "alpha",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo",
              branch: "main",
              isolated: false,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:05Z",
              last_message: null,
            },
          ];
    });
    await tauri.handle("remove_session", () => {
      const w = window as unknown as { __removed?: boolean };
      w.__removed = true;
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    await sidebar
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first()
      .click();

    await expect(
      page.getByText(/Drop a tab here or double-click/i),
    ).toHaveCount(0);

    // closeFocusedTab routes through requestRemoveSession, which opens the
    // confirm dialog (matches the manual flow).
    await pressHotkey(page, { mod: true, key: "w" });
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: /^Remove$/ }).click();

    await expect(
      page.getByText(/Drop a tab here or double-click/i),
    ).toBeVisible();
  });
});
