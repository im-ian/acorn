import { describe, expect, it } from "vitest";
import {
  buildIpcWorkspaceSummaries,
  parseIpcListWorkspacesRequestPayload,
  type IpcWorkspaceState,
} from "./ipcWorkspaces";
import {
  makeDefaultProjectFolder,
  type ProjectFolder,
} from "./projectFolders";
import type { Session } from "./types";

const REPO = "/repo/acorn";

function session(
  id: string,
  repoPath = REPO,
  worktreePath = repoPath,
): Session {
  return {
    id,
    name: id,
    repo_path: repoPath,
    worktree_path: worktreePath,
    branch: "main",
    isolated: false,
    project_scoped: true,
    status: "idle",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
  };
}

function folder(
  id: string,
  name: string,
  cwdPath = REPO,
  position = 1,
): ProjectFolder {
  return {
    id,
    name,
    repoPath: REPO,
    cwdPath,
    position,
  };
}

function state(
  overrides: Partial<IpcWorkspaceState> = {},
): IpcWorkspaceState {
  return {
    sessions: [],
    projectFolders: {},
    sessionFolderIds: {},
    activeProject: null,
    activeProjectFolderId: null,
    ...overrides,
  };
}

describe("ipc workspace summaries", () => {
  it("includes empty named workspaces for the requested repo", () => {
    const defaultFolder = makeDefaultProjectFolder(REPO);
    const frontend = folder(
      "project-folder:/repo/acorn:frontend",
      "Frontend",
      `${REPO}/packages/web`,
    );

    const summaries = buildIpcWorkspaceSummaries(
      state({
        sessions: [session("ctl")],
        projectFolders: { [REPO]: [defaultFolder, frontend] },
        activeProject: REPO,
      }),
      { repo_path: REPO, source_session_id: "ctl" },
    );

    expect(summaries.map((workspace) => workspace.name)).toEqual([
      "Default",
      "Frontend",
    ]);
    expect(summaries.find((workspace) => workspace.name === "Frontend")).toMatchObject({
      workspace_path: `${REPO}/packages/web`,
      session_count: 0,
      active: false,
      source: false,
    });
    expect(summaries.find((workspace) => workspace.name === "Default")).toMatchObject({
      session_count: 1,
      active: true,
      source: true,
    });
  });

  it("uses the source session assignment to distinguish root workspaces", () => {
    const namedRoot = folder("project-folder:/repo/acorn:kick", "Kick", REPO);
    const ctl = session("ctl");

    const summaries = buildIpcWorkspaceSummaries(
      state({
        sessions: [ctl],
        projectFolders: { [REPO]: [makeDefaultProjectFolder(REPO), namedRoot] },
        sessionFolderIds: { ctl: namedRoot.id },
        activeProject: REPO,
        activeProjectFolderId: namedRoot.id,
      }),
      {
        repo_path: REPO,
        source_session_id: "ctl",
        source_workspace_path: REPO,
      },
    );

    expect(summaries.find((workspace) => workspace.name === "Kick")).toMatchObject({
      active: true,
      source: true,
      session_count: 1,
    });
    expect(summaries.find((workspace) => workspace.name === "Default")).toMatchObject({
      active: false,
      source: false,
      session_count: 0,
    });
  });

  it("parses list workspace request payloads defensively", () => {
    expect(
      parseIpcListWorkspacesRequestPayload({
        request_id: "req",
        source_session_id: "ctl",
        repo_path: REPO,
        source_workspace_path: REPO,
      }),
    ).toEqual({
      request_id: "req",
      source_session_id: "ctl",
      repo_path: REPO,
      source_workspace_path: REPO,
    });
    expect(parseIpcListWorkspacesRequestPayload(null)).toBeNull();
  });
});
