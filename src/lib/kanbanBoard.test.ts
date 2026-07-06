import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KANBAN_SORT_MODE,
  KANBAN_COLUMN_DEFAULT_WIDTH,
  KANBAN_COLUMN_MIN_WIDTH,
  KANBAN_COLUMN_STATUSES,
  clampKanbanColumnWidth,
  defaultKanbanBoardPrefs,
  defaultKanbanColumnWidths,
  equalizeKanbanColumnWidths,
  readKanbanBoardPrefs,
  sessionMatchesKanbanFilter,
  sortKanbanSessions,
  toKanbanSortMode,
  writeKanbanBoardPrefs,
  type KanbanBoardPrefs,
} from "./kanbanBoard";
import type { Session } from "./types";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "s",
    name: "session",
    branch: "main",
    worktree_path: "/repo/session",
    status: "ready",
    mode: "agent",
    kind: "session",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Session;
}

const STORAGE_KEY = "acorn:workspace-kanban:board-prefs:v1";

describe("clampKanbanColumnWidth", () => {
  it("raises widths below the minimum to the minimum", () => {
    expect(clampKanbanColumnWidth(10)).toBe(KANBAN_COLUMN_MIN_WIDTH);
  });

  it("rounds fractional widths", () => {
    expect(clampKanbanColumnWidth(200.4)).toBe(200);
    expect(clampKanbanColumnWidth(200.6)).toBe(201);
  });

  it("keeps widths at or above the minimum", () => {
    expect(clampKanbanColumnWidth(300)).toBe(300);
  });
});

describe("defaultKanbanColumnWidths", () => {
  it("returns one default width per column", () => {
    const widths = defaultKanbanColumnWidths();
    expect(widths).toHaveLength(KANBAN_COLUMN_STATUSES.length);
    expect(widths.every((w) => w === KANBAN_COLUMN_DEFAULT_WIDTH)).toBe(true);
  });
});

describe("toKanbanSortMode", () => {
  it("accepts the known sort modes", () => {
    expect(toKanbanSortMode("updated-desc")).toBe("updated-desc");
    expect(toKanbanSortMode("created-desc")).toBe("created-desc");
    expect(toKanbanSortMode("name-asc")).toBe("name-asc");
  });

  it("falls back to the default for unknown values", () => {
    expect(toKanbanSortMode("nonsense")).toBe(DEFAULT_KANBAN_SORT_MODE);
    expect(toKanbanSortMode(undefined)).toBe(DEFAULT_KANBAN_SORT_MODE);
    expect(toKanbanSortMode(42)).toBe(DEFAULT_KANBAN_SORT_MODE);
  });
});

describe("equalizeKanbanColumnWidths", () => {
  it("sets every column to the clamped mean of the current widths", () => {
    // mean of [480, 240, 240, 240] = 300
    const result = equalizeKanbanColumnWidths([480, 240, 240, 240]);
    expect(result).toEqual([300, 300, 300, 300]);
  });

  it("never produces a width below the minimum", () => {
    const result = equalizeKanbanColumnWidths([10, 10, 10]);
    expect(result).toEqual([
      KANBAN_COLUMN_MIN_WIDTH,
      KANBAN_COLUMN_MIN_WIDTH,
      KANBAN_COLUMN_MIN_WIDTH,
    ]);
  });

  it("differs from reset when widths are uneven", () => {
    const equalized = equalizeKanbanColumnWidths([440, 200, 200, 200]);
    expect(equalized).not.toEqual(defaultKanbanColumnWidths());
    expect(new Set(equalized).size).toBe(1);
  });

  it("returns an empty array for no columns", () => {
    expect(equalizeKanbanColumnWidths([])).toEqual([]);
  });
});

describe("sortKanbanSessions", () => {
  const a = makeSession({
    id: "a",
    name: "Beta",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-03T00:00:00.000Z",
  });
  const b = makeSession({
    id: "b",
    name: "Alpha",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  });
  const c = makeSession({
    id: "c",
    name: "alpha",
    created_at: "2026-01-03T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  it("orders by most-recently-updated first", () => {
    expect(sortKanbanSessions([c, b, a], "updated-desc").map((s) => s.id)).toEqual(
      ["a", "b", "c"],
    );
  });

  it("orders by most-recently-created first", () => {
    expect(sortKanbanSessions([a, b, c], "created-desc").map((s) => s.id)).toEqual(
      ["c", "b", "a"],
    );
  });

  it("orders by name case-insensitively", () => {
    expect(sortKanbanSessions([a, b, c], "name-asc").map((s) => s.name)).toEqual([
      "Alpha",
      "alpha",
      "Beta",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [c, b, a];
    sortKanbanSessions(input, "name-asc");
    expect(input.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("treats unparseable timestamps as the epoch", () => {
    const bad = makeSession({ id: "bad", updated_at: "not-a-date" });
    const good = makeSession({
      id: "good",
      updated_at: "2026-01-05T00:00:00.000Z",
    });
    expect(
      sortKanbanSessions([bad, good], "updated-desc").map((s) => s.id),
    ).toEqual(["good", "bad"]);
  });
});

describe("sessionMatchesKanbanFilter", () => {
  const session = makeSession({
    id: "abc123",
    name: "Build Pipeline",
    branch: "feat/kanban",
    worktree_path: "/repos/acorn/worktrees/pipeline",
  });

  it("matches everything for an empty or whitespace query", () => {
    expect(sessionMatchesKanbanFilter(session, "")).toBe(true);
    expect(sessionMatchesKanbanFilter(session, "   ")).toBe(true);
  });

  it("matches the name case-insensitively", () => {
    expect(sessionMatchesKanbanFilter(session, "pipeline")).toBe(true);
    expect(sessionMatchesKanbanFilter(session, "BUILD")).toBe(true);
  });

  it("matches branch, id, and worktree basename", () => {
    expect(sessionMatchesKanbanFilter(session, "feat/kanban")).toBe(true);
    expect(sessionMatchesKanbanFilter(session, "abc123")).toBe(true);
    expect(sessionMatchesKanbanFilter(session, "worktrees")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(sessionMatchesKanbanFilter(session, "zzz")).toBe(false);
  });
});

describe("board prefs persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults for an unknown or null project", () => {
    expect(readKanbanBoardPrefs(null)).toEqual(defaultKanbanBoardPrefs());
    expect(readKanbanBoardPrefs("ghost")).toEqual(defaultKanbanBoardPrefs());
  });

  it("round-trips prefs for a project", () => {
    const prefs: KanbanBoardPrefs = {
      columnWidths: [300, 250, 200, 180],
      sortMode: "name-asc",
      filterQuery: "shell",
    };
    writeKanbanBoardPrefs("/repo/a", prefs);
    expect(readKanbanBoardPrefs("/repo/a")).toEqual(prefs);
  });

  it("does not write when the project id is null", () => {
    writeKanbanBoardPrefs(null, {
      columnWidths: [300, 300, 300, 300],
      sortMode: "name-asc",
      filterQuery: "x",
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("isolates prefs between projects", () => {
    writeKanbanBoardPrefs("/repo/a", {
      columnWidths: [300, 300, 300, 300],
      sortMode: "name-asc",
      filterQuery: "a-only",
    });
    writeKanbanBoardPrefs("/repo/b", {
      columnWidths: defaultKanbanColumnWidths(),
      sortMode: "created-desc",
      filterQuery: "b-only",
    });
    expect(readKanbanBoardPrefs("/repo/a").filterQuery).toBe("a-only");
    expect(readKanbanBoardPrefs("/repo/b").filterQuery).toBe("b-only");
    expect(readKanbanBoardPrefs("/repo/a").sortMode).toBe("name-asc");
  });

  it("clamps and fills missing column widths on read", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "/repo/a": { columnWidths: { idle: 10, running: 400 } },
      }),
    );
    const prefs = readKanbanBoardPrefs("/repo/a");
    // Legacy idle/running keys migrate to ready/working; the rest fall back.
    expect(prefs.columnWidths[0]).toBe(KANBAN_COLUMN_MIN_WIDTH);
    expect(prefs.columnWidths[2]).toBe(400);
    expect(prefs.columnWidths[1]).toBe(KANBAN_COLUMN_DEFAULT_WIDTH);
    expect(prefs.sortMode).toBe(DEFAULT_KANBAN_SORT_MODE);
    expect(prefs.filterQuery).toBe("");
  });

  it("falls back to defaults for corrupt stored JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readKanbanBoardPrefs("/repo/a")).toEqual(defaultKanbanBoardPrefs());
  });

  it("normalizes an invalid stored sort mode", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "/repo/a": { sortMode: "bogus" } }),
    );
    expect(readKanbanBoardPrefs("/repo/a").sortMode).toBe(
      DEFAULT_KANBAN_SORT_MODE,
    );
  });
});
