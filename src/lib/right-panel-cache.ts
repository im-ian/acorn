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

const COMMIT_DIFF_CACHE_MAX_ENTRIES = 16;
const STAGED_DIFF_CACHE_MAX_ENTRIES = 16;

function limitRecentStagedDiffs(
  diffByPath: Record<string, DiffPayload>,
): Record<string, DiffPayload> {
  const paths = Object.keys(diffByPath);
  if (paths.length <= STAGED_DIFF_CACHE_MAX_ENTRIES) return diffByPath;

  return Object.fromEntries(
    paths
      .slice(-STAGED_DIFF_CACHE_MAX_ENTRIES)
      .map((path) => [path, diffByPath[path]]),
  );
}

export function rememberRecentStagedDiff(
  diffByPath: Record<string, DiffPayload>,
  path: string,
  payload: DiffPayload,
): Record<string, DiffPayload> {
  const next = { ...diffByPath };
  delete next[path];
  next[path] = payload;
  return limitRecentStagedDiffs(next);
}

class RightPanelCacheManager {
  private retainedRepos: Set<string> | null = null;
  private repoTokens = new Map<string, symbol>();
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
  private commitDiffCache = new Map<string, DiffPayload>();
  private commitDiffInFlight = new Map<string, Promise<DiffPayload>>();

  claimProjectPrefetch(repoPath: string): boolean {
    if (this.prefetchedProjectRepos.has(repoPath)) return false;
    this.prefetchedProjectRepos.add(repoPath);
    return true;
  }

  retainRepos(repoPaths: Iterable<string>): void {
    const next = new Set(repoPaths);
    this.retainedRepos = next;
    this.pruneStringKeyedMap(this.repoTokens, next);
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
    this.pruneJsonKeyedMap(this.commitDiffCache, next);
    this.pruneJsonKeyedMap(this.commitDiffInFlight, next);
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
    const version = this.repoToken(repoPath);
    const promise = api
      .listAgentHistory(repoPath, 100)
      .then((items) => {
        if (this.isCurrentRepoToken(repoPath, version)) {
          this.agentHistoryCache.set(repoPath, items);
        }
        return items;
      })
      .finally(() => {
        if (this.agentHistoryInFlight.get(repoPath) === promise) {
          this.agentHistoryInFlight.delete(repoPath);
        }
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
        if (this.unscopedAgentHistoryInFlight.get(limit) === promise) {
          this.unscopedAgentHistoryInFlight.delete(limit);
        }
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

  getCommitDiff(repoPath: string, sha: string): DiffPayload | null {
    return this.commitDiffCache.get(this.commitDiffKey(repoPath, sha)) ?? null;
  }

  fetchCommitDiff(repoPath: string, sha: string): Promise<DiffPayload> {
    const key = this.commitDiffKey(repoPath, sha);
    const cached = this.commitDiffCache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.commitDiffInFlight.get(key);
    if (existing) return existing;
    const version = this.repoToken(repoPath);
    const promise = api
      .commitDiff(repoPath, sha)
      .then((payload) => {
        if (this.isCurrentRepoToken(repoPath, version)) {
          this.storeCommitDiff(key, payload);
        }
        return payload;
      })
      .finally(() => {
        if (this.commitDiffInFlight.get(key) === promise) {
          this.commitDiffInFlight.delete(key);
        }
      });
    this.commitDiffInFlight.set(key, promise);
    return promise;
  }

  getStaged(repoPath: string): StagedCacheEntry | null {
    return this.stagedCache.get(repoPath) ?? null;
  }

  setStaged(repoPath: string, entry: StagedCacheEntry): void {
    if (!this.canStore(repoPath)) return;
    const diffByPath = limitRecentStagedDiffs(entry.diffByPath);
    this.stagedCache.set(
      repoPath,
      diffByPath === entry.diffByPath ? entry : { ...entry, diffByPath },
    );
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
    if (options.force) {
      this.prListCache.delete(key);
      this.bumpRepoToken(repoPath);
    }
    const existing = this.prListInFlight.get(key);
    if (existing && !options.force) return existing;
    const version = this.repoToken(repoPath);
    const promise = api
      .listPullRequests(repoPath, filter, limit)
      .then((result) => {
        if (this.isCurrentRepoToken(repoPath, version)) {
          this.prListCache.set(key, result);
        }
        return result;
      })
      .finally(() => {
        if (this.prListInFlight.get(key) === promise) {
          this.prListInFlight.delete(key);
        }
      });
    this.prListInFlight.set(key, promise);
    return promise;
  }

  invalidatePullRequests(repoPath: string): void {
    this.bumpRepoToken(repoPath);
    this.deleteJsonKeysForRepo(this.prListCache, repoPath);
    this.deleteJsonKeysForRepo(this.prListInFlight, repoPath);
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
    const version = this.repoToken(repoPath);
    const promise = api
      .listIssues(repoPath, filter, limit)
      .then((result) => {
        if (this.isCurrentRepoToken(repoPath, version)) {
          this.issueListCache.set(key, result);
        }
        return result;
      })
      .finally(() => {
        if (this.issueListInFlight.get(key) === promise) {
          this.issueListInFlight.delete(key);
        }
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
    const version = this.repoToken(repoPath);
    const promise = api
      .listWorkflowRuns(repoPath, limit)
      .then((result) => {
        if (this.isCurrentRepoToken(repoPath, version)) {
          this.workflowRunsCache.set(key, result);
        }
        return result;
      })
      .finally(() => {
        if (this.workflowRunsInFlight.get(key) === promise) {
          this.workflowRunsInFlight.delete(key);
        }
      });
    this.workflowRunsInFlight.set(key, promise);
    return promise;
  }

  resetForTests(): void {
    this.retainedRepos = null;
    this.repoTokens.clear();
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
    this.commitDiffCache.clear();
    this.commitDiffInFlight.clear();
  }

  repoInvalidationEntryCountForTests(): number {
    return this.repoTokens.size;
  }

  private canStore(repoPath: string): boolean {
    return this.retainedRepos === null || this.retainedRepos.has(repoPath);
  }

  private repoToken(repoPath: string): symbol {
    const existing = this.repoTokens.get(repoPath);
    if (existing) return existing;
    const token = Symbol();
    if (this.canStore(repoPath)) this.repoTokens.set(repoPath, token);
    return token;
  }

  private isCurrentRepoToken(repoPath: string, token: symbol): boolean {
    return this.canStore(repoPath) && this.repoTokens.get(repoPath) === token;
  }

  private bumpRepoToken(repoPath: string): void {
    if (this.canStore(repoPath)) {
      this.repoTokens.set(repoPath, Symbol());
    } else {
      this.repoTokens.delete(repoPath);
    }
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

  private commitDiffKey(repoPath: string, sha: string): string {
    return JSON.stringify([repoPath, sha]);
  }

  private storeCommitDiff(key: string, payload: DiffPayload): void {
    if (
      !this.commitDiffCache.has(key) &&
      this.commitDiffCache.size >= COMMIT_DIFF_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.commitDiffCache.keys().next();
      if (!oldest.done) this.commitDiffCache.delete(oldest.value);
    }
    this.commitDiffCache.set(key, payload);
  }

  private pruneStringKeyedMap<T>(map: Map<string, T>, retained: Set<string>): void {
    for (const key of map.keys()) {
      if (!retained.has(key)) map.delete(key);
    }
  }

  private pruneStringKeyedSet(set: Set<string>, retained: Set<string>): void {
    for (const value of set) {
      if (!retained.has(value)) set.delete(value);
    }
  }

  private pruneJsonKeyedMap<T>(map: Map<string, T>, retained: Set<string>): void {
    for (const key of map.keys()) {
      if (!retained.has(this.repoFromJsonKey(key))) map.delete(key);
    }
  }
  private deleteJsonKeysForRepo<T>(map: Map<string, T>, repoPath: string): void {
    for (const key of map.keys()) {
      if (this.repoFromJsonKey(key) === repoPath) map.delete(key);
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
