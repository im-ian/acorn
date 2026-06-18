import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Project,
  ProjectSettingsRecord,
  ProjectWorktree,
  Session,
} from "../lib/types";
import type { WorktreeRemoval } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: {
    getProjectSettings: vi.fn<() => Promise<ProjectSettingsRecord>>(),
    listProjectWorktrees: vi.fn<
      (repoPath: string) => Promise<ProjectWorktree[]>
    >(),
    listProjects: vi.fn<() => Promise<Project[]>>(),
    listSessions: vi.fn<() => Promise<Session[]>>(),
    removeWorktree: vi.fn<
      (
        repoPath: string,
        worktreePath: string,
        removeSessions?: boolean,
      ) => Promise<WorktreeRemoval | null>
    >(),
    updateProjectSettings: vi.fn<
      (
        repoPath: string,
        settings: ProjectSettingsRecord["settings"],
      ) => Promise<ProjectSettingsRecord>
    >(),
  },
}));

import { api } from "../lib/api";
import { useAppStore } from "../store";
import { ProjectSettingsModal } from "./ProjectSettingsModal";

const mockApi = vi.mocked(api);

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function changeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "session-1",
    name: "Session 1",
    repo_path: "/repo/acorn",
    worktree_path: "/repo/acorn",
    branch: "main",
    isolated: false,
    status: "idle",
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

describe("ProjectSettingsModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({
      sessions: [],
      projects: [],
      projectFolders: {},
      sessionFolderIds: {},
      workspaces: {},
      activeProject: null,
      activeProjectFolderId: null,
      error: null,
    });
    mockApi.getProjectSettings.mockReset();
    mockApi.listProjectWorktrees.mockReset();
    mockApi.listProjects.mockReset();
    mockApi.listSessions.mockReset();
    mockApi.removeWorktree.mockReset();
    mockApi.updateProjectSettings.mockReset();
    mockApi.listProjectWorktrees.mockResolvedValue([]);
    mockApi.listProjects.mockResolvedValue([]);
    mockApi.listSessions.mockResolvedValue([]);
    mockApi.removeWorktree.mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads and saves project pull request settings", async () => {
    mockApi.getProjectSettings.mockResolvedValueOnce({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt: "Use concise release-note style.",
        },
      },
    });
    mockApi.updateProjectSettings.mockImplementation(
      async (_repoPath, settings) => ({
        key: "github:im-ian/acorn",
        settings,
      }),
    );
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={onClose}
        />,
      );
    });
    await flushPromises();

    const pullRequestsTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Pull requests");
    expect(pullRequestsTab).toBeDefined();
    await act(async () => {
      pullRequestsTab!.click();
    });

    const prompt = document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(prompt?.value).toBe("Use concise release-note style.");

    await act(async () => {
      changeTextareaValue(prompt!, "Write Korean release notes.");
    });

    const generalTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "General");
    expect(generalTab).toBeDefined();
    await act(async () => {
      generalTab!.click();
    });

    const keepCheckbox = document.body.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(keepCheckbox?.checked).toBe(true);
    await act(async () => {
      keepCheckbox!.click();
    });

    const save = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Save");
    expect(save).toBeDefined();

    await act(async () => {
      save!.click();
    });
    await flushPromises();

    expect(mockApi.updateProjectSettings).toHaveBeenCalledWith("/repo/acorn", {
      remember_after_close: false,
      pull_requests: {
        generation_prompt: "Write Korean release notes.",
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the standard PR prompt while project settings are loading", async () => {
    mockApi.getProjectSettings.mockImplementation(
      () => new Promise<ProjectSettingsRecord>(() => {}),
    );

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          initialTab="pullRequests"
          onClose={() => {}}
        />,
      );
    });

    const prompt = document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(prompt?.value).toContain("GitHub-style pull request");
  });

  it("lists project worktrees and removes one after confirmation", async () => {
    mockApi.getProjectSettings.mockResolvedValue({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt: "Use concise release-note style.",
        },
      },
    });
    mockApi.listProjectWorktrees
      .mockResolvedValueOnce([
        {
          name: "feature-alpha",
          path: "/repo/acorn/.acorn/worktrees/feature-alpha",
          modified_ms: Date.UTC(2026, 4, 19, 12, 0, 0),
        },
        {
          name: "feature-beta",
          path: "/repo/acorn/.acorn/worktrees/feature-beta",
          modified_ms: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          name: "feature-beta",
          path: "/repo/acorn/.acorn/worktrees/feature-beta",
          modified_ms: null,
        },
      ]);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={onClose}
        />,
      );
    });
    await flushPromises();

    const worktreesTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Worktrees");
    expect(worktreesTab).toBeDefined();

    await act(async () => {
      worktreesTab!.click();
    });
    await flushPromises();

    expect(document.body.textContent).toContain("feature-alpha");
    expect(document.body.textContent).toContain("May 19, 2026");
    expect(document.body.textContent).toContain("Last modified unknown");

    const remove = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) =>
        button.getAttribute("aria-label") ===
        "Remove feature-alpha worktree",
    );
    expect(remove).toBeDefined();

    await act(async () => {
      remove!.click();
    });

    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Delete worktree");
    expect(confirm).toBeDefined();

    await act(async () => {
      confirm!.click();
    });
    await flushPromises();

    expect(mockApi.removeWorktree).toHaveBeenCalledWith(
      "/repo/acorn",
      "/repo/acorn/.acorn/worktrees/feature-alpha",
      false,
    );
    expect(document.body.textContent).not.toContain("feature-alpha");
    expect(document.body.textContent).toContain("feature-beta");
  });

  it("requires confirmation before deleting a worktree used by the active session", async () => {
    mockApi.getProjectSettings.mockResolvedValue({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt: "Use concise release-note style.",
        },
      },
    });
    mockApi.listProjectWorktrees
      .mockResolvedValueOnce([
        {
          name: "feature-alpha",
          path: "/repo/acorn/.acorn/worktrees/feature-alpha",
          modified_ms: null,
        },
      ])
      .mockResolvedValueOnce([]);
    useAppStore.setState({
      sessions: [
        session({
          id: "s-alpha-1",
          name: "alpha terminal",
          worktree_path: "/repo/acorn/.acorn/worktrees/feature-alpha",
          in_worktree: true,
        }),
      ],
      activeSessionId: "s-alpha-1",
      projects: [
        {
          repo_path: "/repo/acorn",
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ],
    });
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={onClose}
        />,
      );
    });
    await flushPromises();

    const worktreesTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Worktrees");
    await act(async () => {
      worktreesTab!.click();
    });
    await flushPromises();

    expect(document.body.textContent).toContain("Used by 1 session");

    const remove = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) =>
        button.getAttribute("aria-label") ===
        "Remove feature-alpha worktree",
    );
    expect(remove).toBeDefined();

    await act(async () => {
      remove!.click();
    });

    expect(document.body.textContent).toContain("alpha terminal");
    expect(document.body.textContent).toContain("1 session will be removed");

    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) => button.textContent === "Remove sessions and delete worktree",
    );
    expect(confirm).toBeDefined();

    await act(async () => {
      confirm!.click();
    });
    await flushPromises();

    expect(mockApi.removeWorktree).toHaveBeenCalledWith(
      "/repo/acorn",
      "/repo/acorn/.acorn/worktrees/feature-alpha",
      true,
    );
    expect(useAppStore.getState().sessions).toEqual([]);
    expect(document.body.textContent).not.toContain("feature-alpha");
  });

  it("blocks worktree deletion while another session uses it", async () => {
    mockApi.getProjectSettings.mockResolvedValue({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt: "Use concise release-note style.",
        },
      },
    });
    mockApi.listProjectWorktrees.mockResolvedValue([
      {
        name: "feature-alpha",
        path: "/repo/acorn/.acorn/worktrees/feature-alpha",
        modified_ms: null,
      },
    ]);
    useAppStore.setState({
      sessions: [
        session({
          id: "s-alpha-1",
          name: "alpha terminal",
          worktree_path: "/repo/acorn/.acorn/worktrees/feature-alpha",
          in_worktree: true,
        }),
        session({
          id: "s-alpha-2",
          name: "alpha chat",
          worktree_path: "/repo/acorn/.acorn/worktrees/feature-alpha/",
          in_worktree: true,
        }),
      ],
      activeSessionId: "s-alpha-1",
      projects: [
        {
          repo_path: "/repo/acorn",
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ],
    });

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const worktreesTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Worktrees");
    await act(async () => {
      worktreesTab!.click();
    });
    await flushPromises();

    expect(document.body.textContent).toContain("Used by 2 sessions");
    expect(document.body.textContent).toContain(
      "Close other sessions using this worktree before removing it.",
    );

    const remove = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) =>
        button.getAttribute("aria-label") ===
        "Remove feature-alpha worktree",
    );
    expect(remove).toBeDefined();
    expect(remove?.disabled).toBe(true);

    await act(async () => {
      remove!.click();
    });

    expect(document.body.textContent).not.toContain(
      "Remove sessions and delete worktree",
    );
    expect(mockApi.removeWorktree).not.toHaveBeenCalled();
  });

  it("blocks worktree deletion while another project session uses the same path", async () => {
    mockApi.getProjectSettings.mockResolvedValue({
      key: "github:im-ian/acorn",
      settings: {
        remember_after_close: true,
        pull_requests: {
          generation_prompt: "Use concise release-note style.",
        },
      },
    });
    mockApi.listProjectWorktrees.mockResolvedValue([
      {
        name: "feature-alpha",
        path: "/repo/acorn/.acorn/worktrees/feature-alpha",
        modified_ms: null,
      },
    ]);
    useAppStore.setState({
      sessions: [
        session({
          id: "s-alpha-1",
          name: "alpha terminal",
          worktree_path: "/repo/acorn/.acorn/worktrees/feature-alpha",
          in_worktree: true,
        }),
        session({
          id: "s-other-1",
          name: "other project chat",
          repo_path: "/repo/other",
          worktree_path: "/repo/acorn/.acorn/worktrees/feature-alpha/",
          in_worktree: true,
        }),
      ],
      activeSessionId: "s-alpha-1",
      projects: [
        {
          repo_path: "/repo/acorn",
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ],
    });

    await act(async () => {
      root.render(
        <ProjectSettingsModal
          project={{ name: "acorn", repoPath: "/repo/acorn" }}
          onClose={() => {}}
        />,
      );
    });
    await flushPromises();

    const worktreesTab = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Worktrees");
    await act(async () => {
      worktreesTab!.click();
    });
    await flushPromises();

    expect(document.body.textContent).toContain("Used by 2 sessions");
    expect(document.body.textContent).toContain(
      "Close other sessions using this worktree before removing it.",
    );

    const remove = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) =>
        button.getAttribute("aria-label") ===
        "Remove feature-alpha worktree",
    );
    expect(remove).toBeDefined();
    expect(remove?.disabled).toBe(true);

    await act(async () => {
      remove!.click();
    });

    expect(document.body.textContent).not.toContain(
      "Remove sessions and delete worktree",
    );
    expect(mockApi.removeWorktree).not.toHaveBeenCalled();
  });
});
