import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    isGitRepository: vi.fn(),
    githubOriginSlug: vi.fn(),
  },
}));

import { api } from "./api";
import {
  __resetIsGitHubRepoCacheForTests,
  prefetchGitHubRepoStatus,
  prefetchGitRepositoryStatus,
} from "./useIsGitHubRepo";

const mockApi = vi.mocked(api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("git repository probe cache", () => {
  beforeEach(() => {
    __resetIsGitHubRepoCacheForTests();
    mockApi.isGitRepository.mockReset();
    mockApi.githubOriginSlug.mockReset();
  });

  it("re-probes the oldest path after the cache reaches its path limit", async () => {
    mockApi.isGitRepository.mockResolvedValue(true);
    mockApi.githubOriginSlug.mockResolvedValue("acme/widgets");

    for (let index = 0; index < 300; index += 1) {
      await prefetchGitHubRepoStatus(`/tmp/repo-${index}`);
    }

    expect(mockApi.isGitRepository).toHaveBeenCalledTimes(300);
    expect(mockApi.githubOriginSlug).toHaveBeenCalledTimes(300);

    await prefetchGitHubRepoStatus("/tmp/repo-0");

    expect(mockApi.isGitRepository).toHaveBeenCalledTimes(301);
    expect(mockApi.githubOriginSlug).toHaveBeenCalledTimes(301);
  });

  it("does not let an evicted in-flight probe restore its cache entry", async () => {
    const first = deferred<boolean>();
    mockApi.isGitRepository.mockImplementation((repoPath) => {
      if (repoPath === "/tmp/first" && firstCallCount === 0) {
        firstCallCount += 1;
        return first.promise;
      }
      return Promise.resolve(true);
    });
    let firstCallCount = 0;

    const evictedProbe = prefetchGitRepositoryStatus("/tmp/first");
    for (let index = 0; index < 256; index += 1) {
      await prefetchGitRepositoryStatus(`/tmp/other-${index}`);
    }
    first.resolve(true);
    await evictedProbe;

    await prefetchGitRepositoryStatus("/tmp/first");

    expect(
      mockApi.isGitRepository.mock.calls.filter(
        ([repoPath]) => repoPath === "/tmp/first",
      ),
    ).toHaveLength(2);
  });
});
