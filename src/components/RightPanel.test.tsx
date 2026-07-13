import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  AgentHistoryItem,
  IssueDetailListing,
  IssueListing,
  PullRequestListing,
  WorkflowRunsListing,
} from "../lib/types";

vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "fs-changed",
  api: {
    fsWatchSetRoot: vi.fn<() => Promise<void>>(),
    githubOriginSlug: vi.fn<() => Promise<string | null>>(),
    isGitRepository: vi.fn<() => Promise<boolean>>(),
    listCommits: vi.fn<() => Promise<[]>>(),
    listStaged: vi.fn<() => Promise<[]>>(),
    stagedFileDiff: vi.fn<() => Promise<{ files: [] }>>(),
    listPullRequests:
      vi.fn<
        (
          repoPath: string,
          state: string,
          limit: number,
        ) => Promise<PullRequestListing>
      >(),
    listIssues:
      vi.fn<
        (
          repoPath: string,
          state: string,
          limit: number,
        ) => Promise<IssueListing>
      >(),
    getIssueDetail:
      vi.fn<
        (repoPath: string, number: number) => Promise<IssueDetailListing>
      >(),
    listWorkflowRuns:
      vi.fn<(repoPath: string, limit: number) => Promise<WorkflowRunsListing>>(),
    getWorkflowRunDetail: vi.fn(),
    listAgentHistory:
      vi.fn<(repoPath: string, limit: number) => Promise<AgentHistoryItem[]>>(),
    listUnscopedAgentHistory:
      vi.fn<(limit: number) => Promise<AgentHistoryItem[]>>(),
    readSessionTodos: vi.fn<() => Promise<[]>>(),
    ptyRepoRoot: vi.fn<() => Promise<string | null>>(),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("./FileExplorer", () => ({
  FileExplorer: () => <div data-testid="file-explorer" />,
}));

import { api } from "../lib/api";
import { listen } from "@tauri-apps/api/event";
import { emitPullRequestMutation } from "../lib/pullRequestEvents";
import { rightPanelCache } from "../lib/right-panel-cache";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import { __resetIsGitHubRepoCacheForTests } from "../lib/useIsGitHubRepo";
import { useAppStore } from "../store";
import { RightPanel } from "./RightPanel";

const mockApi = vi.mocked(api);
const mockListen = vi.mocked(listen);
const REPO = "/tmp/acorn-test-repo";
const REPO_B = "/tmp/acorn-other-repo";

function exactButtonCount(container: HTMLElement, label: string): number {
  return Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  ).length;
}

function buttonContaining(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button containing "${text}" not found`);
  }
  return button;
}

function roleButtonContaining(container: HTMLElement, text: string): HTMLElement {
  const element = Array.from(container.querySelectorAll('[role="button"]')).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error(`role button containing "${text}" not found`);
  }
  return element;
}

function comboboxWithAria(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = container.querySelector(
    `button[role="combobox"][aria-label="${label}"]`,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`combobox labelled "${label}" not found`);
  }
  return button;
}

function selectOption(label: string) {
  const optionLabel = Array.from(
    document.querySelectorAll("[data-select-option-label]"),
  ).find((element) => element.textContent?.trim() === label);
  const option = optionLabel?.closest('[role="option"]');
  if (!(option instanceof HTMLElement)) {
    throw new Error(`option "${label}" not found`);
  }
  act(() => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const labeledPullRequest = {
  number: 247,
  title: "Hide git tabs outside repositories",
  state: "OPEN",
  author: "im-ian",
  head_branch: "feature",
  base_branch: "main",
  url: "https://github.com/im-ian/acorn/pull/247",
  updated_at: "2026-05-19T00:00:00Z",
  closed_at: null,
  merged_at: null,
  is_draft: false,
  checks: null,
  labels: [
    { name: "fix", color: "D93F0B" },
    { name: "frontend", color: "0969DA" },
  ],
};

const detailedPullRequest = {
  ...labeledPullRequest,
  number: 248,
  title: "Add PR row display options",
  head_branch: "display-head",
  base_branch: "display-base",
  checks: { passed: 1, failed: 0, pending: 1 },
};

const listedIssue = {
  number: 301,
  title: "Render issues in app",
  state: "OPEN",
  author: "im-ian",
  url: "https://github.com/im-ian/acorn/issues/301",
  created_at: "2026-05-18T00:00:00Z",
  updated_at: "2026-05-19T00:00:00Z",
  state_reason: null,
  comments: 1,
  labels: [{ name: "enhancement", color: "A2EEEF" }],
};

const detailedIssue = {
  ...listedIssue,
  body: "Detailed issue body",
  comments: [
    {
      id: 1,
      author: "im-ian",
      author_avatar_url: null,
      body: "First issue comment",
      created_at: "2026-05-19T01:00:00Z",
      url: "https://github.com/im-ian/acorn/issues/301#issuecomment-1",
    },
  ],
  assignees: ["im-ian"],
  milestone: "v1",
};

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitFsChanged(payload: {
  paths: string[];
  dotgit_changed: boolean;
}) {
  const listener = mockListen.mock.calls[mockListen.mock.calls.length - 1]?.[1];
  if (!listener) throw new Error("fs listener not registered");
  listener({
    event: "fs-changed",
    id: 1,
    payload,
  });
}

describe("RightPanel background tab loading", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    rightPanelCache.resetForTests();
    __resetIsGitHubRepoCacheForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.githubOriginSlug.mockResolvedValue("im-ian/acorn");
    mockApi.isGitRepository.mockResolvedValue(true);
    mockApi.fsWatchSetRoot.mockResolvedValue();
    mockApi.listCommits.mockResolvedValue([]);
    mockApi.listStaged.mockResolvedValue([]);
    mockApi.stagedFileDiff.mockResolvedValue({ files: [] });
    mockApi.listPullRequests.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });
    mockApi.listIssues.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });
    mockApi.getIssueDetail.mockResolvedValue({
      kind: "not_github",
    });
    mockApi.listWorkflowRuns.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });
    mockApi.listAgentHistory.mockResolvedValue([]);
    mockApi.listUnscopedAgentHistory.mockResolvedValue([]);
    mockApi.readSessionTodos.mockResolvedValue([]);
    mockApi.ptyRepoRoot.mockResolvedValue(null);
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    useAppStore.setState({
      sessions: [],
      projects: [
        {
          repo_path: REPO,
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ],
      activeProject: REPO,
      activeSessionId: null,
      activeTabId: null,
      rightTab: "commits",
      workspaceTabs: {},
      prAccountByRepo: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    rightPanelCache.resetForTests();
    __resetIsGitHubRepoCacheForTests();
    vi.useRealTimers();
  });

  it("loads GitHub and agent tabs when a project is opened", async () => {
    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await flushPromises();

    expect(mockApi.listAgentHistory).toHaveBeenCalledWith(REPO, 100);
    expect(mockApi.githubOriginSlug).toHaveBeenCalledWith(REPO);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO, "open", 50);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO, "merged", 50);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO, "closed", 50);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO, "all", 50);
    expect(mockApi.listWorkflowRuns).toHaveBeenCalledWith(REPO, 50);
  });

  it("loads GitHub tabs after selecting a project whose workspace mirror is missing", async () => {
    useAppStore.setState({
      activeProject: null,
      activeSessionId: null,
      activeTabId: null,
      workspaces: {},
      rightTab: "prs",
    });

    act(() => {
      useAppStore.getState().setActiveProject(REPO);
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).not.toContain("No project selected");
    expect(mockApi.githubOriginSlug).toHaveBeenCalledWith(REPO);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO, "open", 50);
    expect(mockApi.listIssues).toHaveBeenCalledWith(REPO, "open", 50);
  });

  it("orders GitHub sub-tabs as PRs, Issues, Actions", async () => {
    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    const labels = Array.from(
      container.querySelectorAll('nav[aria-label="Right panel sub-tab"] button'),
    ).map((button) => button.textContent?.trim());
    expect(labels).toEqual(["Files", "Staged", "Commits"]);

    await act(async () => {
      buttonContaining(container, "GitHub").click();
    });
    await flushPromises();

    const githubLabels = Array.from(
      container.querySelectorAll('nav[aria-label="Right panel sub-tab"] button'),
    ).map((button) => button.textContent?.trim());
    expect(githubLabels).toEqual(["PRs", "Issues", "Actions"]);
  });

  it("prefetches other open projects once after startup", async () => {
    useAppStore.setState({
      projects: [
        {
          repo_path: REPO,
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
        {
          repo_path: REPO_B,
          name: "other",
          created_at: "2026-01-01T00:00:00Z",
          position: 1,
        },
      ],
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(mockApi.listPullRequests).not.toHaveBeenCalledWith(
      REPO_B,
      "open",
      50,
    );

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flushPromises();
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flushPromises();
    await flushPromises();

    expect(mockApi.listAgentHistory).toHaveBeenCalledWith(REPO_B, 100);
    expect(mockApi.githubOriginSlug).toHaveBeenCalledWith(REPO_B);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO_B, "open", 50);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO_B, "merged", 50);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO_B, "closed", 50);
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(REPO_B, "all", 50);
    expect(mockApi.listIssues).toHaveBeenCalledWith(REPO_B, "open", 50);
    expect(mockApi.listIssues).toHaveBeenCalledWith(REPO_B, "closed", 50);
    expect(mockApi.listIssues).toHaveBeenCalledWith(REPO_B, "all", 50);
    expect(mockApi.listWorkflowRuns).toHaveBeenCalledWith(REPO_B, 50);
  });

  it("hides git-backed tabs for projects that are not git repositories", async () => {
    mockApi.isGitRepository.mockResolvedValue(false);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Files");
    expect(container.textContent).not.toContain("Staged");
    expect(container.textContent).not.toContain("Commits");
    expect(container.textContent).not.toContain("GitHub");
    expect(mockApi.githubOriginSlug).not.toHaveBeenCalled();
    expect(mockApi.listPullRequests).not.toHaveBeenCalled();
    expect(mockApi.listIssues).not.toHaveBeenCalled();
    expect(mockApi.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("keeps local git tabs visible when the git repository has no GitHub origin", async () => {
    mockApi.githubOriginSlug.mockResolvedValue(null);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Files");
    expect(container.textContent).toContain("Staged");
    expect(container.textContent).toContain("Commits");
    expect(container.textContent).not.toContain("GitHub");
    expect(mockApi.githubOriginSlug).toHaveBeenCalledWith(REPO);
    expect(mockApi.listPullRequests).not.toHaveBeenCalled();
    expect(mockApi.listIssues).not.toHaveBeenCalled();
    expect(mockApi.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("hides Code and loads local agent history for local chat sessions", async () => {
    useAppStore.setState({
      sessions: [
        {
          id: "local-1",
          name: "codex",
          repo_path: "/Users/tester",
          worktree_path: "/Users/tester",
          branch: "HEAD",
          isolated: false,
          project_scoped: false,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "default",
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
          agent_provider: "codex",
        },
      ],
      activeSessionId: "local-1",
      activeTabId: "local-1",
      activeProject: REPO,
      rightTab: "commits",
    });
    mockApi.listUnscopedAgentHistory.mockResolvedValue([
      {
        provider: "codex",
        id: "codex-local",
        title: "Local Codex session",
        preview: null,
        queued_message_count: 0,
        subagent_transcript_count: 0,
        cwd: "/Users/tester",
        worktree: null,
        transcript_path: "/Users/tester/.codex/session.jsonl",
        updated_at: 1770000000,
        resume_command: "codex resume codex-local",
      },
    ]);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(exactButtonCount(container, "Code")).toBe(0);
    expect(exactButtonCount(container, "GitHub")).toBe(0);
    expect(exactButtonCount(container, "Agents")).toBe(1);
    expect(mockApi.isGitRepository).not.toHaveBeenCalled();
    expect(mockApi.githubOriginSlug).not.toHaveBeenCalled();
    expect(mockApi.listAgentHistory).not.toHaveBeenCalled();
    expect(mockApi.listUnscopedAgentHistory).toHaveBeenCalledWith(100);
  });

  it("filters agent history by provider", async () => {
    useAppStore.setState({ rightTab: "history" });
    mockApi.listAgentHistory.mockResolvedValue([
      {
        provider: "codex",
        id: "codex-session",
        title: "Codex patch",
        preview: null,
        queued_message_count: 0,
        subagent_transcript_count: 0,
        cwd: REPO,
        worktree: null,
        transcript_path: "/tmp/codex-session.jsonl",
        updated_at: 1770000000,
        resume_command: "codex resume codex-session",
      },
      {
        provider: "claude",
        id: "claude-session",
        title: "Claude plan",
        preview: null,
        queued_message_count: 0,
        subagent_transcript_count: 0,
        cwd: REPO,
        worktree: null,
        transcript_path: "/tmp/claude-session.jsonl",
        updated_at: 1770000001,
        resume_command: "claude --resume claude-session",
      },
    ]);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Codex patch");
    expect(container.textContent).toContain("Claude plan");

    act(() => {
      comboboxWithAria(container, "Filter by agent").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    selectOption("Codex");

    expect(container.textContent).toContain("Codex patch");
    expect(container.textContent).not.toContain("Claude plan");

    act(() => {
      comboboxWithAria(container, "Filter by agent").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    selectOption("Claude");

    expect(container.textContent).not.toContain("Codex patch");
    expect(container.textContent).toContain("Claude plan");
  });

  it("shows recoverable agent history signals", async () => {
    useAppStore.setState({ rightTab: "history" });
    mockApi.listAgentHistory.mockResolvedValue([
      {
        provider: "claude",
        id: "claude-recoverable",
        title: "Claude session",
        preview: null,
        queued_message_count: 1,
        subagent_transcript_count: 2,
        cwd: REPO,
        worktree: null,
        transcript_path: "/tmp/claude-recoverable.jsonl",
        updated_at: 1770000001,
        resume_command: "claude --resume claude-recoverable",
      },
    ]);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Claude session");
    expect(container.textContent).toContain(
      "Recoverable content: 1 queued message(s) + 2 subagent transcript(s)",
    );
  });

  it("does not show native chat sessions in agent history", async () => {
    useAppStore.setState({
      rightTab: "history",
      sessions: [
        {
          id: "chat-1",
          name: "Exploring chat runtime",
          repo_path: REPO,
          worktree_path: REPO,
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "waiting_for_input",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:02Z",
          last_message: null,
          title_source: "generated",
          generated_title_transcript_id: "chat:u1",
          kind: "regular",
          mode: "chat",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
          agent_provider: "claude",
          agent_transcript_id: null,
        },
      ],
    });
    mockApi.listAgentHistory.mockResolvedValue([]);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).not.toContain("Exploring chat runtime");
    expect(container.textContent).not.toContain("Acorn chat");
    expect(container.textContent).toContain("No Claude, Codex, or Antigravity sessions found");
  });

  it("reprobes GitHub visibility when git metadata changes", async () => {
    mockApi.isGitRepository.mockResolvedValueOnce(false);

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();
    expect(container.textContent).not.toContain("GitHub");
    expect(container.textContent).not.toContain("Staged");
    expect(container.textContent).not.toContain("Commits");
    expect(mockApi.githubOriginSlug).not.toHaveBeenCalled();

    mockApi.isGitRepository.mockResolvedValueOnce(true);
    mockApi.githubOriginSlug.mockResolvedValueOnce(null);
    await act(async () => {
      emitFsChanged({ paths: [], dotgit_changed: true });
    });
    await flushPromises();

    expect(mockApi.isGitRepository).toHaveBeenCalledTimes(2);
    expect(mockApi.githubOriginSlug).toHaveBeenCalledWith(REPO);
    expect(container.textContent).toContain("Staged");
    expect(container.textContent).toContain("Commits");
    expect(container.textContent).not.toContain("GitHub");

    mockApi.isGitRepository.mockResolvedValueOnce(true);
    mockApi.githubOriginSlug.mockResolvedValueOnce("im-ian/acorn");
    await act(async () => {
      emitFsChanged({ paths: [], dotgit_changed: true });
    });
    await flushPromises();

    expect(mockApi.isGitRepository).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("GitHub");
  });

  it("hides git-backed tabs when git metadata is removed", async () => {
    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Staged");
    expect(container.textContent).toContain("Commits");

    mockApi.isGitRepository.mockResolvedValueOnce(false);
    await act(async () => {
      emitFsChanged({ paths: [], dotgit_changed: true });
    });
    await flushPromises();

    expect(mockApi.isGitRepository).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("GitHub");
    expect(container.textContent).not.toContain("Staged");
    expect(container.textContent).not.toContain("Commits");
  });

  it("hides PR row labels when the GitHub setting is disabled", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        github: {
          ...DEFAULT_SETTINGS.github,
          showLabels: false,
        },
      },
    });
    useAppStore.setState({ rightTab: "prs" });
    mockApi.listPullRequests.mockResolvedValue({
      kind: "ok",
      items: [labeledPullRequest],
      account: "tester",
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Hide git tabs outside repositories");
    expect(container.textContent).not.toContain("frontend");
    expect(container.textContent).not.toContain("fix");
  });

  it("hides PR row branches when the GitHub setting is disabled", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        github: {
          ...DEFAULT_SETTINGS.github,
          showBranches: false,
        },
      },
    });
    useAppStore.setState({ rightTab: "prs" });
    mockApi.listPullRequests.mockResolvedValue({
      kind: "ok",
      items: [detailedPullRequest],
      account: "tester",
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Add PR row display options");
    expect(container.textContent).not.toContain("display-head");
    expect(container.textContent).not.toContain("display-base");
  });

  it("hides PR row CI status when the GitHub setting is disabled", async () => {
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        github: {
          ...DEFAULT_SETTINGS.github,
          showChecks: false,
        },
      },
    });
    useAppStore.setState({ rightTab: "prs" });
    mockApi.listPullRequests.mockResolvedValue({
      kind: "ok",
      items: [detailedPullRequest],
      account: "tester",
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Add PR row display options");
    expect(container.textContent).not.toContain("1/2");
  });

  it("refreshes PR rows when a lifecycle mutation event lands", async () => {
    useAppStore.setState({ rightTab: "prs" });
    let openFetches = 0;
    mockApi.listPullRequests.mockImplementation(
      async (repoPath, state = "open") => {
        if (repoPath === REPO && state === "open") {
          openFetches += 1;
          return {
            kind: "ok",
            items: [
              openFetches === 1
                ? labeledPullRequest
                : {
                    ...labeledPullRequest,
                    number: 249,
                    title: "Fresh PR list after mutation",
                  },
            ],
            account: "tester",
          };
        }
        return { kind: "ok", items: [], account: "tester" };
      },
    );

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Hide git tabs outside repositories");
    expect(container.textContent).not.toContain("Fresh PR list after mutation");

    await act(async () => {
      emitPullRequestMutation({
        kind: "merged",
        repoPath: REPO,
        number: labeledPullRequest.number,
        headBranch: labeledPullRequest.head_branch,
      });
    });
    await flushPromises();

    expect(openFetches).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("Fresh PR list after mutation");
  });

  it("opens issue detail in app from the Issues tab", async () => {
    useAppStore.setState({ rightTab: "issues" });
    mockApi.listIssues.mockResolvedValue({
      kind: "ok",
      items: [listedIssue],
      account: "tester",
    });
    mockApi.getIssueDetail.mockResolvedValue({
      kind: "ok",
      account: "tester",
      detail: detailedIssue,
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    const issueRow = roleButtonContaining(container, "Render issues in app");
    await act(async () => {
      issueRow.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          detail: 2,
        }),
      );
    });
    await flushPromises();
    await flushPromises();

    expect(mockApi.getIssueDetail).toHaveBeenCalledWith(REPO, 301);
    expect(document.body.textContent).toContain("Detailed issue body");
    expect(document.body.textContent).toContain("First issue comment");
  });

  it("updates running Actions run durations every second without refetching", async () => {
    vi.setSystemTime(new Date("2026-05-19T12:00:05Z"));
    useAppStore.setState({ rightTab: "actions" });
    mockApi.listWorkflowRuns.mockResolvedValue({
      kind: "ok",
      account: "tester",
      items: [
        {
          id: 42,
          display_title: "Run CI",
          workflow_name: "CI",
          status: "in_progress",
          conclusion: null,
          event: "pull_request",
          head_branch: "feature",
          head_sha: "abc1234",
          url: "https://github.com/im-ian/acorn/actions/runs/42",
          created_at: "2026-05-19T11:59:50Z",
          updated_at: "2026-05-19T12:00:05Z",
          started_at: "2026-05-19T12:00:00Z",
          attempt: 1,
        },
      ],
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(container.textContent).toContain("Run CI");
    expect(container.textContent).toContain("5s");
    expect(mockApi.listWorkflowRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flushPromises();

    expect(container.textContent).toContain("6s");
    expect(mockApi.listWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it("does not tick running Actions durations while the tab is hidden", async () => {
    useAppStore.setState({ rightTab: "prs" });
    mockApi.listWorkflowRuns.mockResolvedValue({
      kind: "ok",
      account: "tester",
      items: [
        {
          id: 42,
          display_title: "Run CI",
          workflow_name: "CI",
          status: "in_progress",
          conclusion: null,
          event: "pull_request",
          head_branch: "feature",
          head_sha: "abc1234",
          url: "https://github.com/im-ian/acorn/actions/runs/42",
          created_at: "2026-05-19T11:59:50Z",
          updated_at: "2026-05-19T12:00:05Z",
          started_at: "2026-05-19T12:00:00Z",
          attempt: 1,
        },
      ],
    });
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    expect(
      setIntervalSpy.mock.calls.filter(([, intervalMs]) => intervalMs === 1_000),
    ).toHaveLength(0);
  });

  it("ignores GitHub zero completedAt sentinels for running Actions jobs", async () => {
    vi.setSystemTime(new Date("2026-05-19T12:00:05Z"));
    useAppStore.setState({ rightTab: "actions" });
    mockApi.listWorkflowRuns.mockResolvedValue({
      kind: "ok",
      account: "tester",
      items: [
        {
          id: 42,
          display_title: "Run CI",
          workflow_name: "CI",
          status: "in_progress",
          conclusion: null,
          event: "push",
          head_branch: "main",
          head_sha: "abc1234",
          url: "https://github.com/im-ian/acorn/actions/runs/42",
          created_at: "2026-05-19T11:59:50Z",
          updated_at: "2026-05-19T12:00:05Z",
          started_at: "2026-05-19T12:00:00Z",
          attempt: 1,
        },
      ],
    });
    mockApi.getWorkflowRunDetail.mockResolvedValue({
      kind: "ok",
      account: "tester",
      detail: {
        id: 42,
        display_title: "Run CI",
        workflow_name: "CI",
        status: "in_progress",
        conclusion: null,
        event: "push",
        head_branch: "main",
        head_sha: "abc1234",
        url: "https://github.com/im-ian/acorn/actions/runs/42",
        created_at: "2026-05-19T11:59:50Z",
        updated_at: "2026-05-19T12:00:05Z",
        started_at: "2026-05-19T12:00:00Z",
        attempt: 1,
        jobs: [
          {
            id: 99,
            name: "macOS bundle",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-05-19T12:00:00Z",
            completed_at: "0001-01-01T00:00:00Z",
            url: "",
            steps: [],
          },
        ],
      },
    });

    await act(async () => {
      root.render(<RightPanel />);
    });
    await flushPromises();

    const runButton = buttonContaining(container, "Run CI");
    expect(runButton.textContent).toContain("Run CI");
    await act(async () => {
      runButton.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          detail: 2,
        }),
      );
    });
    await flushPromises();
    await flushPromises();

    expect(mockApi.getWorkflowRunDetail).toHaveBeenCalledWith(REPO, 42);
    expect(buttonContaining(document.body, "macOS bundle").textContent).toContain(
      "5s",
    );

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flushPromises();

    expect(buttonContaining(document.body, "macOS bundle").textContent).toContain(
      "6s",
    );
  });
});
