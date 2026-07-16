import { describe, expect, it } from "vitest";
import {
  buildDragPriorityIndex,
  buildProjectTopLevelItems,
  isSameDragPriorityGroup,
  orderSessionsByPriority,
  orderProjectTopLevelItems,
  planProjectTopLevelDrag,
} from "./sidebarProjectItems";
import {
  makeDefaultProjectFolder,
  type ProjectFolderGroup,
} from "./projectFolders";
import type { ProjectFolderProjectGroup } from "./projectFolders";
import type { Session } from "./types";

function session(
  id: string,
  status: Session["status"] = "ready",
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
      session("idle-root", "ready", 0),
      session("failed-root", "errored", 1),
      session("needs-root", "waiting_for_input", 2),
      session("running-root", "working", 3),
      session("nested-idle", "ready", 4),
      session("nested-needs", "waiting_for_input", 5),
    ],
    folders: [
      {
        folder: root,
        sessions: [
          session("idle-root", "ready", 0),
          session("failed-root", "errored", 1),
          session("needs-root", "waiting_for_input", 2),
          session("running-root", "working", 3),
        ],
      },
      folderGroup("idle-folder", [session("nested-idle", "ready", 4)]),
      folderGroup("needs-folder", [session("nested-needs", "waiting_for_input", 5)]),
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

  it("can move waiting and error project items above ready work", () => {
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

  it("plans a drag against the order the user sees, not the saved order", () => {
    const manualOrder = [
      "session:idle-root",
      "session:failed-root",
      "session:needs-root",
      "session:running-root",
      "folder:idle-folder",
      "folder:needs-folder",
    ];
    const displayed = buildProjectTopLevelItems(project(), manualOrder, true);
    expect(displayed.map((item) => item.id)).toEqual([
      "session:failed-root",
      "session:needs-root",
      "folder:needs-folder",
      "session:idle-root",
      "session:running-root",
      "folder:idle-folder",
    ]);

    // Drag running-root from the bottom of the ready group up onto needs-root.
    // The priority sort pins needs-root above it, but running-root must still
    // land ahead of idle-root once the list re-renders.
    const planned = planProjectTopLevelDrag(
      project(),
      manualOrder,
      true,
      "session:running-root",
      "session:needs-root",
    );

    expect(planned).not.toBeNull();
    const redisplayed = buildProjectTopLevelItems(
      project(),
      planned!.nextOrder,
      true,
    ).map((item) => item.id);
    expect(redisplayed).toEqual([
      "session:failed-root",
      "session:needs-root",
      "folder:needs-folder",
      "session:running-root",
      "session:idle-root",
      "folder:idle-folder",
    ]);
  });

  it("reports no drag plan when the item does not move", () => {
    expect(
      planProjectTopLevelDrag(
        project(),
        ["session:idle-root", "session:running-root"],
        false,
        "session:idle-root",
        "session:idle-root",
      ),
    ).toBeNull();
    expect(
      planProjectTopLevelDrag(
        project(),
        ["session:idle-root", "session:running-root"],
        false,
        "session:idle-root",
        "session:not-a-real-item",
      ),
    ).toBeNull();
  });

  it("indexes drag ids by the priority group they are displayed in", () => {
    const index = buildDragPriorityIndex([project()]);

    expect(index.get("session:needs-root")).toBe(true);
    expect(index.get("session:failed-root")).toBe(true);
    expect(index.get("session:idle-root")).toBe(false);
    expect(index.get("session:running-root")).toBe(false);
    // A folder joins the priority group as soon as one session inside it needs
    // attention, matching how the folder row is displayed.
    expect(index.get("folder:needs-folder")).toBe(true);
    expect(index.get("folder:idle-folder")).toBe(false);
    expect(index.get("session:nested-needs")).toBe(true);
    expect(index.get("session:nested-idle")).toBe(false);
  });

  it("only pairs drag ids that share a priority group", () => {
    const index = buildDragPriorityIndex([project()]);

    expect(
      isSameDragPriorityGroup(index, "session:idle-root", "session:running-root"),
    ).toBe(true);
    expect(
      isSameDragPriorityGroup(index, "session:needs-root", "session:failed-root"),
    ).toBe(true);
    expect(
      isSameDragPriorityGroup(index, "session:idle-root", "session:needs-root"),
    ).toBe(false);
    expect(
      isSameDragPriorityGroup(index, "session:running-root", "folder:needs-folder"),
    ).toBe(false);
    // Drop zones (folder / project targets) carry no priority group, so they
    // stay available as move targets.
    expect(
      isSameDragPriorityGroup(index, "session:idle-root", "session:folder:needs-folder"),
    ).toBe(true);
  });

  it("can move waiting and error sessions above ready work", () => {
    const sessions = [
      session("ready", "ready"),
      session("errored", "errored"),
      session("needs", "waiting_for_input"),
      session("working", "working"),
    ];

    expect(orderSessionsByPriority(sessions, true).map((s) => s.id)).toEqual([
      "errored",
      "needs",
      "ready",
      "working",
    ]);
    expect(orderSessionsByPriority(sessions, false).map((s) => s.id)).toEqual([
      "ready",
      "errored",
      "needs",
      "working",
    ]);
    expect(sessions.map((s) => s.id)).toEqual([
      "ready",
      "errored",
      "needs",
      "working",
    ]);
  });
});
