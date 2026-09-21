import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { tauriMockSource } from "../e2e/fixtures/tauriMock";
import { pressHotkey } from "../e2e/support";

const CAPTURE_DIR =
  process.env.ACORN_CAPTURE_DIR ?? "assets/screenshots/trackers";
const NOW = "2026-09-21T10:30:00Z";
const REPO = "/workspace/acorn-app";

const LINEAR_ISSUES = [
  {
    id: "lin-184",
    identifier: "JTF-184",
    title: "우측 패널 Linear / Jira 이슈 탭",
    state: "In Progress",
    state_type: "started",
    author: "Ian",
    url: "https://linear.app/jtf/issue/JTF-184",
    created_at: "2026-09-18T09:00:00Z",
    updated_at: "2026-09-21T09:40:00Z",
    comments: 2,
    labels: [
      { name: "frontend", color: "5E6AD2" },
      { name: "acorn", color: "26B5CE" },
    ],
    assignee: "Ian",
  },
  {
    id: "lin-179",
    identifier: "JTF-179",
    title: "트래커 토큰을 OS 키체인에 저장",
    state: "Todo",
    state_type: "unstarted",
    author: "Ian",
    url: "https://linear.app/jtf/issue/JTF-179",
    created_at: "2026-09-16T11:00:00Z",
    updated_at: "2026-09-20T16:10:00Z",
    comments: 0,
    labels: [{ name: "security", color: "EB5757" }],
    assignee: "Ian",
  },
  {
    id: "lin-166",
    identifier: "JTF-166",
    title: "이슈 상세 모달 댓글 작성",
    state: "Done",
    state_type: "completed",
    author: "Mina",
    url: "https://linear.app/jtf/issue/JTF-166",
    created_at: "2026-09-12T08:20:00Z",
    updated_at: "2026-09-19T14:00:00Z",
    comments: 4,
    labels: [{ name: "frontend", color: "5E6AD2" }],
    assignee: "Mina",
  },
];

const JIRA_ISSUES = [
  {
    id: "ACORN-12",
    identifier: "ACORN-12",
    title: "Jira 검색을 scoped token URL로 전환",
    state: "In Progress",
    state_type: "started",
    author: "Ian",
    url: "https://acme.atlassian.net/browse/ACORN-12",
    created_at: "2026-09-17T10:00:00Z",
    updated_at: "2026-09-21T08:15:00Z",
    comments: 1,
    labels: [{ name: "backend", color: "808080" }],
    assignee: "Ian",
  },
  {
    id: "ACORN-9",
    identifier: "ACORN-9",
    title: "프로젝트 키 매핑 UI",
    state: "To Do",
    state_type: "unstarted",
    author: "Mina",
    url: "https://acme.atlassian.net/browse/ACORN-9",
    created_at: "2026-09-14T13:00:00Z",
    updated_at: "2026-09-20T11:45:00Z",
    comments: 0,
    labels: [{ name: "ui", color: "808080" }],
    assignee: null,
  },
  {
    id: "ACORN-4",
    identifier: "ACORN-4",
    title: "ADF 본문을 텍스트로 평탄화",
    state: "Done",
    state_type: "completed",
    author: "Ian",
    url: "https://acme.atlassian.net/browse/ACORN-4",
    created_at: "2026-09-08T09:30:00Z",
    updated_at: "2026-09-18T17:20:00Z",
    comments: 3,
    labels: [{ name: "backend", color: "808080" }],
    assignee: "Ian",
  },
];

function trackerHandlersSource(): string {
  return `(() => {
  const handlers = window.__ACORN_MOCK_HANDLERS__ = window.__ACORN_MOCK_HANDLERS__ || {};
  const repo = ${JSON.stringify(REPO)};
  const linearIssues = ${JSON.stringify(LINEAR_ISSUES)};
  const jiraIssues = ${JSON.stringify(JIRA_ISSUES)};
  handlers.list_projects = () => ([
    {
      repo_path: repo,
      name: "acorn",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  handlers.list_sessions = () => ([
    {
      id: "s-1",
      name: "jtf-184-right-panel",
      repo_path: repo,
      worktree_path: repo,
      branch: "jtf-184-right-panel",
      isolated: false,
      status: "ready",
      created_at: "2026-09-21T09:00:00Z",
      updated_at: "2026-09-21T09:05:00Z",
      last_message: null,
    },
  ]);
  handlers.github_origin_slug = () => "im-ian/acorn";
  handlers.is_git_repository = () => true;
  handlers.pty_repo_root = () => repo;
  handlers.get_tracker_accounts = () => ({
    linear: { connected: true, viewer: "Ian", workspace: "JTF" },
    jira: {
      connected: true,
      email: "ian@acme.com",
      site: "acme.atlassian.net",
      display_name: "Ian",
    },
  });
  handlers.get_project_settings = () => ({
    key: "github:im-ian/acorn",
    settings: {
      remember_after_close: true,
      pull_requests: { generation_prompt: null },
      worktrees: { base_branch: null },
      start_work: { agent_prompt: null },
      linear: {
        team_id: "team-jtf",
        team_key: "JTF",
        team_name: "Frontend",
      },
      jira: {
        project_key: "ACORN",
        project_name: "Acorn",
      },
    },
  });
  handlers.list_linear_issues = (args) => {
    const state = args?.state || "open";
    const items = linearIssues.filter((issue) => {
      if (state === "open") return issue.state_type !== "completed";
      if (state === "closed") return issue.state_type === "completed";
      return true;
    });
    return { kind: "ok", items, account: "Ian" };
  };
  handlers.list_jira_issues = (args) => {
    const state = args?.state || "open";
    const items = jiraIssues.filter((issue) => {
      if (state === "open") return issue.state_type !== "completed";
      if (state === "closed") return issue.state_type === "completed";
      return true;
    });
    return { kind: "ok", items, account: "Ian" };
  };
  handlers.get_linear_issue = (args) => {
    const issue = linearIssues.find((item) => item.id === args?.id) || linearIssues[0];
    return {
      kind: "ok",
      account: "Ian",
      detail: {
        ...issue,
        body: "우측 패널에 GitHub Issues와 같은 Linear 목록과 상세 모달을 붙입니다.\\n\\n- 키체인은 Settings JSON이 아니라 OS 비밀 저장소\\n- 프로젝트 매핑은 Linear team key",
        comments: [
          {
            id: "c1",
            author: "Ian",
            body: "토큰은 렌더러로 다시 내려주지 않습니다.",
            created_at: "2026-09-19T11:00:00Z",
            url: null,
          },
          {
            id: "c2",
            author: "Mina",
            body: "브랜치 \`jtf-184-right-panel\`에서 현재 이슈를 강조하면 좋겠습니다.",
            created_at: "2026-09-20T08:30:00Z",
            url: null,
          },
        ],
        assignees: issue.assignee ? [issue.assignee] : [],
      },
    };
  };
  handlers.get_jira_issue = (args) => {
    const issue = jiraIssues.find((item) => item.id === args?.id) || jiraIssues[0];
    return {
      kind: "ok",
      account: "Ian",
      detail: {
        ...issue,
        body: "scoped API token은 api.atlassian.com/ex/jira/{cloudId} 를 사용합니다.",
        comments: [
          {
            id: "1",
            author: "Ian",
            body: "classic 토큰은 사이트 URL로 먼저 프로브합니다.",
            created_at: "2026-09-18T10:00:00Z",
            url: null,
          },
        ],
        assignees: issue.assignee ? [issue.assignee] : [],
      },
    };
  };
})();`;
}

async function boot(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route(
    "https://api.github.com/repos/im-ian/acorn/releases/latest",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tag_name: "v0.0.0",
          body: "",
          html_url: "https://github.com/im-ian/acorn/releases/tag/v0.0.0",
          published_at: "2026-01-01T00:00:00Z",
        }),
      }),
  );
  await page.addInitScript({
    content: `(() => {
      window.localStorage.clear();
      window.localStorage.setItem("acorn:settings:v1", JSON.stringify({
        language: "ko",
        appearance: { themeId: "acorn-dark", uiScalePercent: 100 },
        experiments: { resumeModal: false, stickyPrompt: false },
        github: { refreshIntervalMs: 60000, showAvatars: true, showLabels: true },
      }));
      window.localStorage.setItem("acorn:control-guide-dismissed-v1", "1");
    })();`,
  });
  await page.addInitScript({ content: tauriMockSource });
  await page.addInitScript({ content: trackerHandlersSource() });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "프로젝트" })).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: /jtf-184-right-panel/ }),
  ).toBeVisible();
}

async function waitForStablePaint(page: Page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(300);
}

async function capture(page: Page, file: string) {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await waitForStablePaint(page);
  await page.screenshot({
    path: resolve(CAPTURE_DIR, file),
    fullPage: false,
  });
}

test.describe.configure({ mode: "serial" });

test("settings integrations connected", async ({ page }) => {
  await boot(page);
  await pressHotkey(page, { mod: true, key: "," });
  const modal = page.getByRole("dialog", { name: "설정" });
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "연동" }).click();
  await expect(modal.getByText("Ian(으)로 연결됨").first()).toBeVisible();
  await expect(modal.getByText("Linear API 키")).toBeVisible();
  await expect(modal.getByText("Jira Cloud")).toBeVisible();
  await capture(page, "settings-integrations.png");
});

test("linear issue list", async ({ page }) => {
  await boot(page);
  const rightPanel = page.locator("#right, [data-panel-id='right'], [data-testid='right']").first();
  await rightPanel.getByRole("button", { name: "Linear", exact: true }).click();
  await expect(rightPanel.getByText("JTF-184")).toBeVisible();
  await expect(rightPanel.getByText("우측 패널 Linear / Jira 이슈 탭")).toBeVisible();
  await capture(page, "linear-list.png");
});

test("linear issue detail", async ({ page }) => {
  await boot(page);
  const rightPanel = page.locator("#right, [data-panel-id='right'], [data-testid='right']").first();
  await rightPanel.getByRole("button", { name: "Linear", exact: true }).click();
  await rightPanel.getByText("우측 패널 Linear / Jira 이슈 탭").dblclick();
  await expect(
    page.getByRole("heading", { name: "우측 패널 Linear / Jira 이슈 탭" }),
  ).toBeVisible();
  await expect(page.getByText("토큰은 렌더러로 다시 내려주지 않습니다.")).toBeVisible();
  await capture(page, "linear-detail.png");
});

test("jira issue list", async ({ page }) => {
  await boot(page);
  const rightPanel = page.locator("#right, [data-panel-id='right'], [data-testid='right']").first();
  await rightPanel.getByRole("button", { name: "Jira", exact: true }).click();
  await expect(rightPanel.getByText("ACORN-12")).toBeVisible();
  await expect(rightPanel.getByText("Jira 검색을 scoped token URL로 전환")).toBeVisible();
  await capture(page, "jira-list.png");
});

test("jira issue detail", async ({ page }) => {
  await boot(page);
  const rightPanel = page.locator("#right, [data-panel-id='right'], [data-testid='right']").first();
  await rightPanel.getByRole("button", { name: "Jira", exact: true }).click();
  await rightPanel.getByText("Jira 검색을 scoped token URL로 전환").dblclick();
  await expect(
    page.getByRole("heading", { name: "Jira 검색을 scoped token URL로 전환" }),
  ).toBeVisible();
  await capture(page, "jira-detail.png");
});

test("project settings issues mapping", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "프로젝트 acorn" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
  const modal = page.getByRole("dialog", { name: "프로젝트 설정" });
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "이슈", exact: true }).click();
  await expect(modal.getByText("JTF · Frontend")).toBeVisible();
  await expect(modal.getByText("ACORN · Acorn")).toBeVisible();
  await capture(page, "project-settings-issues.png");
});
