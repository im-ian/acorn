import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { tauriMockSource } from "../e2e/fixtures/tauriMock";

const CAPTURE_DIR = process.env.ACORN_CAPTURE_DIR ?? "assets/screenshots";
const SELECTED_SCENES = new Set(
  (process.env.ACORN_CAPTURE_SCENES ?? "workspace,pr-modal,command-palette")
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

type SceneName = "workspace" | "pr-modal" | "command-palette";

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

    await bootCapturePage(page);
    await scene.prepare?.(page);
    await waitForStablePaint(page);

    mkdirSync(CAPTURE_DIR, { recursive: true });
    await page.screenshot({
      path: resolve(CAPTURE_DIR, scene.file),
      fullPage: false,
    });
  });
}

async function bootCapturePage(page: Page) {
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
          icons: { statusDot: true, agentProvider: true, sessionKind: true },
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
      window.localStorage.setItem("acorn-workspaces", JSON.stringify(${JSON.stringify(
        persistedWorkspace(),
      )}));
    })();`,
  });
  await page.addInitScript({ content: tauriMockSource });
  await page.addInitScript({ content: captureMockHandlersSource() });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: /workspace-polish/ }),
  ).toBeVisible();
}

async function waitForStablePaint(page: Page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250);
}

function folderId(repoPath: string, name: string) {
  return `project-folder:${repoPath}:${name}`;
}

function persistedWorkspace() {
  return {
    state: {
      workspaces: {
        [REPOS.app]: {
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
            "right-top": paneState(
              "right-top",
              ["agent-resume"],
              "agent-resume",
            ),
            "right-bottom": paneState(
              "right-bottom",
              ["api-contracts"],
              "api-contracts",
            ),
          },
          focusedPaneId: "left-main",
          rightTab: "files",
          rightTabByGroup: {
            code: "files",
            github: "prs",
            agents: "history",
          },
        },
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
          kind: "needs_input",
          status: "needs_input",
          previousStatus: "running",
          sessionName: "workspace-polish",
          projectName: "acorn-app",
          repoPath: REPOS.app,
          createdAt: "2026-06-01T11:55:00Z",
        },
      ],
      workspaceTabs: {},
    },
    version: 4,
  };
}

function paneState(id: string, tabIds: string[], activeTabId: string) {
  return { id, tabIds, activeTabId, activationHistory: tabIds };
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

function captureMockHandlersSource() {
  return `(() => {
    const repos = ${JSON.stringify(REPOS)};
    const now = ${JSON.stringify(NOW)};
    const handlers = window.__ACORN_MOCK_HANDLERS__ =
      window.__ACORN_MOCK_HANDLERS__ || {};
    const projectFolders = ${JSON.stringify(projectFolders())};
    const sessions = ${JSON.stringify(seedSessions())};

    function b64(input) {
      return btoa(unescape(encodeURIComponent(input)));
    }

    function emitPtyOutput(token, text) {
      const callback = window["_" + token];
      if (typeof callback === "function") {
        window.setTimeout(() => callback({ index: 0, message: b64(text) }), 40);
      }
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
    handlers.fs_git_status = () => ({
      statuses: {
        [repos.app + "/README.md"]: { kind: "modified", additions: 8, deletions: 2 },
        [repos.app + "/tests"]: { kind: "added", additions: 360, deletions: 0 },
        [repos.app + "/playwright.capture.config.ts"]: { kind: "added", additions: 35, deletions: 0 },
      },
      huge: false,
      limit: 10000,
    });
    handlers.fs_git_diff_stats = () => ({
      [repos.app + "/README.md"]: { additions: 8, deletions: 2 },
      [repos.app + "/tests"]: { additions: 360, deletions: 0 },
      [repos.app + "/playwright.capture.config.ts"]: { additions: 35, deletions: 0 },
    });
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

    const prs = [
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
    handlers.list_unscoped_agent_history = () => [];
    handlers.list_agent_history = () => [];
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

function seedSessions() {
  return [
    session("workspace-polish", "workspace-polish", REPOS.app, "main", {
      status: "needs_input",
      agent: "codex",
      position: 0,
    }),
    session("agent-resume", "agent-resume", REPOS.app, "main", {
      status: "running",
      agent: "claude",
      position: 1,
    }),
    session("api-contracts", "api-contracts", REPOS.app, "main", {
      status: "idle",
      agent: "claude",
      position: 2,
    }),
    session(
      "ui-snapshot",
      "ui-snapshot",
      REPOS.app,
      "feature/ui-capture",
      {
        status: "completed",
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
        status: "running",
        agent: "claude",
        position: 5,
        isolated: true,
        inWorktree: true,
        cwd: `${REPOS.app}/.acorn/worktrees/release-readme-captures`,
      },
    ),

    session("landing-refresh", "landing-refresh", REPOS.website, "main", {
      status: "running",
      agent: "codex",
      position: 0,
    }),
    session("landing-copy", "landing-copy", REPOS.website, "main", {
      status: "idle",
      agent: "codex",
      position: 2,
      cwd: `${REPOS.website}/apps/www`,
    }),
    session("site-build", "site-build", REPOS.website, "preview/readme", {
      status: "running",
      agent: "claude",
      position: 4,
      isolated: true,
      inWorktree: true,
      cwd: `${REPOS.website}/.acorn/worktrees/preview`,
    }),

    session("docs-outline", "docs-outline", REPOS.docs, "main", {
      status: "idle",
      agent: "codex",
      position: 0,
    }),
    session("install-flow", "install-flow", REPOS.docs, "main", {
      status: "needs_input",
      agent: "claude",
      position: 1,
    }),
    session("guide-refresh", "guide-refresh", REPOS.docs, "main", {
      status: "running",
      agent: "codex",
      position: 2,
      cwd: `${REPOS.docs}/guides`,
    }),
    session("api-reference", "api-reference", REPOS.docs, "api/reference", {
      status: "idle",
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
          status: index === 2 ? "running" : index === 4 ? "needs_input" : "idle",
          agent: index % 2 === 0 ? "claude" : "codex",
          position: index,
          projectScoped: false,
          cwd: REPOS.local,
        },
      ),
    ),
  ];
}

function session(
  id: string,
  name: string,
  repoPath: string,
  branch: string,
  options: {
    status: "idle" | "running" | "needs_input" | "failed" | "completed";
    agent: "claude" | "codex" | "antigravity";
    position: number;
    cwd?: string;
    isolated?: boolean;
    inWorktree?: boolean;
    projectScoped?: boolean;
    kind?: "regular" | "control";
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
    mode: "terminal",
    owner: { kind: "user" },
    position: options.position,
    in_worktree: options.inWorktree ?? false,
    agent_provider: options.agent,
    agent_transcript_id: `${options.agent}-${id}`,
  };
}
