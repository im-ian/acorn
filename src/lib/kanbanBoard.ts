import { basename } from "./pathUtils";
import type { Session, SessionStatus } from "./types";

export type KanbanSortMode = "updated-desc" | "created-desc" | "name-asc";

/**
 * Column order is the single source of truth for the kanban board. The board
 * component pairs each status with a UI tone; the pure board logic here only
 * needs the order and identity of each column.
 */
export const KANBAN_COLUMN_STATUSES: readonly SessionStatus[] = [
  "ready",
  "waiting_for_input",
  "working",
  "errored",
];

export const KANBAN_COLUMN_DEFAULT_WIDTH = 240;
export const KANBAN_COLUMN_MIN_WIDTH = 180;
export const DEFAULT_KANBAN_SORT_MODE: KanbanSortMode = "updated-desc";

const KANBAN_STATUS_STORAGE_KEYS: Record<SessionStatus, readonly string[]> = {
  ready: ["ready", "idle", "completed"],
  waiting_for_input: ["waiting_for_input", "needs_input"],
  working: ["working", "running"],
  errored: ["errored", "failed"],
};

const BOARD_PREFS_STORAGE_KEY = "acorn:workspace-kanban:board-prefs:v1";

/** Persisted, per-project board view state. */
export interface KanbanBoardPrefs {
  columnWidths: number[];
  sortMode: KanbanSortMode;
  filterQuery: string;
}

export function clampKanbanColumnWidth(width: number): number {
  return Math.max(KANBAN_COLUMN_MIN_WIDTH, Math.round(width));
}

export function defaultKanbanColumnWidths(): number[] {
  return KANBAN_COLUMN_STATUSES.map(() => KANBAN_COLUMN_DEFAULT_WIDTH);
}

export function defaultKanbanBoardPrefs(): KanbanBoardPrefs {
  return {
    columnWidths: defaultKanbanColumnWidths(),
    sortMode: DEFAULT_KANBAN_SORT_MODE,
    filterQuery: "",
  };
}

export function toKanbanSortMode(value: unknown): KanbanSortMode {
  if (
    value === "updated-desc" ||
    value === "created-desc" ||
    value === "name-asc"
  ) {
    return value;
  }
  return DEFAULT_KANBAN_SORT_MODE;
}

/**
 * Equalize sets every column to the mean of the current widths (clamped to the
 * minimum). This is deliberately distinct from reset, which restores the fixed
 * default width — so the two toolbar actions never collapse into the same
 * result.
 */
export function equalizeKanbanColumnWidths(
  widths: readonly number[],
): number[] {
  if (widths.length === 0) return [];
  const total = widths.reduce((sum, width) => sum + width, 0);
  const equalWidth = clampKanbanColumnWidth(total / widths.length);
  return widths.map(() => equalWidth);
}

function sessionTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareSessionName(a: Session, b: Session): number {
  return a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

export function sortKanbanSessions(
  sessions: readonly Session[],
  sortMode: KanbanSortMode,
): Session[] {
  return [...sessions].sort((a, b) => {
    switch (sortMode) {
      case "updated-desc":
        return (
          sessionTimestamp(b.updated_at) - sessionTimestamp(a.updated_at) ||
          compareSessionName(a, b)
        );
      case "created-desc":
        return (
          sessionTimestamp(b.created_at) - sessionTimestamp(a.created_at) ||
          compareSessionName(a, b)
        );
      case "name-asc":
        return compareSessionName(a, b);
    }
  });
}

export function sessionMatchesKanbanFilter(
  session: Session,
  filterQuery: string,
): boolean {
  const query = filterQuery.trim().toLowerCase();
  if (!query) return true;
  return [
    session.name,
    session.worktree_path,
    basename(session.worktree_path),
    session.branch,
    session.id,
  ].some((value) => value.toLowerCase().includes(query));
}

interface StoredBoardPrefs {
  columnWidths?: Partial<Record<SessionStatus, number>>;
  sortMode?: string;
  filterQuery?: string;
}

type StoredBoardPrefsMap = Record<string, StoredBoardPrefs>;

function readStoredMap(): StoredBoardPrefsMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BOARD_PREFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as StoredBoardPrefsMap;
  } catch {
    return {};
  }
}

function columnWidthsFromStored(
  stored: StoredBoardPrefs["columnWidths"],
): number[] {
  const fallback = defaultKanbanColumnWidths();
  if (!stored || typeof stored !== "object") return fallback;
  const byStatus = stored as Record<string, unknown>;
  return KANBAN_COLUMN_STATUSES.map((status, index) => {
    const value = KANBAN_STATUS_STORAGE_KEYS[status]
      .map((key) => byStatus[key])
      .find((candidate) => candidate !== undefined);
    return typeof value === "number" && Number.isFinite(value)
      ? clampKanbanColumnWidth(value)
      : (fallback[index] ?? KANBAN_COLUMN_DEFAULT_WIDTH);
  });
}

/**
 * Read the stored board prefs for a project. Returns defaults for an unknown or
 * absent project, or when persisted state is missing/corrupt. Column widths are
 * stored keyed by status so reordering columns never shuffles saved widths.
 */
export function readKanbanBoardPrefs(
  projectId: string | null,
): KanbanBoardPrefs {
  if (!projectId) return defaultKanbanBoardPrefs();
  const stored = readStoredMap()[projectId];
  if (!stored || typeof stored !== "object") return defaultKanbanBoardPrefs();
  return {
    columnWidths: columnWidthsFromStored(stored.columnWidths),
    sortMode: toKanbanSortMode(stored.sortMode),
    filterQuery:
      typeof stored.filterQuery === "string" ? stored.filterQuery : "",
  };
}

/**
 * Persist board prefs for a single project without disturbing other projects'
 * saved state. No-ops without a project id or a `window` (e.g. SSR/tests).
 */
export function writeKanbanBoardPrefs(
  projectId: string | null,
  prefs: KanbanBoardPrefs,
): void {
  if (!projectId || typeof window === "undefined") return;
  const byStatus: Partial<Record<SessionStatus, number>> = {};
  KANBAN_COLUMN_STATUSES.forEach((status, index) => {
    byStatus[status] = clampKanbanColumnWidth(
      prefs.columnWidths[index] ?? KANBAN_COLUMN_DEFAULT_WIDTH,
    );
  });
  try {
    const map = readStoredMap();
    map[projectId] = {
      columnWidths: byStatus,
      sortMode: toKanbanSortMode(prefs.sortMode),
      filterQuery: prefs.filterQuery,
    };
    window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore private-mode or quota failures; board controls still work without
    // persistence.
  }
}
