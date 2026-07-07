import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestInfo, PullRequestListing, Session } from "./types";

vi.mock("./api", () => ({
  api: {
    listPullRequests: vi.fn<() => Promise<PullRequestListing>>(),
  },
}));

import { api } from "./api";
import {
  primeCurrentPullRequestCacheFromListing,
  useCurrentPullRequest,
} from "./useCurrentPullRequest";

const mockApi = vi.mocked(api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "runner",
    name: "runner",
    repo_path: "/tmp/demo",
    worktree_path: "/tmp/demo/.worktrees/runner",
    branch: "feat/runner",
    isolated: false,
    status: "working",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 77,
    title: "Add kanban PR context",
    state: "OPEN",
    author: "ian",
    head_branch: "feat/runner",
    base_branch: "main",
    url: "https://github.com/im-ian/acorn/pull/77",
    updated_at: "2026-01-01T00:00:00Z",
    is_draft: false,
    checks: null,
    labels: [],
    ...overrides,
  };
}

function Probe({ value }: { value: Session }) {
  const currentPullRequest = useCurrentPullRequest(value);
  return (
    <div>{currentPullRequest ? `PR #${currentPullRequest.number}` : "none"}</div>
  );
}

describe("useCurrentPullRequest", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.listPullRequests.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a primed PR when an older direct lookup resolves empty", async () => {
    const pending = deferred<PullRequestListing>();
    mockApi.listPullRequests.mockReturnValueOnce(pending.promise);

    await act(async () => {
      root.render(<Probe value={session()} />);
    });

    expect(container.textContent).toBe("none");
    expect(mockApi.listPullRequests).toHaveBeenCalledWith(
      "/tmp/demo/.worktrees/runner",
      "open",
      10,
      "head:feat/runner",
    );

    act(() => {
      primeCurrentPullRequestCacheFromListing("/tmp/demo", {
        kind: "ok",
        account: "test",
        items: [pullRequest()],
      });
    });
    expect(container.textContent).toBe("PR #77");

    await act(async () => {
      pending.resolve({ kind: "ok", account: "test", items: [] });
      await pending.promise;
    });

    expect(container.textContent).toBe("PR #77");
  });
});
