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
import { rightPanelCache } from "../lib/right-panel-cache";
import { useAppStore } from "../store";
import { RightPanel } from "./RightPanel";

const mockApi = vi.mocked(api);
const REPO = "/tmp/acorn-test-repo";
const REPO_B = "/tmp/acorn-other-repo";

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RightPanel background tab loading", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    rightPanelCache.resetForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.githubOriginSlug.mockResolvedValue("im-ian/acorn");
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
      rightTab: "history",
      workspaceTabs: {},
      prAccountByRepo: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    rightPanelCache.resetForTests();
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
});
