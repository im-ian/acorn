import { expect, test } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const OTHER_PROJECT = {
  repo_path: "/tmp/other",
  name: "other",
  created_at: "2026-01-01T00:00:00Z",
  position: 1,
};

function session(id: string, repoPath = PROJECT.repo_path) {
  return {
    id,
    name: id,
    repo_path: repoPath,
    worktree_path: `${repoPath}/.worktrees/${id}`,
    branch: `feat/${id}`,
    isolated: false,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:05Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
  };
}

test.describe("workspace canvas mode", () => {
  test("moves, resizes, zooms, and restores live terminal nodes", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha"), session("beta")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const nodes = canvas.getByTestId("workspace-canvas-node");
    const alpha = canvas.locator('[data-canvas-session-id="alpha"]');
    await expect(canvas).toBeVisible();
    await expect(nodes).toHaveCount(2);
    await expect(
      alpha.locator(
        '[data-canvas-terminal-body="alpha"] [data-acorn-terminal-slot="alpha"] .acorn-terminal-shell',
      ),
    ).toBeVisible();
    await expect(
      canvas.locator(
        '[data-canvas-terminal-body="beta"] [data-acorn-terminal-slot="beta"] .acorn-terminal-shell',
      ),
    ).toBeAttached();

    const initialX = Number(await alpha.getAttribute("data-canvas-node-x"));
    const initialY = Number(await alpha.getAttribute("data-canvas-node-y"));
    const dragHandle = alpha.getByTestId("workspace-canvas-node-drag-handle");
    const dragBox = await dragHandle.boundingBox();
    if (!dragBox) throw new Error("Canvas drag handle is not visible");
    await page.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width / 2 + 80,
      dragBox.y + dragBox.height / 2 + 40,
    );
    await page.mouse.up();

    await expect
      .poll(async () => Number(await alpha.getAttribute("data-canvas-node-x")))
      .toBeGreaterThan(initialX);
    await expect
      .poll(async () => Number(await alpha.getAttribute("data-canvas-node-y")))
      .toBeGreaterThan(initialY);

    const initialWidth = Number(
      await alpha.getAttribute("data-canvas-node-width"),
    );
    const initialHeight = Number(
      await alpha.getAttribute("data-canvas-node-height"),
    );
    const resizeHandle = alpha.getByTestId(
      "workspace-canvas-node-resize-handle",
    );
    const resizeBox = await resizeHandle.boundingBox();
    if (!resizeBox) throw new Error("Canvas resize handle is not visible");
    await page.mouse.move(
      resizeBox.x + resizeBox.width / 2,
      resizeBox.y + resizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeBox.x + resizeBox.width / 2 + 100,
      resizeBox.y + resizeBox.height / 2 + 80,
    );
    await page.mouse.up();

    await expect
      .poll(async () =>
        Number(await alpha.getAttribute("data-canvas-node-width")),
      )
      .toBeGreaterThan(initialWidth);
    await expect
      .poll(async () =>
        Number(await alpha.getAttribute("data-canvas-node-height")),
      )
      .toBeGreaterThan(initialHeight);

    const world = page.getByTestId("workspace-canvas-world");
    const initialZoom = Number(await world.getAttribute("data-canvas-zoom"));
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect
      .poll(async () => Number(await world.getAttribute("data-canvas-zoom")))
      .toBeGreaterThan(initialZoom);
    const changedZoom = Number(await world.getAttribute("data-canvas-zoom"));

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("acorn-workspaces");
          if (!raw) return null;
          const state = JSON.parse(raw).state;
          const workspace = state.workspaces?.["/tmp/demo"];
          if (!workspace?.canvas?.nodes?.alpha) return null;
          return {
            mode: workspace.viewMode,
            node: workspace.canvas.nodes.alpha,
            zoom: workspace.canvas.viewport.zoom,
          };
        }),
      )
      .not.toBeNull();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("acorn-workspaces");
          return raw
            ? (JSON.parse(raw).state.workspaces?.["/tmp/demo"]?.canvas?.viewport
                ?.zoom ?? null)
            : null;
        }),
      )
      .toBe(changedZoom);

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem("acorn-workspaces");
      const workspace = JSON.parse(raw!).state.workspaces["/tmp/demo"];
      return {
        mode: workspace.viewMode as string,
        node: workspace.canvas.nodes.alpha as {
          x: number;
          y: number;
          width: number;
          height: number;
        },
        zoom: workspace.canvas.viewport.zoom as number,
      };
    });
    expect(saved.mode).toBe("canvas");

    await page.reload();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Canvas",
    );
    await expect(page.getByTestId("workspace-canvas")).toBeVisible();
    const restored = page.locator('[data-canvas-session-id="alpha"]');
    await expect(restored).toHaveAttribute(
      "data-canvas-node-x",
      String(saved.node.x),
    );
    await expect(restored).toHaveAttribute(
      "data-canvas-node-y",
      String(saved.node.y),
    );
    await expect(restored).toHaveAttribute(
      "data-canvas-node-width",
      String(saved.node.width),
    );
    await expect(restored).toHaveAttribute(
      "data-canvas-node-height",
      String(saved.node.height),
    );
    await expect(page.getByTestId("workspace-canvas-world")).toHaveAttribute(
      "data-canvas-zoom",
      String(saved.zoom),
    );
  });

  test("uses the minimap to navigate only the active project sessions", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT, OTHER_PROJECT]);
    await tauri.respond("list_sessions", [
      session("alpha"),
      session("beta"),
      session("gamma", OTHER_PROJECT.repo_path),
    ]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const overview = page.getByRole("region", { name: "Canvas overview" });
    await expect(overview).toBeVisible();
    await expect(
      overview.getByTestId("workspace-canvas-minimap-node"),
    ).toHaveCount(2);
    await expect(
      overview.getByRole("button", { name: "Show alpha on canvas" }),
    ).toBeVisible();
    await expect(
      overview.getByRole("button", { name: "Show beta on canvas" }),
    ).toBeVisible();
    await expect(
      overview.getByRole("button", { name: "Show gamma on canvas" }),
    ).toHaveCount(0);

    const world = page.getByTestId("workspace-canvas-world");
    const initialOffset = Number(
      await world.getAttribute("data-canvas-offset-x"),
    );
    await canvas.dispatchEvent("wheel", { deltaX: 1_800, deltaY: 0 });
    await expect
      .poll(async () =>
        Number(await world.getAttribute("data-canvas-offset-x")),
      )
      .toBeLessThan(initialOffset - 1_000);
    const offscreenOffset = Number(
      await world.getAttribute("data-canvas-offset-x"),
    );

    await overview
      .getByRole("button", { name: "Show beta on canvas" })
      .click();

    await expect(
      canvas.getByRole("button", { name: "Move beta" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.locator('[data-canvas-session-id="beta"]')).toBeInViewport();
    await expect
      .poll(async () =>
        Number(await world.getAttribute("data-canvas-offset-x")),
      )
      .not.toBe(offscreenOffset);
  });

  test("undoes a reset without remounting the live terminal", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha"), session("beta")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const alpha = page.locator('[data-canvas-session-id="alpha"]');
    const moveAlpha = alpha.getByRole("button", { name: "Move alpha" });
    await moveAlpha.press("Shift+ArrowRight");
    await moveAlpha.press("Shift+ArrowDown");
    await page.getByRole("button", { name: "Zoom in" }).click();

    const world = page.getByTestId("workspace-canvas-world");
    const beforeReset = {
      x: await alpha.getAttribute("data-canvas-node-x"),
      y: await alpha.getAttribute("data-canvas-node-y"),
      zoom: await world.getAttribute("data-canvas-zoom"),
    };
    expect(beforeReset.x).not.toBe("48");
    expect(beforeReset.zoom).not.toBe("1");

    const terminalSlot = alpha.locator(
      '[data-canvas-terminal-body="alpha"] [data-acorn-terminal-slot="alpha"]',
    );
    await expect(terminalSlot).toBeAttached();
    await page.getByRole("button", { name: "Reset terminal layout" }).click();

    await expect(alpha).toHaveAttribute("data-canvas-node-x", "48");
    await expect(alpha).toHaveAttribute("data-canvas-node-y", "48");
    await expect(world).toHaveAttribute("data-canvas-zoom", "1");

    const undo = page.getByRole("status").filter({
      hasText: "Terminal layout reset. Undo",
    });
    await expect(undo).toBeVisible();
    await undo.click();

    await expect(alpha).toHaveAttribute("data-canvas-node-x", beforeReset.x!);
    await expect(alpha).toHaveAttribute("data-canvas-node-y", beforeReset.y!);
    await expect(world).toHaveAttribute("data-canvas-zoom", beforeReset.zoom!);
    await expect(terminalSlot).toBeAttached();

    await page.reload();
    await expect(page.locator('[data-canvas-session-id="alpha"]')).toHaveAttribute(
      "data-canvas-node-x",
      beforeReset.x!,
    );
    await expect(page.getByTestId("workspace-canvas-world")).toHaveAttribute(
      "data-canvas-zoom",
      beforeReset.zoom!,
    );
  });
});
