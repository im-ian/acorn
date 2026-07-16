import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { tauriMockSource } from "../e2e/fixtures/tauriMock";
import { pressHotkey } from "../e2e/support";

const CAPTURE_DIR = process.env.ACORN_CAPTURE_DIR ?? "assets/screenshots";
const DEFAULT_SCENES = [
  "workspace",
  "kanban",
  "canvas",
  "pr-modal",
  "chat-session",
  "control-session",
  "staged-diff",
  "agent-history",
  "work-summary",
  "command-palette",
] as const;
const SELECTED_SCENES = new Set(
  (process.env.ACORN_CAPTURE_SCENES ?? DEFAULT_SCENES.join(","))
    .split(",")
    .map((scene) => scene.trim())
    .filter(Boolean),
);
const NOW = "2026-06-01T12:00:00Z";
const REPOS = {
  app: "/workspace/acorn-app",
  website: "/workspace/acorn-site",
  docs: "/workspace/acorn-docs",
  local: "/workspace/instant",
} as const;
const WORK_SUMMARY_TAB_ID = "work-summary:readme-workspace-polish";

type SceneName = (typeof DEFAULT_SCENES)[number];

interface CaptureScene {
  name: SceneName;
  file: string;
  prepare?: (page: Page) => Promise<void>;
}

const scenes: CaptureScene[] = [
  {
    name: "workspace",
    file: "workspace.png",
    prepare: async (page) => {
      const rightPanel = page.locator('[data-panel-id="right"]');
      await rightPanel.getByRole("button", { name: "Code", exact: true }).click();
      await rightPanel
        .getByRole("button", { name: "Files", exact: true })
        .click();
      await expect(
        rightPanel.getByRole("button", { name: "src", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator("aside").getByRole("button", { name: /workspace-polish/ }),
      ).toBeVisible();
    },
  },
  {
    name: "kanban",
    file: "kanban.png",
    prepare: async (page) => {
      const board = page.getByTestId("workspace-kanban");
      await expect(board).toBeVisible();
      await pressHotkey(page, { mod: true, key: "j" });
      await expect(
        page.locator('[data-kanban-session-id="kanban-capture"]'),
      ).toBeVisible();
      await expect(
        page.getByTestId("workspace-kanban-count-idle"),
      ).toHaveText("1");
      await expect(
        page.getByTestId("workspace-kanban-count-working"),
      ).toHaveText("1");
      await expect(
        page.getByTestId("workspace-kanban-count-waiting"),
      ).toHaveText("1");
      await expect(
        page.getByTestId("workspace-kanban-count-review"),
      ).toHaveText("1");
      await expect(
        page.getByTestId("workspace-kanban-count-done"),
      ).toHaveText("1");
      await expect(
        page.locator('[data-kanban-session-id="file-explorer-review"]')
          .getByTestId("workspace-kanban-card-pr"),
      ).toBeVisible();

      await board
        .getByRole("button", { name: "Open kanban-capture" })
        .click();
      const popover = page.getByTestId("kanban-terminal-popover");
      await expect(popover).toBeVisible();
      await expect(
        popover.locator(
          '[data-terminal-popover-body="kanban-capture"] [data-acorn-terminal-slot="kanban-capture"] .acorn-terminal-shell',
        ),
      ).toBeVisible();

      const dragHandle = popover.getByTestId(
        "kanban-terminal-popover-drag-handle",
      );
      const [popoverBox, dragHandleBox] = await Promise.all([
        popover.boundingBox(),
        dragHandle.boundingBox(),
      ]);
      if (!popoverBox || !dragHandleBox) {
        throw new Error("Kanban terminal popover is not measurable");
      }
      const targetLeft = (page.viewportSize()!.width - popoverBox.width) / 2;
      const targetTop = page.viewportSize()!.height - popoverBox.height - 40;
      await page.mouse.move(
        dragHandleBox.x + dragHandleBox.width / 2,
        dragHandleBox.y + dragHandleBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        dragHandleBox.x +
          dragHandleBox.width / 2 +
          targetLeft -
          popoverBox.x,
        dragHandleBox.y +
          dragHandleBox.height / 2 +
          targetTop -
          popoverBox.y,
      );
      await page.mouse.up();
      await expect
        .poll(async () => (await popover.boundingBox())?.y ?? 0)
        .toBeGreaterThan(500);
    },
  },
  {
    name: "canvas",
    file: "canvas.png",
    prepare: async (page) => {
      const canvas = page.getByTestId("workspace-canvas");
      await expect(canvas).toBeVisible();
      await pressHotkey(page, { mod: true, key: "j" });
      await expect(page.getByTestId("workspace-view-status")).toContainText(
        "Canvas",
      );
      await expect(canvas.getByTestId("workspace-canvas-node")).toHaveCount(3);
      await expect(
        canvas.locator('[data-canvas-session-id="canvas-orchestrator"]'),
      ).toContainText("canvas-orchestrator");
      await expect(
        canvas.locator(
          '[data-canvas-terminal-body="canvas-orchestrator"] [data-acorn-terminal-slot="canvas-orchestrator"] .acorn-terminal-shell',
        ),
      ).toBeVisible();
      await expect(canvas.getByTestId("workspace-canvas-minimap")).toBeVisible();
    },
  },
  {
    name: "pr-modal",
    file: "pr-modal.png",
    prepare: async (page) => {
      await page.getByRole("button", { name: "GitHub" }).click();
      await page.getByRole("button", { name: "PRs" }).click();
      await page.getByText("Polish README capture workflow").dblclick();
      await expect(
        page.getByRole("heading", {
          name: "Polish README capture workflow",
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Add deterministic README screenshots"),
      ).toBeVisible();
    },
  },
  {
    name: "chat-session",
    file: "chat-session.png",
    prepare: async (page) => {
      const chatPane = page.locator('[data-pane-body="chat-root"]');
      await expect(
        page.getByRole("button", { name: /Chat handoff review/ }).first(),
      ).toBeVisible();
      await expect(
        chatPane.getByText("Can you review the workspace split"),
      ).toBeVisible();
      await expect(
        chatPane.getByText("I checked the workspace layout"),
      ).toBeVisible();
    },
  },
  {
    name: "control-session",
    file: "control-session.png",
    prepare: async (page) => {
      const controlPane = page.locator('[data-pane-body="control-left"]');
      const uiPane = page.locator('[data-pane-body="control-right-top"]');
      const testPane = page.locator('[data-pane-body="control-right-middle"]');
      const docsPane = page.locator('[data-pane-body="control-right-bottom"]');
      await expect(
        page.locator("aside").getByRole("button", {
          name: /control-orchestrator/,
        }),
      ).toBeVisible();
      await expect(
        controlPane.getByText("$ acorn-ipc list-sessions"),
      ).toBeVisible();
      await expect(uiPane.getByText("$ codex --resume ui-worker")).toBeVisible();
      await expect(
        testPane.getByText("$ claude --continue test-runner"),
      ).toBeVisible();
      await expect(
        docsPane.getByText("$ codex --resume docs-refresh"),
      ).toBeVisible();
    },
  },
  {
    name: "staged-diff",
    file: "staged-diff.png",
    prepare: async (page) => {
      const rightPanel = page.locator('[data-panel-id="right"]');
      await rightPanel.getByRole("button", { name: "Code", exact: true }).click();
      await rightPanel
        .getByRole("button", { name: "Staged", exact: true })
        .click();
      await expect(
        rightPanel.locator("#staged-list").getByText("README.md"),
      ).toBeVisible();
      await expect(
        rightPanel.getByText("Automated with the capture CLI"),
      ).toBeVisible();
    },
  },
  {
    name: "agent-history",
    file: "agent-history.png",
    prepare: async (page) => {
      const rightPanel = page.locator('[data-panel-id="right"]');
      await rightPanel
        .getByRole("button", { name: "Agents", exact: true })
        .click();
      await rightPanel
        .getByRole("button", { name: "History", exact: true })
        .click();
      await expect(
        rightPanel.getByText("Refine workspace split behavior"),
      ).toBeVisible();
      await expect(
        rightPanel.getByText("Review resume flow edge cases"),
      ).toBeVisible();
    },
  },
  {
    name: "work-summary",
    file: "work-summary.png",
    prepare: async (page) => {
      const summaryPane = page.locator('[data-pane-body="summary-root"]');
      await expect(
        page.getByRole("button", { name: /Workspace work summary/ }),
      ).toBeVisible();
      await expect(
        summaryPane.getByText("workspace-polish", { exact: true }),
      ).toBeVisible();
      await expect(summaryPane.getByText("README.md")).toBeVisible();
      await expect(summaryPane.getByText("Tokens", { exact: true })).toBeVisible();
    },
  },
  {
    name: "command-palette",
    file: "command-palette.png",
    prepare: async (page) => {
      await page.evaluate(() => {
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "p",
            code: "KeyP",
            metaKey: isMac,
            ctrlKey: !isMac,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("New control session")).toBeVisible();
    },
  },
];

test.describe.configure({ mode: "serial" });

for (const scene of scenes) {
  test(scene.name, async ({ page }) => {
    test.skip(
      !SELECTED_SCENES.has(scene.name),
      `scene ${scene.name} was not requested`,
    );

    await bootCapturePage(page, scene.name);
    await scene.prepare?.(page);
    await waitForStablePaint(page);

    mkdirSync(CAPTURE_DIR, { recursive: true });
    await page.screenshot({
      path: resolve(CAPTURE_DIR, scene.file),
      fullPage: false,
    });
  });
}

async function bootCapturePage(page: Page, sceneName: SceneName) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript({
    content: `(() => {
      window.localStorage.clear();
      window.localStorage.setItem("acorn:settings:v1", JSON.stringify({
        language: "en",
        appearance: { themeId: "acorn-dark", uiScalePercent: 100 },
        experiments: { resumeModal: false, stickyPrompt: false },
        github: { refreshIntervalMs: 60000 },
        sessionDisplay: {
          title: "name",
          metadata: { branch: true, workingDirectory: false, status: true },
          showDetailsOnHover: true
        }
      }));
      window.localStorage.setItem("acorn:control-guide-dismissed-v1", "1");
      window.localStorage.setItem(
        "acorn:sidebar:collapsed-projects",
        JSON.stringify([${JSON.stringify(REPOS.docs)}])
      );
      window.localStorage.setItem(
        "acorn:sidebar:collapsed-project-folders",
        JSON.stringify(["${folderId(REPOS.website, "release")}"])
      );
      window.localStorage.setItem(
        "acorn:workspace-kanban:board-prefs:v2",
        JSON.stringify(${JSON.stringify({
          [REPOS.app]: {
            columnWidths: {
              idle: 180,
              working: 180,
              waiting: 180,
              review: 180,
              done: 180,
            },
            sortMode: "updated-desc",
            filterQuery: "",
            manualDoneSessionIds: ["release-v1.25"],
          },
        })})
      );
      window.localStorage.setItem("acorn-workspaces", JSON.stringify(${JSON.stringify(
        persistedWorkspace(sceneName),
      )}));
    })();`,
  });
  await page.addInitScript({ content: tauriMockSource });
  await page.addInitScript({ content: captureMockHandlersSource(sceneName) });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  const expectedSidebarSession =
    sceneName === "chat-session"
      ? /Chat handoff review/
      : sceneName === "control-session"
        ? /control-orchestrator/
        : sceneName === "kanban"
          ? /kanban-capture/
          : sceneName === "canvas"
            ? /canvas-orchestrator/
            : /workspace-polish/;
  await expect(
    page.locator("aside").getByRole("button", {
      name: expectedSidebarSession,
    }).first(),
  ).toBeVisible();
}

async function waitForStablePaint(page: Page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250);
}

function folderId(repoPath: string, name: string) {
  return `project-folder:${repoPath}:${name}`;
}

function persistedWorkspace(sceneName: SceneName) {
  return {
    state: {
      workspaces: {
        [REPOS.app]: appWorkspace(sceneName),
        [folderId(REPOS.app, "frontend")]: emptyWorkspace("ui-snapshot"),
        [folderId(REPOS.app, "release")]: emptyWorkspace("release-checks"),
        [REPOS.website]: emptyWorkspace("landing-refresh"),
        [folderId(REPOS.website, "marketing")]: emptyWorkspace("landing-copy"),
        [folderId(REPOS.website, "release")]: emptyWorkspace("site-build"),
        [REPOS.docs]: emptyWorkspace("docs-outline"),
        [folderId(REPOS.docs, "guides")]: emptyWorkspace("guide-refresh"),
        [folderId(REPOS.docs, "api")]: emptyWorkspace("api-reference"),
      },
      projectFolders: projectFolders(),
      sessionFolderIds: {
        "ui-snapshot": folderId(REPOS.app, "frontend"),
        "release-checks": folderId(REPOS.app, "release"),
        "landing-copy": folderId(REPOS.website, "marketing"),
        "site-build": folderId(REPOS.website, "release"),
        "guide-refresh": folderId(REPOS.docs, "guides"),
        "api-reference": folderId(REPOS.docs, "api"),
      },
      activeProject: REPOS.app,
      activeProjectFolderId: REPOS.app,
      rightTab: "files",
      rightTabByGroup: {
        code: "files",
        github: "prs",
        agents: "history",
      },
      sessionNotifications: [
        {
          id: "n-1",
          sessionId: "workspace-polish",
          kind: "waiting_for_input",
          status: "waiting_for_input",
          previousStatus: "working",
          sessionName: "workspace-polish",
          projectName: "acorn-app",
          repoPath: REPOS.app,
          createdAt: "2026-06-01T11:55:00Z",
        },
      ],
      workspaceTabs: workspaceTabs(sceneName),
    },
    version: 4,
  };
}

function appWorkspace(sceneName: SceneName) {
  if (sceneName === "kanban") {
    const sessionIds = [
      "plan-next-release",
      "kanban-capture",
      "release-copy",
      "file-explorer-review",
      "release-v1.25",
    ];
    return {
      layout: { kind: "pane", id: "kanban-root" },
      panes: {
        "kanban-root": paneState(
          "kanban-root",
          sessionIds,
          "kanban-capture",
        ),
      },
      focusedPaneId: "kanban-root",
      viewMode: "kanban",
      ...rightPanelWorkspaceState(),
    };
  }

  if (sceneName === "canvas") {
    const sessionIds = ["canvas-orchestrator", "canvas-ui", "canvas-tests"];
    return {
      layout: { kind: "pane", id: "canvas-root" },
      panes: {
        "canvas-root": paneState(
          "canvas-root",
          sessionIds,
          "canvas-orchestrator",
        ),
      },
      focusedPaneId: "canvas-root",
      viewMode: "canvas",
      canvas: {
        viewport: { offset: { x: 36, y: 44 }, zoom: 0.8 },
        nodes: {
          "canvas-orchestrator": {
            x: 48,
            y: 76,
            width: 720,
            height: 860,
            zIndex: 3,
          },
          "canvas-ui": {
            x: 820,
            y: 36,
            width: 620,
            height: 380,
            zIndex: 1,
          },
          "canvas-tests": {
            x: 880,
            y: 476,
            width: 560,
            height: 420,
            zIndex: 2,
          },
        },
      },
      ...rightPanelWorkspaceState(),
    };
  }

  if (sceneName === "chat-session") {
    return {
      layout: { kind: "pane", id: "chat-root" },
      panes: {
        "chat-root": paneState("chat-root", ["chat-handoff"], "chat-handoff"),
      },
      focusedPaneId: "chat-root",
      ...rightPanelWorkspaceState(),
    };
  }

  if (sceneName === "control-session") {
    return {
      layout: {
        kind: "split",
        id: "control-root-split",
        direction: "horizontal",
        sizes: [40, 60],
        a: { kind: "pane", id: "control-left" },
        b: {
          kind: "split",
          id: "control-right-stack-top",
          direction: "vertical",
          sizes: [34, 66],
          a: { kind: "pane", id: "control-right-top" },
          b: {
            kind: "split",
            id: "control-right-stack-bottom",
            direction: "vertical",
            sizes: [50, 50],
            a: { kind: "pane", id: "control-right-middle" },
            b: { kind: "pane", id: "control-right-bottom" },
          },
        },
      },
      panes: {
        "control-left": paneState(
          "control-left",
          ["control-orchestrator"],
          "control-orchestrator",
        ),
        "control-right-top": paneState(
          "control-right-top",
          ["ui-worker"],
          "ui-worker",
        ),
        "control-right-middle": paneState(
          "control-right-middle",
          ["test-runner"],
          "test-runner",
        ),
        "control-right-bottom": paneState(
          "control-right-bottom",
          ["docs-refresh"],
          "docs-refresh",
        ),
      },
      focusedPaneId: "control-left",
      ...rightPanelWorkspaceState(),
    };
  }

  if (sceneName === "work-summary") {
    return {
      layout: { kind: "pane", id: "summary-root" },
      panes: {
        "summary-root": paneState(
          "summary-root",
          [WORK_SUMMARY_TAB_ID],
          WORK_SUMMARY_TAB_ID,
        ),
      },
      focusedPaneId: "summary-root",
      ...rightPanelWorkspaceState(),
    };
  }

  return {
    layout: {
      kind: "split",
      id: "capture-root-split",
      direction: "horizontal",
      sizes: [62, 38],
      a: { kind: "pane", id: "left-main" },
      b: {
        kind: "split",
        id: "capture-right-stack",
        direction: "vertical",
        sizes: [50, 50],
        a: { kind: "pane", id: "right-top" },
        b: { kind: "pane", id: "right-bottom" },
      },
    },
    panes: {
      "left-main": paneState(
        "left-main",
        ["workspace-polish"],
        "workspace-polish",
      ),
      "right-top": paneState("right-top", ["agent-resume"], "agent-resume"),
      "right-bottom": paneState(
        "right-bottom",
        ["api-contracts"],
        "api-contracts",
      ),
    },
    focusedPaneId: "left-main",
    ...rightPanelWorkspaceState(),
  };
}

function workspaceTabs(sceneName: SceneName) {
  if (sceneName !== "work-summary") return {};
  return {
    [WORK_SUMMARY_TAB_ID]: {
      id: WORK_SUMMARY_TAB_ID,
      kind: "work-summary",
      lifecycle: "restorable",
      title: "Workspace work summary",
      repoPath: REPOS.app,
      cwdPath: REPOS.app,
      sessionId: "workspace-polish",
      tokenBaseline: {
        capturedAt: "2026-06-01T11:20:00Z",
        inputTokens: 3200,
        outputTokens: 1180,
        cacheReadTokens: 840,
        cacheCreationTokens: 220,
        reasoningTokens: 360,
        totalTokens: 5800,
        messagesWithUsage: 8,
      },
    },
  };
}

function paneState(id: string, tabIds: string[], activeTabId: string) {
  return { id, tabIds, activeTabId, activationHistory: tabIds };
}

function rightPanelWorkspaceState() {
  return {
    rightTab: "files",
    rightTabByGroup: {
      code: "files",
      github: "prs",
      agents: "history",
    },
  };
}

function emptyWorkspace(activeSessionId: string) {
  return {
    layout: { kind: "pane", id: "root" },
    panes: {
      root: paneState("root", [activeSessionId], activeSessionId),
    },
    focusedPaneId: "root",
    rightTab: "files",
    rightTabByGroup: {
      code: "files",
      github: "prs",
      agents: "history",
    },
  };
}

function projectFolders() {
  return {
    [REPOS.app]: [
      projectFolder(REPOS.app, REPOS.app, "Default", REPOS.app, 0),
      projectFolder(
        REPOS.app,
        folderId(REPOS.app, "frontend"),
        "Frontend workspace",
        `${REPOS.app}/packages/desktop`,
        1,
      ),
      projectFolder(
        REPOS.app,
        folderId(REPOS.app, "release"),
        "Release worktree",
        `${REPOS.app}/.acorn/worktrees/release-readme-captures`,
        2,
      ),
    ],
    [REPOS.website]: [
      projectFolder(REPOS.website, REPOS.website, "Default", REPOS.website, 0),
      projectFolder(
        REPOS.website,
        folderId(REPOS.website, "marketing"),
        "Marketing workspace",
        `${REPOS.website}/apps/www`,
        1,
      ),
      projectFolder(
        REPOS.website,
        folderId(REPOS.website, "release"),
        "Preview worktree",
        `${REPOS.website}/.acorn/worktrees/preview`,
        2,
      ),
    ],
    [REPOS.docs]: [
      projectFolder(REPOS.docs, REPOS.docs, "Default", REPOS.docs, 0),
      projectFolder(
        REPOS.docs,
        folderId(REPOS.docs, "guides"),
        "Guides workspace",
        `${REPOS.docs}/guides`,
        1,
      ),
      projectFolder(
        REPOS.docs,
        folderId(REPOS.docs, "api"),
        "API worktree",
        `${REPOS.docs}/.acorn/worktrees/api-reference`,
        2,
      ),
    ],
    [REPOS.local]: [
      projectFolder(REPOS.local, REPOS.local, "Default", REPOS.local, 0),
    ],
  };
}

function projectFolder(
  repoPath: string,
  id: string,
  name: string,
  cwdPath: string,
  position: number,
) {
  return { id, repoPath, name, cwdPath, position };
}

function chatStates() {
  return {
    "chat-handoff": {
      schema_version: 1,
      session_id: "chat-handoff",
      session: {
        id: "chat-handoff",
        workspace_path: REPOS.app,
        title: "Chat handoff review",
        active_provider: "claude",
        active_model: "sonnet",
        created_at: "2026-06-01T11:12:00Z",
        updated_at: "2026-06-01T11:59:00Z",
      },
      provider: "claude",
      model: "sonnet",
      messages: [
        chatMessage(
          "chat-user-1",
          "user",
          [
            "Can you review the workspace split behavior before I open the PR?",
            "",
            "Focus on pane persistence, tab handoff, and right-panel state.",
          ].join("\n"),
          "complete",
          "2026-06-01T11:20:00Z",
        ),
        chatMessage(
          "chat-assistant-1",
          "assistant",
          [
            "I checked the workspace layout state and the pane split helpers.",
            "",
            "- `focusedPaneId` is preserved across workspace switches",
            "- right-panel tab state now follows the active project",
            "- chat sessions skip terminal portal mounting",
            "",
            "Next I would add a focused capture scene for the single-pane chat flow.",
          ].join("\n"),
          "complete",
          "2026-06-01T11:22:00Z",
        ),
        chatMessage(
          "chat-user-2",
          "user",
          "Good. Also check whether this survives a reload with a collapsed docs project.",
          "complete",
          "2026-06-01T11:48:00Z",
        ),
        chatMessage(
          "chat-assistant-2",
          "assistant",
          "Running a reload pass now. The persisted layout shape looks stable.",
          "streaming",
          "2026-06-01T11:59:00Z",
        ),
      ],
      turns: [
        {
          id: "chat-turn-1",
          session_id: "chat-handoff",
          provider: "claude",
          model: "sonnet",
          status: "complete",
          user_message_id: "chat-user-1",
          assistant_message_id: "chat-assistant-1",
          started_at: "2026-06-01T11:20:00Z",
          completed_at: "2026-06-01T11:22:00Z",
          error: null,
        },
        {
          id: "chat-turn-2",
          session_id: "chat-handoff",
          provider: "claude",
          model: "sonnet",
          status: "running",
          user_message_id: "chat-user-2",
          assistant_message_id: "chat-assistant-2",
          started_at: "2026-06-01T11:58:00Z",
          completed_at: null,
          error: null,
        },
      ],
      provider_threads: [
        {
          session_id: "chat-handoff",
          provider: "claude",
          model: "sonnet",
          native_thread_id: "thread-readme-chat",
          resume_token: null,
          last_response_id: "resp-readme-chat",
          updated_at: "2026-06-01T11:59:00Z",
        },
      ],
      context_snapshots: [],
      memory: {
        session_id: "chat-handoff",
        summary: "Reviewed workspace split persistence and chat pane behavior.",
        important_decisions: [
          "Keep chat sessions in a single pane for the README capture.",
        ],
        facts: ["Right-panel state remains scoped to the active project."],
        through_message_id: "chat-assistant-1",
        updated_at: "2026-06-01T11:50:00Z",
      },
      created_at: "2026-06-01T11:12:00Z",
      updated_at: "2026-06-01T11:59:00Z",
    },
  };
}

function chatMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  status: "complete" | "streaming",
  createdAt: string,
) {
  return {
    id,
    session_id: "chat-handoff",
    turn_id: role === "user" ? null : id.replace("assistant", "turn"),
    role,
    content,
    created_at: createdAt,
    status,
    metadata: role === "assistant" ? { provider: "claude" } : null,
  };
}

function agentHistoryItems() {
  return [
    {
      provider: "codex",
      id: "codex-workspace-polish",
      title: "Refine workspace split behavior",
      preview:
        "Adjusted pane persistence, tab handoff, and README capture layout.",
      cwd: REPOS.app,
      worktree: {
        name: "feature/pane-dnd",
        path: `${REPOS.app}/.acorn/worktrees/pane-dnd`,
        exists: true,
      },
      transcript_path: `${REPOS.app}/.acorn/transcripts/codex-workspace-polish.jsonl`,
      updated_at: 1780314900,
      resume_command: "codex --resume codex-workspace-polish",
    },
    {
      provider: "claude",
      id: "claude-agent-resume",
      title: "Review resume flow edge cases",
      preview:
        "Checked stale status refresh, transcript lookup, and handoff behavior.",
      cwd: REPOS.app,
      worktree: null,
      transcript_path: `${REPOS.app}/.acorn/transcripts/claude-agent-resume.jsonl`,
      updated_at: 1780313700,
      resume_command: "claude --continue claude-agent-resume",
    },
    {
      provider: "codex",
      id: "codex-docs-refresh",
      title: "Refresh README screenshot notes",
      preview:
        "Documented isolated Playwright captures and review output paths.",
      cwd: REPOS.app,
      worktree: {
        name: "docs/screenshots",
        path: `${REPOS.app}/.acorn/worktrees/docs-screenshots`,
        exists: true,
      },
      transcript_path: `${REPOS.app}/.acorn/transcripts/codex-docs-refresh.jsonl`,
      updated_at: 1780312800,
      resume_command: "codex --resume codex-docs-refresh",
    },
  ];
}

function agentTranscriptSummaries() {
  return {
    "codex-workspace-polish": agentTranscriptSummary(
      "codex",
      "codex-workspace-polish",
      18,
      10840,
    ),
    "claude-agent-resume": agentTranscriptSummary(
      "claude",
      "claude-agent-resume",
      14,
      8420,
    ),
    "codex-docs-refresh": agentTranscriptSummary(
      "codex",
      "codex-docs-refresh",
      9,
      4380,
    ),
  };
}

function agentTranscriptSummary(
  provider: "claude" | "codex",
  id: string,
  messageCount: number,
  totalTokens: number,
) {
  return {
    provider,
    id,
    transcript_path: `${REPOS.app}/.acorn/transcripts/${id}.jsonl`,
    updated_at: 1780314900,
    message_count: messageCount,
    user_messages: Math.ceil(messageCount / 2),
    assistant_messages: Math.floor(messageCount / 2),
    turn_count: Math.floor(messageCount / 2),
    complete_turns: Math.max(1, Math.floor(messageCount / 2) - 1),
    running_turns: 1,
    token_usage: {
      input_tokens: Math.round(totalTokens * 0.42),
      output_tokens: Math.round(totalTokens * 0.21),
      cache_read_tokens: Math.round(totalTokens * 0.2),
      cache_creation_tokens: Math.round(totalTokens * 0.06),
      reasoning_tokens: Math.round(totalTokens * 0.11),
      total_tokens: totalTokens,
      messages_with_usage: messageCount,
    },
  };
}

function captureMockHandlersSource(sceneName: SceneName) {
  return `(() => {
    const repos = ${JSON.stringify(REPOS)};
    const now = ${JSON.stringify(NOW)};
    const sceneName = ${JSON.stringify(sceneName)};
    const handlers = window.__ACORN_MOCK_HANDLERS__ =
      window.__ACORN_MOCK_HANDLERS__ || {};
    const projectFolders = ${JSON.stringify(projectFolders())};
    const sessions = ${JSON.stringify(seedSessions(sceneName))};
    const chatStates = ${JSON.stringify(chatStates())};
    const agentHistory = ${JSON.stringify(agentHistoryItems())};
    const transcriptSummaries = ${JSON.stringify(agentTranscriptSummaries())};

    function b64(input) {
      return btoa(unescape(encodeURIComponent(input)));
    }

    function emitPtyOutput(token, text) {
      const callback = window["_" + token];
      if (typeof callback === "function") {
        window.setTimeout(() => callback({ index: 0, message: b64(text) }), 40);
      }
    }

    function emptyChatState(sessionId) {
      return {
        schema_version: 1,
        session_id: sessionId,
        session: {
          id: sessionId,
          workspace_path: repos.app,
          title: "Chat",
          active_provider: "claude",
          active_model: null,
          created_at: now,
          updated_at: now,
        },
        provider: "claude",
        model: null,
        messages: [],
        turns: [],
        provider_threads: [],
        context_snapshots: [],
        memory: {
          session_id: sessionId,
          summary: null,
          important_decisions: [],
          facts: [],
          through_message_id: null,
          updated_at: now,
        },
        created_at: now,
        updated_at: now,
      };
    }

    handlers.list_projects = () => [
      project(repos.app, "acorn-app", 0),
      project(repos.website, "acorn-site", 1),
      project(repos.docs, "acorn-docs", 2),
    ];
    handlers.list_sessions = () => sessions;
    handlers.detect_session_statuses = () =>
      sessions.map((s) => ({ id: s.id, status: s.status }));
    handlers.github_origin_slug = () => "im-ian/acorn";
    handlers.is_git_repository = () => true;
    handlers.pty_in_worktree_all = () => ({});
    handlers.pty_repo_root = (args) =>
      sessions.find((s) => s.id === args?.sessionId)?.repo_path ?? repos.app;
    handlers.pty_cwd = (args) =>
      sessions.find((s) => s.id === args?.sessionId)?.worktree_path ?? repos.app;
    handlers.git_worktrees = (args) => {
      const repo = args?.repoPath || repos.app;
      const folders = projectFolders[repo] || [];
      return folders.map((folder) => folder.cwdPath);
    };
    handlers.pty_subscribe_output = (args) => {
      const channel = args && args.channel;
      return typeof channel === "object" && channel && "id" in channel
        ? channel.id
        : 0;
    };
    handlers.pty_unsubscribe_output = () => undefined;
    handlers.pty_spawn = (args) => {
      const session = sessions.find((s) => s.id === args?.sessionId);
      const text = terminalText(session?.id || "workspace-polish");
      emitPtyOutput(args && args.outputToken, text);
      return undefined;
    };
    handlers.pty_resize = () => undefined;
    handlers.pty_write = () => undefined;
    handlers.pty_kill = () => undefined;
    handlers.scrollback_load = () => null;
    handlers.scrollback_save = () => undefined;
    handlers.load_chat_session_state = (args) =>
      chatStates[args?.sessionId] || emptyChatState(args?.sessionId || "chat");
    handlers.save_chat_session_state = (args) => args?.chatState;
    handlers.append_chat_message = (args) => {
      const state = chatStates[args?.sessionId] || emptyChatState(args?.sessionId || "chat");
      return { ...state, messages: [...state.messages, args?.message].filter(Boolean) };
    };
    handlers.send_chat_message = (args) => {
      const state = chatStates[args?.sessionId] || emptyChatState(args?.sessionId || "chat");
      return { ...state, messages: state.messages.concat({
        id: "capture-user-draft",
        session_id: args?.sessionId || "chat",
        turn_id: "capture-turn-draft",
        role: "user",
        content: args?.content || "",
        created_at: now,
        status: "complete",
        metadata: null,
      }) };
    };
    handlers.retry_chat_message = () => emptyChatState("chat");
    handlers.update_chat_message = (args) => {
      const state = chatStates[args?.sessionId] || emptyChatState(args?.sessionId || "chat");
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === args?.messageId ? { ...message, ...args?.patch } : message,
        ),
      };
    };
    handlers.delete_chat_message = (args) => {
      const state = chatStates[args?.sessionId] || emptyChatState(args?.sessionId || "chat");
      return {
        ...state,
        messages: state.messages.filter((message) => message.id !== args?.messageId),
      };
    };
    handlers.cancel_chat_message = (args) =>
      chatStates[args?.sessionId] || emptyChatState(args?.sessionId || "chat");

    handlers.fs_list_dir = (args) => {
      const path = args && args.path;
      if (path === repos.app) {
        return { repo_root: repos.app, entries: [
          fsEntry("src", repos.app + "/src", true),
          fsEntry("src-tauri", repos.app + "/src-tauri", true),
          fsEntry("tests", repos.app + "/tests", true),
          fsEntry("README.md", repos.app + "/README.md", false, 9208),
          fsEntry("package.json", repos.app + "/package.json", false, 2447),
          fsEntry("playwright.capture.config.ts", repos.app + "/playwright.capture.config.ts", false, 778),
        ] };
      }
      if (path === repos.app + "/src") {
        return { repo_root: repos.app, entries: [
          fsEntry("App.tsx", repos.app + "/src/App.tsx", false, 44112),
          fsEntry("components", repos.app + "/src/components", true),
          fsEntry("lib", repos.app + "/src/lib", true),
          fsEntry("store.ts", repos.app + "/src/store.ts", false, 112000),
        ] };
      }
      return { repo_root: repos.app, entries: [] };
    };
    handlers.fs_git_status = (args) => {
      if (sceneName === "kanban") {
        const reviewRoot = repos.app + "/.acorn/worktrees/file-explorer-review";
        return {
          statuses: args?.repoRoot === reviewRoot
            ? {
                [reviewRoot + "/src/components/FileExplorer.tsx"]: { kind: "modified" },
                [reviewRoot + "/tests/e2e/file-explorer.spec.ts"]: { kind: "modified" },
              }
            : {},
          huge: false,
          limit: 10000,
        };
      }
      return {
        statuses: {
          [repos.app + "/README.md"]: { kind: "modified", additions: 8, deletions: 2 },
          [repos.app + "/tests"]: { kind: "added", additions: 360, deletions: 0 },
          [repos.app + "/playwright.capture.config.ts"]: { kind: "added", additions: 35, deletions: 0 },
        },
        huge: false,
        limit: 10000,
      };
    };
    handlers.fs_git_diff_stats = (args) => {
      if (sceneName === "kanban") {
        const reviewRoot = repos.app + "/.acorn/worktrees/file-explorer-review";
        return args?.repoRoot === reviewRoot
          ? {
              [reviewRoot + "/src/components/FileExplorer.tsx"]: { additions: 84, deletions: 19 },
              [reviewRoot + "/tests/e2e/file-explorer.spec.ts"]: { additions: 46, deletions: 4 },
            }
          : {};
      }
      return {
        [repos.app + "/README.md"]: { additions: 8, deletions: 2 },
        [repos.app + "/tests"]: { additions: 360, deletions: 0 },
        [repos.app + "/playwright.capture.config.ts"]: { additions: 35, deletions: 0 },
      };
    };
    handlers.fs_git_branch = () => "main";
    handlers.fs_read_file = () => ({
      content: "# Acorn\\n\\nDeterministic screenshots for README assets.\\n",
      size: 56,
      truncated: false,
      binary: false,
    });

    handlers.list_commits = () => [
      {
        sha: "8f4f8b7f4c7e4d6c8a0a6b1c2d3e4f5061728394",
        short_sha: "8f4f8b7",
        author: "Ian",
        author_email: "ian@example.com",
        timestamp: 1780309860,
        summary: "docs(readme): refresh workspace screenshots",
        body: "Capture the primary workspace and PR detail flow with deterministic sample data.",
        pushed: false,
      },
    ];
    handlers.resolve_commit_logins = () => ({
      "8f4f8b7f4c7e4d6c8a0a6b1c2d3e4f5061728394": "im-ian",
    });
    handlers.list_staged = () => [
      { path: "README.md", status: "modified" },
      { path: "tests/captures/readme.spec.ts", status: "added" },
      { path: "playwright.capture.config.ts", status: "added" },
    ];
    handlers.staged_file_diff = () => diffPayload();
    handlers.staged_diff = () => diffPayload();
    handlers.commit_diff = () => diffPayload();

    const prs = sceneName === "kanban" ? [
      {
        number: 592,
        title: "Polish File Explorer search and media previews",
        state: "OPEN",
        author: "im-ian",
        head_branch: "feat/file-explorer-review",
        base_branch: "main",
        url: "https://github.com/im-ian/acorn/pull/592",
        updated_at: now,
        is_draft: false,
        checks: { passed: 12, failed: 0, pending: 0 },
        labels: [{ name: "enhancement", color: "84b6eb" }],
      },
      {
        number: 589,
        title: "Prepare the v1.25 release",
        state: "MERGED",
        author: "im-ian",
        head_branch: "release/v1.25.0",
        base_branch: "main",
        url: "https://github.com/im-ian/acorn/pull/589",
        updated_at: now,
        is_draft: false,
        checks: { passed: 14, failed: 0, pending: 0 },
        labels: [{ name: "build", color: "5319e7" }],
      },
    ] : [
      {
        number: 278,
        title: "Polish README capture workflow",
        state: "OPEN",
        author: "im-ian",
        head_branch: "capture/readme-assets",
        base_branch: "main",
        url: "https://github.com/im-ian/acorn/pull/278",
        updated_at: now,
        is_draft: false,
        checks: { passed: 10, failed: 0, pending: 1 },
        labels: [
          { name: "docs", color: "0075ca" },
          { name: "automation", color: "a2eeef" },
        ],
      },
    ];
    handlers.list_pull_requests = () => ({
      kind: "ok",
      items: prs,
      account: "im-ian",
    });
    handlers.get_pull_request_detail = () => ({
      kind: "ok",
      account: "im-ian",
      detail: pullRequestDetail(),
    });
    handlers.get_pull_request_diff = () => ({
      kind: "ok",
      account: "im-ian",
      diff: diffPayload(),
    });
    handlers.list_issues = () => ({
      kind: "ok",
      account: "im-ian",
      items: [],
    });
    handlers.list_workflow_runs = () => ({
      kind: "ok",
      account: "im-ian",
      items: [],
    });
    handlers.list_unscoped_agent_history = () => agentHistory;
    handlers.list_agent_history = () => agentHistory;
    handlers.agent_transcript_summary = (args) =>
      transcriptSummaries[args?.transcriptId] || null;
    handlers.agent_transcript_summary_at_path = (args) =>
      transcriptSummaries[args?.id] || null;
    handlers.read_session_todos = () => [
      { content: "Seed screenshot fixture data", status: "completed", activeForm: null },
      { content: "Capture Files panel", status: "in_progress", activeForm: "Capturing Files panel" },
    ];
    handlers.get_memory_usage = () => ({
      rss_bytes: 184000000,
      sessions: [],
      scrollback_disk_bytes: 42000,
    });
    handlers.get_agent_token_usage = () => ({
      metrics: [],
      updated_at: 1780309860,
    });

    function project(repo_path, name, position) {
      return {
        repo_path,
        name,
        created_at: "2026-06-01T10:00:00Z",
        position,
      };
    }

    function fsEntry(name, path, isDir, size = 0) {
      return {
        name,
        path,
        is_dir: isDir,
        is_symlink: false,
        size,
        modified_ms: 1780309860000,
        gitignored: false,
      };
    }

    function diffPayload() {
      return {
        files: [{
          old_path: "README.md",
          new_path: "README.md",
          is_image: false,
          patch: "@@ -18,6 +18,8 @@\\n ## Screenshots\\n+Automated with the capture CLI.\\n+Sample data is isolated from the host.\\n",
        }],
      };
    }

    function pullRequestDetail() {
      return {
        number: 278,
        title: "Polish README capture workflow",
        body: "Add deterministic README screenshots generated from a mocked browser environment.\\n\\n- [x] Seed realistic project/session state\\n- [x] Capture the main workspace\\n- [ ] Refresh the README asset table",
        state: "OPEN",
        is_draft: false,
        author: "im-ian",
        head_branch: "capture/readme-assets",
        base_branch: "main",
        url: "https://github.com/im-ian/acorn/pull/278",
        created_at: "2026-06-01T09:30:00Z",
        updated_at: now,
        merged_at: null,
        additions: 412,
        deletions: 28,
        changed_files: 4,
        mergeable: "MERGEABLE",
        labels: [
          { name: "docs", color: "0075ca" },
          { name: "automation", color: "a2eeef" },
        ],
        comments: [],
        reviews: [],
        checks: [
          check("Typecheck", "COMPLETED", "SUCCESS"),
          check("Vitest", "COMPLETED", "SUCCESS"),
          check("Playwright captures", "IN_PROGRESS", null),
        ],
        commits: [
          {
            oid: "8f4f8b7f4c7e4d6c8a0a6b1c2d3e4f5061728394",
            message_headline: "Add deterministic README screenshots",
            message_body: "Drive Acorn through Playwright with Tauri mock data.",
            committed_date: "2026-06-01T10:00:00Z",
            authors: [{ name: "Ian", email: "ian@example.com", login: "im-ian" }],
          },
        ],
      };
    }

    function check(name, status, conclusion) {
      return {
        name,
        status,
        conclusion,
        started_at: "2026-06-01T11:50:00Z",
        completed_at: conclusion ? "2026-06-01T11:54:00Z" : null,
        url: "https://github.com/im-ian/acorn/actions",
        workflow_name: "CI",
      };
    }

    function terminalText(id) {
      if (id === "kanban-capture") {
        return [
          "$ codex",
          "Task: make Kanban progress legible at a glance",
          "",
          "✓ Idle · Working · Waiting · Review · Done",
          "✓ PR and diff context attached to review cards",
          "✓ Lifecycle board stays visible",
          "",
          "$ pnpm exec playwright test tests/e2e/kanban.spec.ts",
          "PASS  kanban lifecycle + terminal popover",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "canvas-orchestrator") {
        return [
          "$ codex",
          "Task: compose the release workspace on canvas",
          "",
          "Three live sessions, one spatial workspace",
          "",
          "✓ arrange terminals around the task",
          "✓ resize the primary implementation session",
          "✓ navigate the workspace from the minimap",
          "",
          "$ git status --short",
          " M src/components/WorkspaceCanvas.tsx",
          " M tests/e2e/canvas.spec.ts",
          "",
          "Waiting for final visual review...",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "canvas-ui") {
        return [
          "$ claude --continue canvas-ui",
          "Polishing canvas navigation",
          "",
          "Editing WorkspaceCanvasMinimap.tsx",
          "Adding fit-to-view and reset undo",
          "",
          "$ pnpm run typecheck",
          "PASS WorkspaceCanvas.tsx",
          "PASS WorkspaceCanvasMinimap.tsx",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "canvas-tests") {
        return [
          "$ pnpm exec playwright test tests/e2e/canvas.spec.ts",
          "",
          "✓ moves and resizes terminal nodes",
          "✓ restores zoom and viewport position",
          "✓ navigates sessions from the minimap",
          "",
          "12 passed (8.4s)",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "control-orchestrator") {
        return [
          "$ acorn-ipc promote --self",
          "promoted control-orchestrator to control session",
          "",
          "$ acorn-ipc list-sessions",
          "ui-worker       running   codex",
          "test-runner     running   claude",
          "docs-refresh    idle      codex",
          "",
          "$ acorn-ipc send-input ui-worker",
          "task: tighten the pane drag target",
          "",
          "$ acorn-ipc send-input test-runner",
          "task: run focused regression tests",
          "",
          "$ acorn-ipc read-buffer ui-worker",
          "Applying WorkspaceGrid patch...",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "ui-worker") {
        return [
          "$ codex --resume ui-worker",
          "Task: tighten the pane drag target",
          "Reading PaneDropOverlay.tsx",
          "Editing WorkspaceGrid.tsx",
          "",
          "$ pnpm exec vitest run PaneDropOverlay",
          "PASS PaneDropOverlay.test.tsx (9 tests) 538ms",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "test-runner") {
        return [
          "$ claude --continue test-runner",
          "Running focused regression checks",
          "",
          "$ pnpm exec vitest run workspaces",
          "PASS workspaces.test.ts (18 tests) 412ms",
          "",
          "$ pnpm run typecheck",
          "PASS src/store/workspaces.ts",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "docs-refresh") {
        return [
          "$ codex --resume docs-refresh",
          "Task: update README screenshot notes",
          "",
          "$ rg capture:readme docs package.json",
          "docs/README_SCREENSHOTS.md",
          "package.json",
          "",
          "$ git diff -- docs/README_SCREENSHOTS.md",
          "README screenshot workflow documented",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "api-contracts") {
        return [
          "$ cargo test session_contracts",
          "test maps_workspace_folder ... ok",
          "test returns_git_status_counts ... ok",
          "",
          "$ pnpm exec vitest run api-contracts",
          "PASS api-contracts.test.ts (12 tests) 684ms",
          "",
          "$ rg list_sessions src-tauri",
          "src-tauri/src/commands/sessions.rs",
          "42: async fn list_sessions(state)",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "release-checks") {
        return [
          "$ gh run watch 9832",
          "CI / typecheck passed in 1m 18s",
          "CI / playwright smoke passed in 2m 14s",
          "",
          "$ pnpm run build",
          "vite v7.2.4 building for production...",
          "DONE 1834 modules transformed",
        ].join("\\r\\n") + "\\r\\n";
      }
      if (id === "agent-resume") {
        return [
          "$ claude --continue agent-resume",
          "Claude Code is reading the resume flow",
          "Plan:",
          "1. inspect pane handoff state",
          "2. patch stale status refresh",
          "3. run focused typecheck",
          "",
          "$ rg resume src src-tauri",
          "src/lib/sessionActions.ts",
          "78: export async function resumeSession(id)",
          "src-tauri/src/commands/pty.rs",
          "214: async fn resume_session(id)",
          "",
          "$ pnpm run typecheck",
          "PASS ResumeDialog.tsx",
          "PASS workspaces.ts",
        ].join("\\r\\n") + "\\r\\n";
      }
      return [
        "$ codex",
        "Task: refine workspace split behavior",
        "Reading src/store/workspaces.ts",
        "Editing WorkspaceGrid.tsx",
        "",
        "$ pnpm exec vitest run src/store/workspaces.test.ts",
        "PASS workspaces.test.ts (18 tests) 412ms",
        "",
        "$ git diff --stat",
        " src/components/workspace/WorkspaceGrid.tsx | 42 +++++++++---",
        " src/store/workspaces.ts                  | 18 ++++--",
        " 2 files changed, 46 insertions(+), 14 deletions(-)",
        "",
        "$ pnpm exec eslint src/components/workspace --fix",
      ].join("\\r\\n") + "\\r\\n";
    }
  })();`;
}

function seedSessions(sceneName: SceneName) {
  const baseSessions = [
    session("workspace-polish", "workspace-polish", REPOS.app, "main", {
      status: "waiting_for_input",
      agent: "codex",
      position: 0,
    }),
    session("agent-resume", "agent-resume", REPOS.app, "main", {
      status: "working",
      agent: "claude",
      position: 1,
    }),
    session("api-contracts", "api-contracts", REPOS.app, "main", {
      status: "ready",
      agent: "claude",
      position: 2,
    }),
    session(
      "ui-snapshot",
      "ui-snapshot",
      REPOS.app,
      "feature/ui-capture",
      {
        status: "ready",
        agent: "codex",
        position: 3,
        cwd: `${REPOS.app}/packages/desktop`,
      },
    ),
    session(
      "release-checks",
      "release-checks",
      REPOS.app,
      "release/readme-captures",
      {
        status: "working",
        agent: "claude",
        position: 5,
        isolated: true,
        inWorktree: true,
        cwd: `${REPOS.app}/.acorn/worktrees/release-readme-captures`,
      },
    ),

    session("landing-refresh", "landing-refresh", REPOS.website, "main", {
      status: "working",
      agent: "codex",
      position: 0,
    }),
    session("landing-copy", "landing-copy", REPOS.website, "main", {
      status: "ready",
      agent: "codex",
      position: 2,
      cwd: `${REPOS.website}/apps/www`,
    }),
    session("site-build", "site-build", REPOS.website, "preview/readme", {
      status: "working",
      agent: "claude",
      position: 4,
      isolated: true,
      inWorktree: true,
      cwd: `${REPOS.website}/.acorn/worktrees/preview`,
    }),

    session("docs-outline", "docs-outline", REPOS.docs, "main", {
      status: "ready",
      agent: "codex",
      position: 0,
    }),
    session("install-flow", "install-flow", REPOS.docs, "main", {
      status: "waiting_for_input",
      agent: "claude",
      position: 1,
    }),
    session("guide-refresh", "guide-refresh", REPOS.docs, "main", {
      status: "working",
      agent: "codex",
      position: 2,
      cwd: `${REPOS.docs}/guides`,
    }),
    session("api-reference", "api-reference", REPOS.docs, "api/reference", {
      status: "ready",
      agent: "claude",
      position: 3,
      isolated: true,
      inWorktree: true,
      cwd: `${REPOS.docs}/.acorn/worktrees/api-reference`,
    }),

    ...[1, 2, 3, 4, 5].map((index) =>
      session(
        `instant-${index}`,
        `instant-${index}`,
        REPOS.local,
        "HEAD",
        {
          status:
            index === 2
              ? "working"
              : index === 4
                ? "waiting_for_input"
                : "ready",
          agent: index % 2 === 0 ? "claude" : "codex",
          position: index,
          projectScoped: false,
          cwd: REPOS.local,
        },
      ),
    ),
  ];

  if (sceneName === "kanban") {
    return [
      {
        ...session("plan-next-release", "plan-next-release", REPOS.app, "main", {
          status: "ready",
          agent: "claude",
          position: 0,
        }),
        agent_transcript_id: null,
      },
      {
        ...session("kanban-capture", "kanban-capture", REPOS.app, "feat/kanban-capture", {
          status: "working",
          agent: "codex",
          position: 1,
        }),
        last_user_message: "Add a deterministic Kanban screenshot",
        last_agent_message: "Seeding lifecycle cards and PR metadata",
      },
      {
        ...session("release-copy", "release-copy", REPOS.app, "docs/release-copy", {
          status: "errored",
          agent: "claude",
          position: 2,
        }),
        last_user_message: "Refresh the Korean release copy",
        last_agent_message: "Waiting for a headline decision",
      },
      {
        ...session(
          "file-explorer-review",
          "file-explorer-review",
          REPOS.app,
          "feat/file-explorer-review",
          {
            status: "ready",
            agent: "codex",
            position: 3,
            isolated: true,
            inWorktree: true,
            cwd: `${REPOS.app}/.acorn/worktrees/file-explorer-review`,
          },
        ),
        last_user_message: "Polish search and media previews",
        last_agent_message: "Implementation is ready for review",
      },
      {
        ...session("release-v1.25", "release-v1.25", REPOS.app, "release/v1.25.0", {
          status: "ready",
          agent: "claude",
          position: 4,
          isolated: true,
          inWorktree: true,
          cwd: `${REPOS.app}/.acorn/worktrees/release-v1.25`,
        }),
        last_user_message: "Prepare the v1.25 release",
        last_agent_message: "PR merged and release notes published",
      },
      ...baseSessions.filter((candidate) => candidate.repo_path !== REPOS.app),
    ];
  }

  if (sceneName === "canvas") {
    return [
      session(
        "canvas-orchestrator",
        "canvas-orchestrator",
        REPOS.app,
        "feat/canvas-workspace",
        {
          status: "waiting_for_input",
          agent: "codex",
          position: 0,
        },
      ),
      session("canvas-ui", "canvas-ui", REPOS.app, "feat/canvas-minimap", {
        status: "working",
        agent: "claude",
        position: 1,
        isolated: true,
        inWorktree: true,
        cwd: `${REPOS.app}/.acorn/worktrees/canvas-ui`,
      }),
      session(
        "canvas-tests",
        "canvas-tests",
        REPOS.app,
        "test/canvas-layout",
        {
          status: "ready",
          agent: "codex",
          position: 2,
          isolated: true,
          inWorktree: true,
          cwd: `${REPOS.app}/.acorn/worktrees/canvas-tests`,
        },
      ),
      ...baseSessions.filter((candidate) => candidate.repo_path !== REPOS.app),
    ];
  }

  if (sceneName === "chat-session") {
    return [
      session("chat-handoff", "Chat handoff review", REPOS.app, "main", {
        status: "working",
        agent: "claude",
        position: 0,
        mode: "chat",
      }),
      ...baseSessions.filter((candidate) => candidate.repo_path !== REPOS.app),
    ];
  }

  if (sceneName === "control-session") {
    const controlOwner = {
      kind: "control" as const,
      session_id: "control-orchestrator",
    };
    return [
      session(
        "control-orchestrator",
        "control-orchestrator",
        REPOS.app,
        "main",
        {
          status: "working",
          agent: "codex",
          position: 0,
          kind: "control",
        },
      ),
      session("ui-worker", "ui-worker", REPOS.app, "feature/pane-dnd", {
        status: "working",
        agent: "codex",
        position: 1,
        owner: controlOwner,
      }),
      session("test-runner", "test-runner", REPOS.app, "main", {
        status: "working",
        agent: "claude",
        position: 2,
        owner: controlOwner,
      }),
      session("docs-refresh", "docs-refresh", REPOS.app, "docs/screenshots", {
        status: "ready",
        agent: "codex",
        position: 3,
        owner: controlOwner,
      }),
      ...baseSessions.filter((candidate) => candidate.repo_path !== REPOS.app),
    ];
  }

  if (sceneName === "work-summary") {
    return [
      ...baseSessions.filter(
        (candidate) =>
          candidate.repo_path !== REPOS.app ||
          candidate.id === "workspace-polish",
      ),
    ];
  }

  return baseSessions;
}

function session(
  id: string,
  name: string,
  repoPath: string,
  branch: string,
  options: {
    status: "ready" | "working" | "waiting_for_input" | "errored";
    agent: "claude" | "codex" | "antigravity";
    position: number;
    cwd?: string;
    isolated?: boolean;
    inWorktree?: boolean;
    projectScoped?: boolean;
    kind?: "regular" | "control";
    mode?: "terminal" | "chat";
    owner?: { kind: "user" } | { kind: "control"; session_id: string };
  },
) {
  const cwd = options.cwd ?? repoPath;
  return {
    id,
    name,
    repo_path: repoPath,
    worktree_path: cwd,
    branch,
    isolated: options.isolated ?? false,
    project_scoped: options.projectScoped ?? true,
    status: options.status,
    created_at: `2026-06-01T10:${String(options.position).padStart(2, "0")}:00Z`,
    updated_at: "2026-06-01T11:58:00Z",
    last_message: null,
    title_source: "generated",
    auto_title_enabled: true,
    generated_title_transcript_id: `${options.agent}-${id}`,
    kind: options.kind ?? "regular",
    mode: options.mode ?? "terminal",
    owner: options.owner ?? { kind: "user" },
    position: options.position,
    in_worktree: options.inWorktree ?? false,
    agent_provider: options.agent,
    agent_transcript_id: `${options.agent}-${id}`,
  };
}
