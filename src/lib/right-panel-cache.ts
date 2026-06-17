import { api } from "./api";
import type {
  AgentHistoryItem,
  CommitInfo,
  DiffPayload,
  IssueListing,
  IssueStateFilter,
  PrStateFilter,
  PullRequestListing,
  StagedFile,
  WorkflowRunsListing,
} from "./types";

export type CommitsCacheEntry = { commits: CommitInfo[]; hasMore: boolean };
export type StagedCacheEntry = {
  files: StagedFile[];
  selectedPath: string | null;
  diffByPath: Record<string, DiffPayload>;
};

interface FetchOptions {
  force?: boolean;
}

class RightPanelCacheManager {
  private retainedRepos: Set<string> | null = null;
  private repoVersions = new Map<string, number>();
  private prefetchedProjectRepos = new Set<string>();
  private agentHistoryCache = new Map<string, AgentHistoryItem[]>();
  private agentHistoryInFlight = new Map<string, Promise<AgentHistoryItem[]>>();
  private unscopedAgentHistoryCache = new Map<number, AgentHistoryItem[]>();
  private unscopedAgentHistoryInFlight = new Map<
    number,
    Promise<AgentHistoryItem[]>
  >();
  private commitsCache = new Map<string, CommitsCacheEntry>();
  private stagedCache = new Map<string, StagedCacheEntry>();
  private fileExplorerExpanded = new Map<string, Set<string>>();
  private prListCache = new Map<string, PullRequestListing>();
  private prListInFlight = new Map<string, Promise<PullRequestListing>>();
  private issueListCache = new Map<string, IssueListing>();
  private issueListInFlight = new Map<string, Promise<IssueListing>>();
  private workflowRunsCache = new Map<string, WorkflowRunsListing>();
  private workflowRunsInFlight = new Map<string, Promise<WorkflowRunsListing>>();

  claimProjectPrefetch(repoPath: string): boolean {
    if (this.prefetchedProjectRepos.has(repoPath)) return false;
    this.prefetchedProjectRepos.add(repoPath);
    return true;
  }

  retainRepos(repoPaths: Iterable<string>): void {
    const next = new Set(repoPaths);
    const removed = new Set<string>();
    if (this.retainedRepos) {
      for (const repoPath of this.retainedRepos) {
        if (!next.has(repoPath)) removed.add(repoPath);
      }
    }
    this.collectRemovedStringKeys(this.agentHistoryCache, next, removed);
    this.collectRemovedStringKeys(this.agentHistoryInFlight, next, removed);
    this.collectRemovedStringKeys(this.commitsCache, next, removed);
    this.collectRemovedStringKeys(this.stagedCache, next, removed);
    this.collectRemovedStringKeys(this.fileExplorerExpanded, next, removed);
    this.collectRemovedStringValues(this.prefetchedProjectRepos, next, removed);
    this.collectRemovedJsonKeys(this.prListCache, next, removed);
    this.collectRemovedJsonKeys(this.prListInFlight, next, removed);
    this.collectRemovedJsonKeys(this.issueListCache, next, removed);
    this.collectRemovedJsonKeys(this.issueListInFlight, next, removed);
    this.collectRemovedJsonKeys(this.workflowRunsCache, next, removed);
    this.collectRemovedJsonKeys(this.workflowRunsInFlight, next, removed);
    for (const repoPath of removed) this.bumpRepoVersion(repoPath);

    this.retainedRepos = next;
    this.pruneStringKeyedMap(this.agentHistoryCache, next);
    this.pruneStringKeyedMap(this.agentHistoryInFlight, next);
    this.pruneStringKeyedMap(this.commitsCache, next);
    this.pruneStringKeyedMap(this.stagedCache, next);
    this.pruneStringKeyedMap(this.fileExplorerExpanded, next);
    this.pruneStringKeyedSet(this.prefetchedProjectRepos, next);
    this.pruneJsonKeyedMap(this.prListCache, next);
    this.pruneJsonKeyedMap(this.prListInFlight, next);
    this.pruneJsonKeyedMap(this.issueListCache, next);
    this.pruneJsonKeyedMap(this.issueListInFlight, next);
    this.pruneJsonKeyedMap(this.workflowRunsCache, next);
    this.pruneJsonKeyedMap(this.workflowRunsInFlight, next);
  }

  getAgentHistory(repoPath: string): AgentHistoryItem[] | null {
    return this.agentHistoryCache.get(repoPath) ?? null;
  }

  setAgentHistory(repoPath: string, items: AgentHistoryItem[]): void {
    if (!this.canStore(repoPath)) return;
    this.agentHistoryCache.set(repoPath, items);
  }

  fetchAgentHistory(
    repoPath: string,
    options: FetchOptions = {},
  ): Promise<AgentHistoryItem[]> {
    const cached = this.agentHistoryCache.get(repoPath);
    if (cached && !options.force) return Promise.resolve(cached);
    const existing = this.agentHistoryInFlight.get(repoPath);
    if (existing) return existing;
    const version = this.repoVersion(repoPath);
    const promise = api
      .listAgentHistory(repoPath, 100)
      .then((items) => {
        if (this.isCurrentRepoVersion(repoPath, version)) {
          this.agentHistoryCache.set(repoPath, items);
        }
        return items;
      })
      .finally(() => {
        this.agentHistoryInFlight.delete(repoPath);
      });
    this.agentHistoryInFlight.set(repoPath, promise);
    return promise;
  }

  getUnscopedAgentHistory(limit: number): AgentHistoryItem[] | null {
    return this.unscopedAgentHistoryCache.get(limit) ?? null;
  }

  setUnscopedAgentHistory(limit: number, items: AgentHistoryItem[]): void {
    this.unscopedAgentHistoryCache.set(limit, items);
  }

  fetchUnscopedAgentHistory(
    limit: number,
    options: FetchOptions = {},
  ): Promise<AgentHistoryItem[]> {
    const cached = this.unscopedAgentHistoryCache.get(limit);
    if (cached && !options.force) return Promise.resolve(cached);
    const existing = this.unscopedAgentHistoryInFlight.get(limit);
    if (existing) return existing;
    const promise = api
      .listUnscopedAgentHistory(limit)
      .then((items) => {
        this.unscopedAgentHistoryCache.set(limit, items);
        return items;
      })
      .finally(() => {
        this.unscopedAgentHistoryInFlight.delete(limit);
      });
    this.unscopedAgentHistoryInFlight.set(limit, promise);
    return promise;
  }

  getCommits(repoPath: string): CommitsCacheEntry | null {
    return this.commitsCache.get(repoPath) ?? null;
  }

  setCommits(repoPath: string, entry: CommitsCacheEntry): void {
    if (!this.canStore(repoPath)) return;
    this.commitsCache.set(repoPath, entry);
  }

  getStaged(repoPath: string): StagedCacheEntry | null {
    return this.stagedCache.get(repoPath) ?? null;
  }

  setStaged(repoPath: string, entry: StagedCacheEntry): void {
    if (!this.canStore(repoPath)) return;
    this.stagedCache.set(repoPath, entry);
  }

  getFileExplorerExpanded(repoPath: string): Set<string> {
    return new Set(this.fileExplorerExpanded.get(repoPath) ?? []);
  }

  setFileExplorerExpanded(repoPath: string, expanded: Iterable<string>): void {
    if (!this.canStore(repoPath)) return;
    this.fileExplorerExpanded.set(repoPath, new Set(expanded));
  }

  getPullRequests(
    repoPath: string,
    filter: PrStateFilter,
    limit: number,
  ): PullRequestListing | null {
    return this.prListCache.get(this.prListKey(repoPath, filter, limit)) ?? null;
  }

  fetchPullRequests(
    repoPath: string,
    filter: PrStateFilter,
    limit: number,
    options: FetchOptions = {},
  ): Promise<PullRequestListing> {
    const key = this.prListKey(repoPath, filter, limit);
    const cached = this.prListCache.get(key);
    if (cached && !options.force) return Promise.resolve(cached);
    const existing = this.prListInFlight.get(key);
    if (existing) return existing;
    const version = this.repoVersion(repoPath);
    const promise = api
      .listPullRequests(repoPath, filter, limit)
      .then((result) => {
        if (this.isCurrentRepoVersion(repoPath, version)) {
          this.prListCache.set(key, result);
        }
        return result;
      })
      .finally(() => {
        this.prListInFlight.delete(key);
      });
    this.prListInFlight.set(key, promise);
    return promise;
  }

  getIssues(
    repoPath: string,
    filter: IssueStateFilter,
    limit: number,
  ): IssueListing | null {
    return this.issueListCache.get(this.issueListKey(repoPath, filter, limit)) ?? null;
  }

  fetchIssues(
    repoPath: string,
    filter: IssueStateFilter,
    limit: number,
    options: FetchOptions = {},
  ): Promise<IssueListing> {
    const key = this.issueListKey(repoPath, filter, limit);
    const cached = this.issueListCache.get(key);
    if (cached && !options.force) return Promise.resolve(cached);
    const existing = this.issueListInFlight.get(key);
    if (existing) return existing;
    const version = this.repoVersion(repoPath);
    const promise = api
      .listIssues(repoPath, filter, limit)
      .then((result) => {
        if (this.isCurrentRepoVersion(repoPath, version)) {
          this.issueListCache.set(key, result);
        }
        return result;
      })
      .finally(() => {
        this.issueListInFlight.delete(key);
      });
    this.issueListInFlight.set(key, promise);
    return promise;
  }

  getWorkflowRuns(repoPath: string, limit: number): WorkflowRunsListing | null {
    return this.workflowRunsCache.get(this.workflowRunsKey(repoPath, limit)) ?? null;
  }

  fetchWorkflowRuns(
    repoPath: string,
    limit: number,
    options: FetchOptions = {},
  ): Promise<WorkflowRunsListing> {
    const key = this.workflowRunsKey(repoPath, limit);
    const cached = this.workflowRunsCache.get(key);
    if (cached && !options.force) return Promise.resolve(cached);
    const existing = this.workflowRunsInFlight.get(key);
    if (existing) return existing;
    const version = this.repoVersion(repoPath);
    const promise = api
      .listWorkflowRuns(repoPath, limit)
      .then((result) => {
        if (this.isCurrentRepoVersion(repoPath, version)) {
          this.workflowRunsCache.set(key, result);
        }
        return result;
      })
      .finally(() => {
        this.workflowRunsInFlight.delete(key);
      });
    this.workflowRunsInFlight.set(key, promise);
    return promise;
  }

  resetForTests(): void {
    this.retainedRepos = null;
    this.repoVersions.clear();
    this.prefetchedProjectRepos.clear();
    this.agentHistoryCache.clear();
    this.agentHistoryInFlight.clear();
    this.unscopedAgentHistoryCache.clear();
    this.unscopedAgentHistoryInFlight.clear();
    this.commitsCache.clear();
    this.stagedCache.clear();
    this.fileExplorerExpanded.clear();
    this.prListCache.clear();
    this.prListInFlight.clear();
    this.issueListCache.clear();
    this.issueListInFlight.clear();
    this.workflowRunsCache.clear();
    this.workflowRunsInFlight.clear();
  }

  private canStore(repoPath: string): boolean {
    return this.retainedRepos === null || this.retainedRepos.has(repoPath);
  }

  private repoVersion(repoPath: string): number {
    return this.repoVersions.get(repoPath) ?? 0;
  }

  private isCurrentRepoVersion(repoPath: string, version: number): boolean {
    return this.repoVersion(repoPath) === version;
  }

  private bumpRepoVersion(repoPath: string): void {
    this.repoVersions.set(repoPath, this.repoVersion(repoPath) + 1);
  }

  private prListKey(
    repoPath: string,
    filter: PrStateFilter,
    limit: number,
  ): string {
    return JSON.stringify([repoPath, filter, limit]);
  }

  private issueListKey(
    repoPath: string,
    filter: IssueStateFilter,
    limit: number,
  ): string {
    return JSON.stringify([repoPath, filter, limit]);
  }

  private workflowRunsKey(repoPath: string, limit: number): string {
    return JSON.stringify([repoPath, limit]);
  }

  private pruneStringKeyedMap<T>(map: Map<string, T>, retained: Set<string>): void {
    for (const key of map.keys()) {
      if (!retained.has(key)) map.delete(key);
    }
  }

  private collectRemovedStringKeys<T>(
    map: Map<string, T>,
    retained: Set<string>,
    removed: Set<string>,
  ): void {
    for (const key of map.keys()) {
      if (!retained.has(key)) removed.add(key);
    }
  }

  private pruneStringKeyedSet(set: Set<string>, retained: Set<string>): void {
    for (const value of set) {
      if (!retained.has(value)) set.delete(value);
    }
  }

  private collectRemovedStringValues(
    set: Set<string>,
    retained: Set<string>,
    removed: Set<string>,
  ): void {
    for (const value of set) {
      if (!retained.has(value)) removed.add(value);
    }
  }

  private pruneJsonKeyedMap<T>(map: Map<string, T>, retained: Set<string>): void {
    for (const key of map.keys()) {
      if (!retained.has(this.repoFromJsonKey(key))) map.delete(key);
    }
  }

  private collectRemovedJsonKeys<T>(
    map: Map<string, T>,
    retained: Set<string>,
    removed: Set<string>,
  ): void {
    for (const key of map.keys()) {
      const repoPath = this.repoFromJsonKey(key);
      if (repoPath && !retained.has(repoPath)) removed.add(repoPath);
    }
  }

  private repoFromJsonKey(key: string): string {
    try {
      const parsed = JSON.parse(key) as unknown;
      if (Array.isArray(parsed) && typeof parsed[0] === "string") {
        return parsed[0];
      }
    } catch {
      return "";
    }
    return "";
  }
}

export const rightPanelCache = new RightPanelCacheManager();
