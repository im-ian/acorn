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
  test("uses a pulsing live-agent icon instead of the status dot", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      {
        ...session("alpha"),
        status: "waiting_for_input",
        agent_provider: "codex",
      },
      session("beta"),
    ]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const alpha = page.locator('[data-canvas-session-id="alpha"]');
    const liveAgent = alpha.getByRole("img", { name: "Codex" });
    await expect(liveAgent).toBeVisible();
    await expect(liveAgent).toHaveClass(/animate-pulse/);
    await expect(alpha.locator("header .rounded-full")).toHaveCount(0);

    const beta = page.locator('[data-canvas-session-id="beta"]');
    await expect(beta.locator("header .rounded-full")).toHaveCount(1);
    await expect(beta.getByRole("img")).toHaveCount(0);
  });

  test("creates sessions from canvas menus and expands a terminal without leaving canvas", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __canvasSessions?: Array<Record<string, unknown>>;
      };
      w.__canvasSessions = w.__canvasSessions ?? [];
      return w.__canvasSessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = args as Record<string, unknown>;
      const w = window as unknown as {
        __canvasCreateCalls?: Array<Record<string, unknown>>;
        __canvasSessions?: Array<Record<string, unknown>>;
      };
      w.__canvasCreateCalls = [...(w.__canvasCreateCalls ?? []), input];
      const repoPath =
        typeof input.repoPath === "string" ? input.repoPath : "/tmp/demo";
      const mode = input.mode === "chat" ? "chat" : "terminal";
      const id = mode === "chat" ? "canvas-chat" : "canvas-created";
      const created = {
        id,
        name: id,
        repo_path: repoPath,
        worktree_path: repoPath,
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: "regular",
        mode,
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
      w.__canvasSessions = [...(w.__canvasSessions ?? []), created];
      return created;
    });

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("Canvas is not visible");
    await canvas.click({
      button: "right",
      position: { x: canvasBox.width / 2, y: canvasBox.height / 2 },
    });
    await expect(
      page.getByRole("menuitem", { name: "New session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "New worktree session",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "New control session",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New chat session", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const createButton = canvas.getByRole("button", {
      name: "Create session",
    });
    await createButton.click();
    await page
      .getByRole("menuitem", { name: "New session", exact: true })
      .click();

    const node = canvas.locator(
      '[data-canvas-session-id="canvas-created"]',
    );
    await expect(node).toBeVisible();
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __canvasCreateCalls?: Array<Record<string, unknown>>;
          }
        ).__canvasCreateCalls ?? [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
    });

    await node.getByRole("button", { name: "Expand canvas-created" }).click();
    const popover = page.getByTestId("kanban-terminal-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Canvas",
    );
    await expect(
      popover.locator('[data-acorn-terminal-slot="canvas-created"]'),
    ).toBeAttached();

    await popover.getByRole("button", { name: "Close" }).click();
    await expect(popover).toHaveCount(0);
    await expect(
      node.locator('[data-acorn-terminal-slot="canvas-created"]'),
    ).toBeAttached();

    await createButton.click();
    await page
      .getByRole("menuitem", { name: "New chat session", exact: true })
      .click();

    const chatNode = canvas.locator('[data-canvas-session-id="canvas-chat"]');
    await expect(chatNode).toBeVisible();
    await expect(
      chatNode.getByRole("textbox", { name: "Chat message" }),
    ).toBeVisible();
    await expect(
      chatNode.getByRole("button", { name: "Expand canvas-chat" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Canvas",
    );
    const canvasWorld = page.getByTestId("workspace-canvas-world");
    const offsetBeforeChatScroll = await canvasWorld.getAttribute(
      "data-canvas-offset-y",
    );
    await chatNode
      .getByRole("textbox", { name: "Chat message" })
      .dispatchEvent("wheel", { deltaY: 120 });
    await expect(canvasWorld).toHaveAttribute(
      "data-canvas-offset-y",
      offsetBeforeChatScroll ?? "0",
    );

    const callsAfterChat = await page.evaluate(
      () =>
        (
          window as unknown as {
            __canvasCreateCalls?: Array<Record<string, unknown>>;
          }
        ).__canvasCreateCalls ?? [],
    );
    expect(callsAfterChat).toHaveLength(2);
    expect(callsAfterChat[1]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
      mode: "chat",
    });

    await canvas
      .getByRole("button", { name: "Show canvas-created on canvas" })
      .click();
    await node
      .getByTestId("workspace-canvas-node-drag-handle")
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open canvas-created in panes" })
      .click();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Panes",
    );
  });

  test("keeps the first session drag handle clear of the toolbar at high UI scale", async ({
    page,
    tauri,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ appearance: { uiScalePercent: 125 } }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const alpha = canvas.locator('[data-canvas-session-id="alpha"]');
    const dragHandle = alpha.getByTestId(
      "workspace-canvas-node-drag-handle",
    );
    const toolbarBox = await canvas.getByRole("toolbar").boundingBox();
    const dragBox = await dragHandle.boundingBox();
    if (!toolbarBox || !dragBox) {
      throw new Error("Canvas toolbar and drag handle must be visible");
    }
    expect(dragBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);

    const initialX = Number(await alpha.getAttribute("data-canvas-node-x"));
    await page.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width / 2 + 25,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.up();

    await expect
      .poll(async () => Number(await alpha.getAttribute("data-canvas-node-x")))
      .toBeGreaterThan(initialX);
  });

  test("closes sessions from the canvas context menu and title button", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __canvasRemovedIds?: string[] };
      const removedIds = w.__canvasRemovedIds ?? [];
      return ["alpha", "beta"]
        .filter((id) => !removedIds.includes(id))
        .map((id) => ({
          id,
          name: id,
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
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
        }));
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __canvasRemoveCalls?: unknown[];
        __canvasRemovedIds?: string[];
      };
      const id = (args as { id: string }).id;
      w.__canvasRemoveCalls = [...(w.__canvasRemoveCalls ?? []), args];
      w.__canvasRemovedIds = [...(w.__canvasRemovedIds ?? []), id];
      return null;
    });

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const node = page.locator('[data-canvas-session-id="alpha"]');
    await node
      .getByTestId("workspace-canvas-node-drag-handle")
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close session", exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(node).toHaveCount(0);
    const beta = page.locator('[data-canvas-session-id="beta"]');
    await beta.getByRole("button", { name: "Close beta" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(beta).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __canvasRemoveCalls?: Array<{
                  id: string;
                  removeWorktree: boolean;
                }>;
              }
            ).__canvasRemoveCalls ?? [],
        ),
      )
      .toEqual([
        { id: "alpha", removeWorktree: false },
        { id: "beta", removeWorktree: false },
      ]);
  });

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
    await expect(
      canvas.getByText("Right-click for session actions", { exact: false }),
    ).toHaveCount(0);
    await canvas
      .getByRole("button", { name: "Show canvas controls help" })
      .hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Right-click for session actions",
    );
    await canvas.getByRole("button", { name: "Move alpha" }).hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
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

    await page
      .getByRole("region", { name: "Canvas overview" })
      .getByRole("button", { name: "Show alpha on canvas" })
      .click();
    await expect(alpha).toBeInViewport();

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

  test("shows magnetic alignment guides and matches peer dimensions", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha"), session("beta")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const alpha = canvas.locator('[data-canvas-session-id="alpha"]');
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
      resizeBox.x + resizeBox.width / 2 + 6,
      resizeBox.y + resizeBox.height / 2 + 6,
    );

    await expect(alpha).toHaveAttribute("data-canvas-node-width", "620");
    await expect(alpha).toHaveAttribute("data-canvas-node-height", "400");
    await expect(alpha).toHaveCSS("z-index", "3");
    await expect(canvas.getByTestId("workspace-canvas-size-hint"))
      .toHaveAttribute("data-canvas-match-width", "true");
    await expect(canvas.getByTestId("workspace-canvas-size-hint"))
      .toHaveAttribute("data-canvas-match-height", "true");

    await page.mouse.up();
    await expect(canvas.getByTestId("workspace-canvas-size-hint")).toHaveCount(0);

    const wholePixelResizeBox = await resizeHandle.boundingBox();
    if (!wholePixelResizeBox) {
      throw new Error("Canvas resize handle is not visible");
    }
    await page.mouse.move(
      wholePixelResizeBox.x + wholePixelResizeBox.width / 2,
      wholePixelResizeBox.y + wholePixelResizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      wholePixelResizeBox.x + wholePixelResizeBox.width / 2 + 20,
      wholePixelResizeBox.y + wholePixelResizeBox.height / 2 + 20,
    );
    await expect(alpha).toHaveAttribute("data-canvas-node-width", "640");
    await expect(alpha).toHaveAttribute("data-canvas-node-height", "420");
    await expect(canvas.getByTestId("workspace-canvas-size-hint")).toHaveCount(0);
    await page.mouse.up();

    const dragHandle = alpha.getByTestId("workspace-canvas-node-drag-handle");
    const dragBox = await dragHandle.boundingBox();
    if (!dragBox) throw new Error("Canvas drag handle is not visible");
    await page.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.down();
    const beta = canvas.locator('[data-canvas-session-id="beta"]');
    const alphaX = Number(await alpha.getAttribute("data-canvas-node-x"));
    const betaX = Number(await beta.getAttribute("data-canvas-node-x"));
    await page.mouse.move(
      dragBox.x + dragBox.width / 2 + (betaX - alphaX - 5),
      dragBox.y + dragBox.height / 2 + 60,
    );

    await expect(alpha).toHaveAttribute("data-canvas-node-x", "708");
    await expect(
      canvas.locator('[data-canvas-alignment-axis="x"]'),
    ).toBeVisible();

    await page.mouse.up();
    await expect(
      canvas.locator('[data-canvas-alignment-axis="x"]'),
    ).toHaveCount(0);
    await expect(alpha).toHaveAttribute("data-canvas-node-x", "708");
  });

  test("keeps Alt gestures on whole pixels when the canvas loses focus", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha"), session("beta")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const world = page.getByTestId("workspace-canvas-world");
    await canvas.getByRole("button", { name: "Zoom in" }).click();
    const zoom = Number(await world.getAttribute("data-canvas-zoom"));
    const appScale = await canvas.evaluate(
      (element) => element.getBoundingClientRect().width / element.offsetWidth,
    );

    const alpha = canvas.locator('[data-canvas-session-id="alpha"]');
    const initialX = Number(await alpha.getAttribute("data-canvas-node-x"));
    const initialY = Number(await alpha.getAttribute("data-canvas-node-y"));
    const dragHandle = alpha.getByTestId("workspace-canvas-node-drag-handle");
    const dragBox = await dragHandle.boundingBox();
    if (!dragBox) throw new Error("Canvas drag handle is not visible");
    const start = {
      x: dragBox.x + dragBox.width / 2,
      y: dragBox.y + dragBox.height / 2,
    };

    await page.keyboard.down("Alt");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 13, start.y + 13);
    const expectedX = Math.round(initialX + 13 / (appScale * zoom));
    const expectedY = Math.round(initialY + 13 / (appScale * zoom));
    await expect(alpha).toHaveAttribute(
      "data-canvas-node-x",
      String(expectedX),
    );
    await expect(alpha).toHaveAttribute(
      "data-canvas-node-y",
      String(expectedY),
    );

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(alpha).toHaveAttribute(
      "data-canvas-node-x",
      String(expectedX),
    );
    await expect(alpha).toHaveAttribute(
      "data-canvas-node-y",
      String(expectedY),
    );
    await page.mouse.up();
    await page.keyboard.up("Alt");

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
    const resizeStart = {
      x: resizeBox.x + resizeBox.width / 2,
      y: resizeBox.y + resizeBox.height / 2,
    };
    await page.keyboard.down("Alt");
    await page.mouse.move(resizeStart.x, resizeStart.y);
    await page.mouse.down();
    await page.mouse.move(resizeStart.x + 13, resizeStart.y + 13);
    await expect(alpha).toHaveAttribute(
      "data-canvas-node-width",
      String(Math.round(initialWidth + 13 / (appScale * zoom))),
    );
    await expect(alpha).toHaveAttribute(
      "data-canvas-node-height",
      String(Math.round(initialHeight + 13 / (appScale * zoom))),
    );
    await page.mouse.up();
    await page.keyboard.up("Alt");
  });

  test("commits the last canvas position without jumping on pointer cancellation", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha"), session("beta")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const alpha = canvas.locator('[data-canvas-session-id="alpha"]');
    const dragHandle = alpha.getByTestId("workspace-canvas-node-drag-handle");
    const dragBox = await dragHandle.boundingBox();
    if (!dragBox) throw new Error("Canvas drag handle is not visible");
    const start = {
      x: dragBox.x + dragBox.width / 2,
      y: dragBox.y + dragBox.height / 2,
    };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 100, start.y + 6);
    await expect(alpha).toHaveAttribute("data-canvas-node-x", "148");
    await expect(alpha).toHaveAttribute("data-canvas-node-y", "48");
    await expect(
      canvas.locator('[data-canvas-alignment-axis="y"]'),
    ).toBeVisible();

    await page.evaluate(() =>
      window.dispatchEvent(
        new PointerEvent("pointercancel", { clientX: 0, clientY: 0 }),
      ),
    );
    await expect(alpha).toHaveAttribute("data-canvas-node-x", "140");
    await expect(alpha).toHaveAttribute("data-canvas-node-y", "48");
    await expect(canvas.getByTestId("workspace-canvas-alignment-guide"))
      .toHaveCount(0);
    await page.mouse.up();
  });

  test("clears alignment guides when the dragged session disappears", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const removedIds = (
        window as unknown as { __canvasRemovedIds?: string[] }
      ).__canvasRemovedIds;
      return ["alpha", "beta"]
        .filter((id) => !removedIds?.includes(id))
        .map((id) => ({
          id,
          name: id,
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
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
        }));
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as { __canvasRemovedIds?: string[] };
      w.__canvasRemovedIds = [
        ...(w.__canvasRemovedIds ?? []),
        (args as { id: string }).id,
      ];
      return null;
    });

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const canvas = page.getByTestId("workspace-canvas");
    const alpha = canvas.locator('[data-canvas-session-id="alpha"]');
    const dragHandle = alpha.getByTestId("workspace-canvas-node-drag-handle");
    const dragBox = await dragHandle.boundingBox();
    if (!dragBox) throw new Error("Canvas drag handle is not visible");
    await page.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width / 2 + 100,
      dragBox.y + dragBox.height / 2 + 6,
    );
    await expect(canvas.getByTestId("workspace-canvas-alignment-guide"))
      .toBeVisible();

    await alpha
      .getByRole("button", { name: "Close alpha" })
      .evaluate((button: HTMLButtonElement) => button.click());
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Remove", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());

    await expect(alpha).toHaveCount(0);
    await expect(canvas.getByTestId("workspace-canvas-alignment-guide"))
      .toHaveCount(0);
    await page.mouse.up();
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
    await expect(canvas.getByTestId("workspace-canvas-node")).toHaveCount(2);
    await expect(
      canvas.locator('[data-canvas-session-id="gamma"]'),
    ).toHaveCount(0);
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
    const betaNode = canvas.locator('[data-canvas-session-id="beta"]');
    const betaX = Number(await betaNode.getAttribute("data-canvas-node-x"));
    await canvas
      .getByRole("button", { name: "Move beta" })
      .press("Shift+ArrowRight");
    await expect
      .poll(async () =>
        Number(await betaNode.getAttribute("data-canvas-node-x")),
      )
      .toBeGreaterThan(betaX);
    const demoBetaX = await betaNode.getAttribute("data-canvas-node-x");

    await page.getByRole("button", { name: "Project other" }).click();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Panes",
    );
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();
    await expect(canvas.getByTestId("workspace-canvas-node")).toHaveCount(1);
    await expect(
      canvas.locator('[data-canvas-session-id="gamma"]'),
    ).toBeVisible();
    await expect(
      canvas.locator('[data-canvas-session-id="alpha"]'),
    ).toHaveCount(0);
    await expect(
      canvas.locator('[data-canvas-session-id="beta"]'),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Project demo" }).click();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Canvas",
    );
    await expect(canvas.getByTestId("workspace-canvas-node")).toHaveCount(2);
    await expect(
      canvas.locator('[data-canvas-session-id="gamma"]'),
    ).toHaveCount(0);
    await expect(betaNode).toHaveAttribute("data-canvas-node-x", demoBetaX!);

    await overview
      .getByRole("button", { name: "Collapse canvas overview" })
      .click();
    await expect(
      overview.getByTestId("workspace-canvas-minimap-plot"),
    ).toHaveCount(0);
    await overview
      .getByRole("button", { name: "Expand canvas overview" })
      .click();
    await expect(
      overview.getByTestId("workspace-canvas-minimap-plot"),
    ).toBeVisible();
  });

  test("pans from the minimap pointer and keyboard controls and commits it", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [session("alpha"), session("beta")]);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const overview = page.getByRole("region", { name: "Canvas overview" });
    const plot = overview.getByTestId("workspace-canvas-minimap-plot");
    const world = page.getByTestId("workspace-canvas-world");
    const box = await plot.boundingBox();
    if (!box) throw new Error("Canvas overview plot is not visible");

    const initialOffset = Number(
      await world.getAttribute("data-canvas-offset-x"),
    );
    await plot.dispatchEvent("pointerdown", {
      button: 0,
      clientX: box.x + box.width * 0.8,
      clientY: box.y + box.height * 0.75,
    });
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0 })),
    );
    await expect
      .poll(async () => Number(await world.getAttribute("data-canvas-offset-x")))
      .not.toBe(initialOffset);

    const clickedOffset = Number(
      await world.getAttribute("data-canvas-offset-x"),
    );
    await plot.dispatchEvent("pointerdown", {
      button: 0,
      clientX: box.x + box.width * 0.2,
      clientY: box.y + box.height * 0.25,
    });
    await page.evaluate(
      ({ x, y }) =>
        window.dispatchEvent(
          new PointerEvent("pointermove", { clientX: x, clientY: y }),
        ),
      { x: box.x + box.width * 0.65, y: box.y + box.height * 0.6 },
    );
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0 })),
    );
    await expect
      .poll(async () => Number(await world.getAttribute("data-canvas-offset-x")))
      .not.toBe(clickedOffset);

    await overview.focus();
    const draggedOffset = Number(
      await world.getAttribute("data-canvas-offset-x"),
    );
    await page.keyboard.press("ArrowRight");
    await expect(world).toHaveAttribute(
      "data-canvas-offset-x",
      String(draggedOffset - 80),
    );
    const persistedOffset = draggedOffset - 80;
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("acorn-workspaces");
          return raw
            ? (JSON.parse(raw).state.workspaces?.["/tmp/demo"]?.canvas
                ?.viewport?.offset?.x ?? null)
            : null;
        }),
      )
      .toBe(persistedOffset);
  });

  test("selects the intended marker in a dense minimap", async ({
    page,
    tauri,
  }) => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      session(`session-${index}`),
    );
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", sessions);

    await page.goto("/");
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();

    const overview = page.getByRole("region", { name: "Canvas overview" });
    await expect(
      overview.getByTestId("workspace-canvas-minimap-node"),
    ).toHaveCount(20);
    const target = overview.getByRole("button", {
      name: "Show session-4 on canvas",
    });
    await expect(target).toHaveAttribute("aria-pressed", "false");
    const visual = target.locator("span[aria-hidden='true']");
    const box = await visual.boundingBox();
    if (!box) throw new Error("Dense minimap marker is not visible");

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(target).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByTestId("workspace-canvas")
        .getByRole("button", { name: "Move session-4" }),
    ).toHaveAttribute("aria-pressed", "true");
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
    await terminalSlot.evaluate((element) =>
      element.setAttribute("data-canvas-terminal-identity", "preserved"),
    );
    await page.getByRole("button", { name: "Reset session layout" }).click();

    await expect(alpha).toHaveAttribute("data-canvas-node-x", "48");
    await expect(alpha).toHaveAttribute("data-canvas-node-y", "48");
    await expect(world).toHaveAttribute("data-canvas-zoom", "1");

    await expect(
      page.getByRole("status").filter({ hasText: "Session layout reset." }),
    ).toBeVisible();
    const undo = page.getByRole("button", { name: "Undo reset" });
    await expect(undo).toBeVisible();
    await undo.click();

    await expect(alpha).toHaveAttribute("data-canvas-node-x", beforeReset.x!);
    await expect(alpha).toHaveAttribute("data-canvas-node-y", beforeReset.y!);
    await expect(world).toHaveAttribute("data-canvas-zoom", beforeReset.zoom!);
    await expect(terminalSlot).toHaveAttribute(
      "data-canvas-terminal-identity",
      "preserved",
    );

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
