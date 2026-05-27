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
      mergePullRequest: vi.fn(),
      closePullRequest: vi.fn(),
      generatePrCommitMessage: vi.fn(),
      getProjectSettings: vi.fn(),
      updateProjectSettings: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { api } from "../lib/api";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
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
    labels: [],
    comments: [],
    reviews: [],
    checks: [],
    commits: [],
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
    mockApi.mergePullRequest.mockReset();
    mockApi.closePullRequest.mockReset();
    mockApi.generatePrCommitMessage.mockReset();
    mockApi.getProjectSettings.mockReset();
    mockApi.updateProjectSettings.mockReset();
    mockApi.getProjectSettings.mockResolvedValue({
      key: "path:/r",
      settings: {
        remember_after_close: true,
        pull_requests: { generation_prompt: null },
      },
    });
    window.localStorage.clear();
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
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

  it("uses the API-provided conversation author avatar URL", async () => {
    const detail = fakeDetail("");
    detail.comments = [
      {
        author: "linear-code",
        author_avatar_url:
          "https://avatars.githubusercontent.com/in/1658531?s=80&v=4",
        body: "Figma parity note",
        created_at: "2026-05-19T02:00:00Z",
      },
    ];
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail,
    });

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const img = document.body.querySelector<HTMLImageElement>(
      'img[title="linear-code"]',
    );
    expect(img?.src).toBe(
      "https://avatars.githubusercontent.com/in/1658531?s=56&v=4",
    );
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

  it("updates running check durations every second without refetching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:05Z"));
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail: {
        ...fakeDetail(""),
        checks: [
          {
            name: "test",
            workflow_name: "CI",
            status: "IN_PROGRESS",
            conclusion: null,
            started_at: "2026-05-19T12:00:00Z",
            completed_at: null,
            url: "https://github.com/x/y/actions/runs/1",
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const checksTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Checks"));
    expect(checksTab).toBeDefined();
    await act(async () => {
      checksTab!.click();
    });

    expect(document.body.textContent).toContain("CI / test");
    expect(document.body.textContent).toContain("5s");
    expect(mockApi.getPullRequestDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(document.body.textContent).toContain("6s");
    expect(mockApi.getPullRequestDetail).toHaveBeenCalledTimes(1);
  });

  it("polls PR detail while checks are running and freezes duration on completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:05Z"));
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        github: {
          ...DEFAULT_SETTINGS.github,
          refreshIntervalMs: 2_000,
        },
      },
    });
    mockApi.getPullRequestDetail
      .mockResolvedValueOnce({
        kind: "ok",
        account: "tester",
        detail: {
          ...fakeDetail(""),
          checks: [
            {
              name: "test",
              workflow_name: "CI",
              status: "IN_PROGRESS",
              conclusion: null,
              started_at: "2026-05-19T12:00:00Z",
              completed_at: null,
              url: "https://github.com/x/y/actions/runs/1",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        account: "tester",
        detail: {
          ...fakeDetail(""),
          checks: [
            {
              name: "test",
              workflow_name: "CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              started_at: "2026-05-19T12:00:00Z",
              completed_at: "2026-05-19T12:00:06Z",
              url: "https://github.com/x/y/actions/runs/1",
            },
          ],
        },
      });

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const checksTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Checks"));
    expect(checksTab).toBeDefined();
    await act(async () => {
      checksTab!.click();
    });
    expect(document.body.textContent).toContain("5s");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flushPromises();

    expect(mockApi.getPullRequestDetail).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("6s");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flushPromises();

    expect(mockApi.getPullRequestDetail).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("6s");
  });

  it("opens project settings from the hidden GEN prompt button", async () => {
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail: fakeDetail("Describe the change"),
    });

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const mergeButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Merge");
    expect(mergeButton).toBeDefined();

    await act(async () => {
      mergeButton!.click();
    });
    await flushPromises();

    const promptBox = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="GEN prompt"]',
    );
    expect(promptBox).toBeNull();

    const settingsButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Go to project settings"]',
    );
    expect(settingsButton).toBeTruthy();
    await act(async () => {
      settingsButton!.click();
    });
    await flushPromises();

    expect(document.body.textContent).toContain("Project Settings");
    expect(document.body.textContent).toContain(
      "Prompt for generated PR titles, comments, and merge messages",
    );
  });

  it("uses the project GEN prompt and applies the generated PR comment", async () => {
    mockApi.getProjectSettings.mockResolvedValueOnce({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt:
            "프로젝트 규칙대로 PR title과 comment를 한국어 릴리즈 노트 스타일로 작성해.",
        },
      },
    });
    mockApi.getPullRequestDetail.mockResolvedValueOnce({
      kind: "ok",
      account: "tester",
      detail: fakeDetail("Describe the change"),
    });
    mockApi.generatePrCommitMessage.mockResolvedValueOnce({
      title: "feat(pr): 프로젝트 설정 기반 생성",
      body: "프로젝트 설정 프롬프트를 반영한 PR 코멘트입니다.",
    });

    await act(async () => {
      root.render(
        <PullRequestDetailModal
          open={{ repoPath: "/r", number: 999 }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const mergeButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Merge");
    expect(mergeButton).toBeDefined();

    await act(async () => {
      mergeButton!.click();
    });
    await flushPromises();

    const promptBox = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="GEN prompt"]',
    );
    expect(promptBox).toBeNull();

    const generateButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Generate with AI"));
    expect(generateButton).toBeDefined();

    await act(async () => {
      generateButton!.click();
    });
    await flushPromises();

    expect(mockApi.generatePrCommitMessage).toHaveBeenCalledWith(
      "/r",
      999,
      "squash",
      "claude",
      ["-p", "--output-format", "text"],
      "프로젝트 규칙대로 PR title과 comment를 한국어 릴리즈 노트 스타일로 작성해.",
    );

    const generatedTitle = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ).find(
      (input) => input.value === "feat(pr): 프로젝트 설정 기반 생성",
    );
    expect(generatedTitle).toBeDefined();

    const generatedComment = Array.from(
      document.body.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ).find(
      (textarea) =>
        textarea.value === "프로젝트 설정 프롬프트를 반영한 PR 코멘트입니다.",
    );
    expect(generatedComment).toBeDefined();
  });
});
