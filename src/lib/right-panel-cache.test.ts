import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHistoryItem,
  DiffPayload,
  IssueListing,
  PullRequestListing,
  WorkflowRunsListing,
} from "./types";

vi.mock("./api", () => ({
  api: {
    listAgentHistory:
      vi.fn<(repoPath: string, limit: number) => Promise<AgentHistoryItem[]>>(),
    listUnscopedAgentHistory:
      vi.fn<(limit: number) => Promise<AgentHistoryItem[]>>(),
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
    listWorkflowRuns:
      vi.fn<(repoPath: string, limit: number) => Promise<WorkflowRunsListing>>(),
    commitDiff: vi.fn<(repoPath: string, sha: string) => Promise<DiffPayload>>(),
  },
}));

import { api } from "./api";
import {
  rememberRecentStagedDiff,
  rightPanelCache,
} from "./right-panel-cache";

const mockApi = vi.mocked(api);
const REPO = "/tmp/acorn";
const OTHER_REPO = "/tmp/other";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("rightPanelCache", () => {
  beforeEach(() => {
    rightPanelCache.resetForTests();
    vi.clearAllMocks();
  });

  it("dedupes in-flight PR fetches and reuses cached results", async () => {
    const listing: PullRequestListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    const pending = deferred<PullRequestListing>();
    mockApi.listPullRequests.mockReturnValueOnce(pending.promise);

    const first = rightPanelCache.fetchPullRequests(REPO, "merged", 50);
    const second = rightPanelCache.fetchPullRequests(REPO, "merged", 50);
    expect(first).toBe(second);
    expect(mockApi.listPullRequests).toHaveBeenCalledTimes(1);

    pending.resolve(listing);
    await expect(first).resolves.toBe(listing);
    await expect(
      rightPanelCache.fetchPullRequests(REPO, "merged", 50),
    ).resolves.toBe(listing);
    expect(mockApi.listPullRequests).toHaveBeenCalledTimes(1);
  });

  it("bypasses stale in-flight PR fetches when forced", async () => {
    const staleListing: PullRequestListing = {
      kind: "ok",
      items: [
        {
          number: 1,
          title: "stale",
          state: "OPEN",
          author: "tester",
          head_branch: "feat/stale",
          base_branch: "main",
          url: "https://example.test/1",
          updated_at: "2026-01-01T00:00:00.000Z",
          closed_at: null,
          merged_at: null,
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
      account: "tester",
    };
    const freshListing: PullRequestListing = {
      kind: "ok",
      items: [
        {
          number: 2,
          title: "fresh",
          state: "MERGED",
          author: "tester",
          head_branch: "feat/fresh",
          base_branch: "main",
          url: "https://example.test/2",
          updated_at: "2026-01-02T00:00:00.000Z",
          closed_at: "2026-01-02T00:00:00.000Z",
          merged_at: "2026-01-02T00:00:00.000Z",
          is_draft: false,
          checks: null,
          labels: [],
        },
      ],
      account: "tester",
    };
    const stale = deferred<PullRequestListing>();
    const fresh = deferred<PullRequestListing>();
    mockApi.listPullRequests
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const first = rightPanelCache.fetchPullRequests(REPO, "open", 50);
    const forced = rightPanelCache.fetchPullRequests(REPO, "open", 50, {
      force: true,
    });

    expect(forced).not.toBe(first);
    expect(mockApi.listPullRequests).toHaveBeenCalledTimes(2);

    fresh.resolve(freshListing);
    await expect(forced).resolves.toBe(freshListing);
    expect(rightPanelCache.getPullRequests(REPO, "open", 50)).toBe(
      freshListing,
    );

    stale.resolve(staleListing);
    await expect(first).resolves.toBe(staleListing);
    expect(rightPanelCache.getPullRequests(REPO, "open", 50)).toBe(
      freshListing,
    );
  });

  it("dedupes in-flight issue fetches and reuses cached results", async () => {
    const listing: IssueListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    const pending = deferred<IssueListing>();
    mockApi.listIssues.mockReturnValueOnce(pending.promise);

    const first = rightPanelCache.fetchIssues(REPO, "closed", 50);
    const second = rightPanelCache.fetchIssues(REPO, "closed", 50);
    expect(first).toBe(second);
    expect(mockApi.listIssues).toHaveBeenCalledTimes(1);

    pending.resolve(listing);
    await expect(first).resolves.toBe(listing);
    await expect(
      rightPanelCache.fetchIssues(REPO, "closed", 50),
    ).resolves.toBe(listing);
    expect(mockApi.listIssues).toHaveBeenCalledTimes(1);
  });

  it("dedupes in-flight commit diff fetches and reuses cached results", async () => {
    const diff: DiffPayload = {
      files: [
        {
          old_path: "src/old.ts",
          new_path: "src/new.ts",
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          is_image: false,
        },
      ],
    };
    const pending = deferred<DiffPayload>();
    mockApi.commitDiff.mockReturnValueOnce(pending.promise);

    const first = rightPanelCache.fetchCommitDiff(REPO, "abc123");
    const second = rightPanelCache.fetchCommitDiff(REPO, "abc123");
    expect(first).toBe(second);
    expect(mockApi.commitDiff).toHaveBeenCalledTimes(1);

    pending.resolve(diff);
    await expect(first).resolves.toBe(diff);
    expect(rightPanelCache.getCommitDiff(REPO, "abc123")).toBe(diff);
    await expect(rightPanelCache.fetchCommitDiff(REPO, "abc123")).resolves.toBe(
      diff,
    );
    expect(mockApi.commitDiff).toHaveBeenCalledTimes(1);
  });

  it("evicts old commit diff payloads after the cache reaches its limit", async () => {
    mockApi.commitDiff.mockImplementation(async (_repoPath, sha) => ({
      files: [
        {
          old_path: `${sha}.old`,
          new_path: `${sha}.new`,
          patch: `@@ -1 +1 @@\n-${sha}\n+updated-${sha}\n`,
          is_image: false,
        },
      ],
    }));

    for (let index = 0; index < 20; index += 1) {
      await rightPanelCache.fetchCommitDiff(REPO, `sha-${index}`);
    }

    expect(rightPanelCache.getCommitDiff(REPO, "sha-0")).toBeNull();
    expect(rightPanelCache.getCommitDiff(REPO, "sha-19")).not.toBeNull();

    await rightPanelCache.fetchCommitDiff(REPO, "sha-0");

    expect(mockApi.commitDiff).toHaveBeenCalledTimes(21);
  });

  it("keeps only the most recent staged diff payloads", () => {
    let diffByPath: Record<string, DiffPayload> = {};

    for (let index = 0; index < 20; index += 1) {
      diffByPath = rememberRecentStagedDiff(
        diffByPath,
        `src/file-${index}.ts`,
        { files: [] },
      );
    }

    expect(Object.keys(diffByPath)).toHaveLength(16);
    expect(diffByPath["src/file-0.ts"]).toBeUndefined();
    expect(diffByPath["src/file-19.ts"]).toBeDefined();
  });

  it("bounds oversized staged entries stored by callers", () => {
    const diffByPath = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `src/file-${index}.ts`,
        { files: [] },
      ]),
    );

    rightPanelCache.setStaged(REPO, {
      files: [],
      selectedPath: null,
      diffByPath,
    });

    expect(Object.keys(rightPanelCache.getStaged(REPO)!.diffByPath)).toHaveLength(
      16,
    );
  });

  it("keeps a fresh commit diff request when a pruned stale request settles", async () => {
    const diff: DiffPayload = { files: [] };
    const stale = deferred<DiffPayload>();
    const fresh = deferred<DiffPayload>();
    const unexpectedThird = deferred<DiffPayload>();
    mockApi.commitDiff
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)
      .mockReturnValue(unexpectedThird.promise);

    const staleRequest = rightPanelCache.fetchCommitDiff(REPO, "abc123");
    rightPanelCache.retainRepos([OTHER_REPO]);
    rightPanelCache.retainRepos([REPO]);
    const freshRequest = rightPanelCache.fetchCommitDiff(REPO, "abc123");

    stale.resolve(diff);
    await staleRequest;

    expect(rightPanelCache.fetchCommitDiff(REPO, "abc123")).toBe(freshRequest);
    expect(mockApi.commitDiff).toHaveBeenCalledTimes(2);

    fresh.resolve(diff);
    await freshRequest;
  });

  it("tracks project prefetch once until the repo is pruned", () => {
    expect(rightPanelCache.claimProjectPrefetch(REPO)).toBe(true);
    expect(rightPanelCache.claimProjectPrefetch(REPO)).toBe(false);

    rightPanelCache.retainRepos([OTHER_REPO]);
    expect(rightPanelCache.claimProjectPrefetch(REPO)).toBe(true);
  });

  it("releases invalidation metadata when repositories are pruned", () => {
    for (let index = 0; index < 300; index += 1) {
      const repoPath = `/tmp/transient-repo-${index}`;
      rightPanelCache.retainRepos([repoPath]);
      rightPanelCache.invalidatePullRequests(repoPath);
      rightPanelCache.retainRepos([]);
    }

    expect(rightPanelCache.repoInvalidationEntryCountForTests()).toBe(0);
  });

  it("drops cached repo data when the repo is no longer retained", async () => {
    const history: AgentHistoryItem[] = [];
    const workflows: WorkflowRunsListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    mockApi.listAgentHistory.mockResolvedValue(history);
    mockApi.listWorkflowRuns.mockResolvedValue(workflows);
    mockApi.listIssues.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });

    await rightPanelCache.fetchAgentHistory(REPO);
    await rightPanelCache.fetchWorkflowRuns(REPO, 50);
    await rightPanelCache.fetchIssues(REPO, "open", 50);
    expect(rightPanelCache.getAgentHistory(REPO)).toBe(history);
    expect(rightPanelCache.getWorkflowRuns(REPO, 50)).toBe(workflows);
    expect(rightPanelCache.getIssues(REPO, "open", 50)).not.toBeNull();

    rightPanelCache.retainRepos([OTHER_REPO]);
    expect(rightPanelCache.getAgentHistory(REPO)).toBeNull();
    expect(rightPanelCache.getWorkflowRuns(REPO, 50)).toBeNull();
    expect(rightPanelCache.getIssues(REPO, "open", 50)).toBeNull();
  });

  it("preserves file explorer expansion by repo until the repo is pruned", () => {
    const expanded = new Set([`${REPO}/src`, `${REPO}/tests`]);

    rightPanelCache.setFileExplorerExpanded(REPO, expanded);

    expect(rightPanelCache.getFileExplorerExpanded(REPO)).toEqual(expanded);
    expect(rightPanelCache.getFileExplorerExpanded(REPO)).not.toBe(expanded);

    rightPanelCache.retainRepos([OTHER_REPO]);
    expect(rightPanelCache.getFileExplorerExpanded(REPO)).toEqual(new Set());
  });

  it("dedupes in-flight unscoped history fetches and reuses cached results", async () => {
    const history: AgentHistoryItem[] = [];
    const pending = deferred<AgentHistoryItem[]>();
    mockApi.listUnscopedAgentHistory.mockReturnValueOnce(pending.promise);

    const first = rightPanelCache.fetchUnscopedAgentHistory(100);
    const second = rightPanelCache.fetchUnscopedAgentHistory(100);
    expect(first).toBe(second);
    expect(mockApi.listUnscopedAgentHistory).toHaveBeenCalledTimes(1);

    pending.resolve(history);
    await expect(first).resolves.toBe(history);
    await expect(rightPanelCache.fetchUnscopedAgentHistory(100)).resolves.toBe(
      history,
    );
    expect(mockApi.listUnscopedAgentHistory).toHaveBeenCalledTimes(1);
  });

  it("does not repopulate a pruned repo from a stale in-flight request", async () => {
    const listing: PullRequestListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    const pending = deferred<PullRequestListing>();
    mockApi.listPullRequests.mockReturnValueOnce(pending.promise);

    const request = rightPanelCache.fetchPullRequests(REPO, "open", 50);
    rightPanelCache.retainRepos([OTHER_REPO]);
    pending.resolve(listing);
    await expect(request).resolves.toBe(listing);

    expect(rightPanelCache.getPullRequests(REPO, "open", 50)).toBeNull();
  });

  it("invalidates PR listings and ignores stale in-flight PR requests for one repo", async () => {
    const cached: PullRequestListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    const pending = deferred<PullRequestListing>();
    mockApi.listPullRequests
      .mockResolvedValueOnce(cached)
      .mockReturnValueOnce(pending.promise);

    await rightPanelCache.fetchPullRequests(REPO, "open", 50);
    expect(rightPanelCache.getPullRequests(REPO, "open", 50)).toBe(cached);
    const staleRequest = rightPanelCache.fetchPullRequests(REPO, "merged", 50);

    rightPanelCache.invalidatePullRequests(REPO);

    expect(rightPanelCache.getPullRequests(REPO, "open", 50)).toBeNull();
    pending.resolve(cached);
    await expect(staleRequest).resolves.toBe(cached);
    expect(rightPanelCache.getPullRequests(REPO, "merged", 50)).toBeNull();
  });

  it("keeps a fresh PR in-flight request when a stale invalidated request settles", async () => {
    const listing: PullRequestListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    const stale = deferred<PullRequestListing>();
    const fresh = deferred<PullRequestListing>();
    mockApi.listPullRequests
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const staleRequest = rightPanelCache.fetchPullRequests(REPO, "open", 50);
    rightPanelCache.invalidatePullRequests(REPO);
    const freshRequest = rightPanelCache.fetchPullRequests(REPO, "open", 50);

    expect(freshRequest).not.toBe(staleRequest);
    expect(mockApi.listPullRequests).toHaveBeenCalledTimes(2);

    stale.resolve(listing);
    await staleRequest;

    expect(rightPanelCache.fetchPullRequests(REPO, "open", 50)).toBe(
      freshRequest,
    );
    expect(mockApi.listPullRequests).toHaveBeenCalledTimes(2);

    fresh.resolve(listing);
    await freshRequest;
  });

  it("does not repopulate pruned issue data from a stale in-flight request", async () => {
    const listing: IssueListing = {
      kind: "ok",
      items: [],
      account: "tester",
    };
    const pending = deferred<IssueListing>();
    mockApi.listIssues.mockReturnValueOnce(pending.promise);

    const request = rightPanelCache.fetchIssues(REPO, "open", 50);
    rightPanelCache.retainRepos([OTHER_REPO]);
    pending.resolve(listing);
    await expect(request).resolves.toBe(listing);

    expect(rightPanelCache.getIssues(REPO, "open", 50)).toBeNull();
  });
});
