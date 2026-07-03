import { describe, expect, it } from "vitest";
import {
  buildProjectTopLevelItems,
  orderSessionsByPriority,
  orderProjectTopLevelItems,
} from "./sidebarProjectItems";
import {
  makeDefaultProjectFolder,
  type ProjectFolderGroup,
} from "./projectFolders";
import type { ProjectFolderProjectGroup } from "./projectFolders";
import type { Session } from "./types";

function session(
  id: string,
  status: Session["status"] = "idle",
  position: number | null = null,
): Session {
  return {
    id,
    name: id,
    repo_path: "/repo/app",
    worktree_path: "/repo/app",
    branch: "main",
    isolated: false,
    status,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position,
    in_worktree: false,
  };
}

function folderGroup(id: string, sessions: Session[]): ProjectFolderGroup {
  return {
    folder: {
      id,
      repoPath: "/repo/app",
      name: id,
      cwdPath: `/repo/app/${id}`,
      position: 1,
    },
    sessions,
  };
}

function project(): ProjectFolderProjectGroup {
  const root = makeDefaultProjectFolder("/repo/app");
  return {
    repoPath: "/repo/app",
    name: "app",
    sessions: [
      session("idle-root", "idle", 0),
      session("failed-root", "failed", 1),
      session("needs-root", "needs_input", 2),
      session("running-root", "running", 3),
      session("nested-idle", "idle", 4),
      session("nested-needs", "needs_input", 5),
    ],
    folders: [
      {
        folder: root,
        sessions: [
          session("idle-root", "idle", 0),
          session("failed-root", "failed", 1),
          session("needs-root", "needs_input", 2),
          session("running-root", "running", 3),
        ],
      },
      folderGroup("idle-folder", [session("nested-idle", "idle", 4)]),
      folderGroup("needs-folder", [session("nested-needs", "needs_input", 5)]),
    ],
  };
}

describe("sidebar project items", () => {
  it("preserves manual project item order by default", () => {
    const items = buildProjectTopLevelItems(project(), [
      "folder:idle-folder",
      "session:running-root",
      "session:needs-root",
      "session:failed-root",
      "folder:needs-folder",
      "session:idle-root",
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "folder:idle-folder",
      "session:running-root",
      "session:needs-root",
      "session:failed-root",
      "folder:needs-folder",
      "session:idle-root",
    ]);
  });

  it("can move needs-input and failed project items above idle work", () => {
    const items = buildProjectTopLevelItems(
      project(),
      [
        "folder:idle-folder",
        "session:running-root",
        "session:needs-root",
        "session:failed-root",
        "folder:needs-folder",
        "session:idle-root",
      ],
      true,
    );

    expect(items.map((item) => item.id)).toEqual([
      "session:needs-root",
      "session:failed-root",
      "folder:needs-folder",
      "folder:idle-folder",
      "session:running-root",
      "session:idle-root",
    ]);
  });

  it("orders urgent items without rewriting the saved order", () => {
    const items = buildProjectTopLevelItems(project(), [
      "session:running-root",
      "session:needs-root",
      "session:failed-root",
      "session:idle-root",
    ]);
    const ordered = orderProjectTopLevelItems(
      items,
      [
        "session:idle-root",
        "session:running-root",
        "session:failed-root",
        "session:needs-root",
      ],
      true,
    );

    expect(ordered.map((item) => item.id)).toEqual([
      "session:failed-root",
      "session:needs-root",
      "folder:needs-folder",
      "session:idle-root",
      "session:running-root",
      "folder:idle-folder",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "session:running-root",
      "session:needs-root",
      "session:failed-root",
      "session:idle-root",
      "folder:idle-folder",
      "folder:needs-folder",
    ]);
  });

  it("can move needs-input and failed sessions above idle work", () => {
    const sessions = [
      session("idle", "idle"),
      session("failed", "failed"),
      session("needs", "needs_input"),
      session("running", "running"),
    ];

    expect(orderSessionsByPriority(sessions, true).map((s) => s.id)).toEqual([
      "failed",
      "needs",
      "idle",
      "running",
    ]);
    expect(orderSessionsByPriority(sessions, false).map((s) => s.id)).toEqual([
      "idle",
      "failed",
      "needs",
      "running",
    ]);
    expect(sessions.map((s) => s.id)).toEqual([
      "idle",
      "failed",
      "needs",
      "running",
    ]);
  });
});
