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
  PullRequestListing,
  WorkflowRunsListing,
} from "../lib/types";

vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "fs-changed",
  api: {
    fsWatchSetRoot: vi.fn<() => Promise<void>>(),
    githubOriginSlug: vi.fn<() => Promise<string | null>>(),
    isGitRepository: vi.fn<() => Promise<boolean>>(),
    listPullRequests:
      vi.fn<
        (
          repoPath: string,
          state: string,
          limit: number,
        ) => Promise<PullRequestListing>
      >(),
    listWorkflowRuns:
      vi.fn<(repoPath: string, limit: number) => Promise<WorkflowRunsListing>>(),
    listAgentHistory:
      vi.fn<(repoPath: string, limit: number) => Promise<AgentHistoryItem[]>>(),
    readSessionTodos: vi.fn<() => Promise<[]>>(),
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
import { rightPanelCache } from "../lib/right-panel-cache";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import { __resetIsGitHubRepoCacheForTests } from "../lib/useIsGitHubRepo";
import { useAppStore } from "../store";
import { RightPanel } from "./RightPanel";

const mockApi = vi.mocked(api);
const mockListen = vi.mocked(listen);
const REPO = "/tmp/acorn-test-repo";
const REPO_B = "/tmp/acorn-other-repo";

const labeledPullRequest = {
  number: 247,
  title: "Hide git tabs outside repositories",
  state: "OPEN",
  author: "im-ian",
  head_branch: "feature",
  base_branch: "main",
  url: "https://github.com/im-ian/acorn/pull/247",
  updated_at: "2026-05-19T00:00:00Z",
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
    vi.useFakeTimers();
    rightPanelCache.resetForTests();
    __resetIsGitHubRepoCacheForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.githubOriginSlug.mockResolvedValue("im-ian/acorn");
    mockApi.isGitRepository.mockResolvedValue(true);
    mockApi.fsWatchSetRoot.mockResolvedValue();
    mockApi.listPullRequests.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });
    mockApi.listWorkflowRuns.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });
    mockApi.listAgentHistory.mockResolvedValue([]);
    mockApi.readSessionTodos.mockResolvedValue([]);
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
    expect(mockApi.listWorkflowRuns).not.toHaveBeenCalled();
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
});
