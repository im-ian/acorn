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
  PullRequestDetail,
  PullRequestDetailListing,
} from "../lib/types";

vi.mock("../lib/api", () => {
  return {
    api: {
      getPullRequestDetail: vi.fn<
        (repoPath: string, n: number) => Promise<PullRequestDetailListing>
      >(),
      updatePullRequestBody: vi.fn<
        (repoPath: string, n: number, body: string) => Promise<void>
      >(),
    },
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { api } from "../lib/api";
import { PullRequestDetailModal } from "./PullRequestDetailModal";

const mockApi = vi.mocked(api);

function fakeDetail(body: string): PullRequestDetail {
  return {
    number: 999,
    title: "test",
    body,
    state: "OPEN",
    is_draft: false,
    author: "tester",
    head_branch: "feat",
    base_branch: "main",
    url: "https://github.com/x/y/pull/999",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    merged_at: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    mergeable: "MERGEABLE",
    comments: [],
    reviews: [],
    checks: [],
    diff: { files: [] },
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PullRequestDetailModal — body checkbox toggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.getPullRequestDetail.mockReset();
    mockApi.updatePullRequestBody.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("optimistically toggles a checkbox and calls updatePullRequestBody with the rewritten body", async () => {
    const initialBody = "- [ ] alpha\n- [ ] beta";
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail: fakeDetail(initialBody),
    });
    mockApi.updatePullRequestBody.mockResolvedValue();

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const boxes = document.body.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes.length).toBe(2);
    expect(boxes[0]?.disabled).toBe(false);

    // Second one for some variety in indexing.
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail: fakeDetail("- [ ] alpha\n- [x] beta"),
    });

    await act(async () => {
      boxes[1]!.click();
    });

    expect(mockApi.updatePullRequestBody).toHaveBeenCalledWith(
      "/r",
      999,
      "- [ ] alpha\n- [x] beta",
    );

    // Optimistic UI: the second checkbox should be reflected as checked in
    // the rendered DOM right after the click (before the refetch resolves).
    const updated = document.body.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(updated[0]?.checked).toBe(false);
    expect(updated[1]?.checked).toBe(true);
  });

  it("reverts and surfaces an error when updatePullRequestBody rejects", async () => {
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail: fakeDetail("- [ ] only"),
    });
    mockApi.updatePullRequestBody.mockRejectedValue(
      new Error("Resource not accessible"),
    );

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const box = document.body.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => {
      box.click();
    });
    await flushPromises();

    const after = document.body.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(after.checked).toBe(false);
    expect(document.body.textContent).toContain("Couldn't save checkbox");
  });
});
