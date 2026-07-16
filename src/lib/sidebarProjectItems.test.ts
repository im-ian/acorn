import { describe, expect, it } from "vitest";
import {
  buildDragPriorityIndex,
  buildProjectTopLevelItems,
  isPriorityDropAllowed,
  orderSessionsByPriority,
  orderProjectTopLevelItems,
  planProjectTopLevelDrag,
  refuseCrossPriorityGroupDrop,
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

  const MANUAL_ORDER = [
    "session:idle-root",
    "session:failed-root",
    "session:needs-root",
    "session:running-root",
    "folder:idle-folder",
    "folder:needs-folder",
  ];

  it("plans a drag without floating priority items into the saved order", () => {
    // running-root and idle-root are both ready work, so the collision filter
    // allows this drag. Only those two may move; the waiting and errored rows
    // keep their saved slots rather than being rewritten to where the priority
    // sort happens to show them today.
    const planned = planProjectTopLevelDrag(
      project(),
      MANUAL_ORDER,
      "session:running-root",
      "session:idle-root",
    );

    expect(planned?.nextOrder).toEqual([
      "session:running-root",
      "session:idle-root",
      "session:failed-root",
      "session:needs-root",
      "folder:idle-folder",
      "folder:needs-folder",
    ]);
  });

  it("lands a same-group drag exactly where the user dropped it", () => {
    // The plan is scored against the saved order while the user drags in the
    // sorted one. For a drag inside a single priority group the two must agree,
    // otherwise the sort yanks the row back on the next render.
    const displayed = buildProjectTopLevelItems(project(), MANUAL_ORDER, true);
    expect(displayed.map((item) => item.id)).toEqual([
      "session:failed-root",
      "session:needs-root",
      "folder:needs-folder",
      "session:idle-root",
      "session:running-root",
      "folder:idle-folder",
    ]);

    const planned = planProjectTopLevelDrag(
      project(),
      MANUAL_ORDER,
      "session:running-root",
      "session:idle-root",
    );
    const redisplayed = buildProjectTopLevelItems(
      project(),
      planned!.nextOrder,
      true,
    ).map((item) => item.id);

    // What the user saw: running-root picked up and dropped onto idle-root.
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
        MANUAL_ORDER,
        "session:idle-root",
        "session:idle-root",
      ),
    ).toBeNull();
    expect(
      planProjectTopLevelDrag(
        project(),
        MANUAL_ORDER,
        "session:idle-root",
        "session:not-a-real-item",
      ),
    ).toBeNull();
  });

  it("indexes drag ids by priority group and reorder container", () => {
    const index = buildDragPriorityIndex([project()]);

    expect(index.get("session:needs-root")).toEqual({
      containerId: "project:/repo/app",
      isPrioritized: true,
    });
    expect(index.get("session:failed-root")?.isPrioritized).toBe(true);
    expect(index.get("session:idle-root")?.isPrioritized).toBe(false);
    expect(index.get("session:running-root")?.isPrioritized).toBe(false);
    // A folder joins the priority group as soon as one session inside it needs
    // attention, matching how the folder row is displayed.
    expect(index.get("folder:needs-folder")).toEqual({
      containerId: "project:/repo/app",
      isPrioritized: true,
    });
    expect(index.get("folder:idle-folder")?.isPrioritized).toBe(false);
    expect(index.get("session:nested-needs")).toEqual({
      containerId: "folder:needs-folder",
      isPrioritized: true,
    });
    expect(index.get("session:nested-idle")?.isPrioritized).toBe(false);
  });

  it("only rejects cross-group rows inside the same container", () => {
    const index = buildDragPriorityIndex([project()]);

    expect(
      isPriorityDropAllowed(index, "session:idle-root", "session:running-root"),
    ).toBe(true);
    expect(
      isPriorityDropAllowed(index, "session:needs-root", "session:failed-root"),
    ).toBe(true);
    expect(
      isPriorityDropAllowed(index, "session:idle-root", "session:needs-root"),
    ).toBe(false);
    expect(
      isPriorityDropAllowed(index, "session:running-root", "folder:needs-folder"),
    ).toBe(false);
    expect(
      isPriorityDropAllowed(index, "session:nested-needs", "session:idle-root"),
    ).toBe(true);
    // Drop zones (folder / project targets) carry no priority group, so they
    // stay available as move targets.
    expect(
      isPriorityDropAllowed(
        index,
        "session:idle-root",
        "session:folder:needs-folder",
      ),
    ).toBe(true);
  });

  describe("refuseCrossPriorityGroupDrop", () => {
    const index = buildDragPriorityIndex([project()]);
    const collisionsFor = (...ids: string[]) => ids.map((id) => ({ id }));

    it("refuses the drop when the winning row is in the other group", () => {
      const collisions = collisionsFor(
        "session:needs-root",
        "session:running-root",
      );

      expect(
        refuseCrossPriorityGroupDrop(index, "session:idle-root", collisions),
      ).toEqual([]);
    });

    it("keeps every candidate when the winning row shares the group", () => {
      const collisions = collisionsFor(
        "session:running-root",
        "session:needs-root",
      );

      expect(
        refuseCrossPriorityGroupDrop(index, "session:idle-root", collisions),
      ).toBe(collisions);
    });

    it("allows a cross-group row drop when it moves between containers", () => {
      const collisions = collisionsFor("session:idle-root");

      expect(
        refuseCrossPriorityGroupDrop(index, "session:nested-needs", collisions),
      ).toBe(collisions);
    });

    // Refusing must not rewrite the ranking: dropping the winner would promote
    // whatever ranked next — typically a folder drop zone — and file the
    // session into a folder the user never aimed at.
    it("refuses rather than promoting the runner-up", () => {
      const collisions = collisionsFor(
        "session:needs-root",
        "session:folder:idle-folder",
      );

      expect(
        refuseCrossPriorityGroupDrop(index, "session:idle-root", collisions),
      ).toEqual([]);
    });

    it("leaves drop zones and unindexed rows alone", () => {
      const dropZone = collisionsFor("session:folder:needs-folder");
      expect(
        refuseCrossPriorityGroupDrop(index, "session:idle-root", dropZone),
      ).toBe(dropZone);

      // Local terminal rows are absent from the index and must stay draggable.
      const localRow = collisionsFor("session:local-1");
      expect(
        refuseCrossPriorityGroupDrop(index, "session:local-2", localRow),
      ).toBe(localRow);
    });

    it("has nothing to refuse when nothing collided", () => {
      expect(
        refuseCrossPriorityGroupDrop(index, "session:idle-root", []),
      ).toEqual([]);
    });
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
