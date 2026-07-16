import {
  defaultProjectFolderId,
  isDefaultProjectFolder,
  type ProjectFolderGroup,
  type ProjectFolderProjectGroup,
} from "./projectFolders";
import type { Session } from "./types";

export interface ProjectTopLevelSessionItem {
  id: string;
  type: "session";
  session: Session;
  folderId: string;
}

export interface ProjectTopLevelFolderItem {
  id: string;
  type: "folder";
  folderGroup: ProjectFolderGroup;
}

export type ProjectTopLevelItem =
  | ProjectTopLevelSessionItem
  | ProjectTopLevelFolderItem;

export function buildProjectTopLevelItems(
  project: ProjectFolderProjectGroup,
  order: readonly string[],
  prioritizeNeedsInputTabs = false,
): ProjectTopLevelItem[] {
  const defaultFolderGroup =
    project.folders.find((folderGroup) =>
      isDefaultProjectFolder(folderGroup.folder),
    ) ?? project.folders[0] ?? null;
  const directSessions: ProjectTopLevelItem[] = (
    defaultFolderGroup?.sessions ?? []
  ).map((session) => ({
    id: sidebarSessionItemId(session.id),
    type: "session",
    session,
    folderId:
      defaultFolderGroup?.folder.id ?? defaultProjectFolderId(project.repoPath),
  }));
  const folders: ProjectTopLevelItem[] = project.folders
    .filter((folderGroup) => !isDefaultProjectFolder(folderGroup.folder))
    .map((folderGroup) => ({
      id: sidebarFolderItemId(folderGroup.folder.id),
      type: "folder",
      folderGroup,
    }));
  return orderProjectTopLevelItems(
    [...directSessions, ...folders],
    order,
    prioritizeNeedsInputTabs,
  );
}

export function orderProjectTopLevelItems(
  items: readonly ProjectTopLevelItem[],
  order: readonly string[],
  prioritizeNeedsInputTabs = false,
): ProjectTopLevelItem[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ordered: ProjectTopLevelItem[] = [];
  for (const id of order) {
    const item = itemById.get(id);
    if (!item || seen.has(id)) continue;
    ordered.push(item);
    seen.add(id);
  }
  for (const item of items) {
    if (!seen.has(item.id)) ordered.push(item);
  }
  return prioritizeNeedsInputTabs ? orderItemsByPriority(ordered) : ordered;
}

export interface ProjectTopLevelDragPlan {
  nextOrder: string[];
  nextItems: ProjectTopLevelItem[];
}

/**
 * Resolve a sidebar drag into the manual order to persist.
 *
 * `prioritizeNeedsInputTabs` only changes how the list is displayed — the saved
 * order stays manual. So the drag has to be resolved against the displayed
 * list: the drop indices the user aimed at are positions in that list, and
 * scoring them against the unsorted order records the move in the wrong slot,
 * which the next render then sorts straight back to where it started.
 *
 * Returns null when the drag is a no-op or references an item that is not on
 * the project's top level.
 */
export function planProjectTopLevelDrag(
  project: ProjectFolderProjectGroup,
  order: readonly string[],
  prioritizeNeedsInputTabs: boolean,
  activeItemId: string,
  overItemId: string,
): ProjectTopLevelDragPlan | null {
  const items = buildProjectTopLevelItems(
    project,
    order,
    prioritizeNeedsInputTabs,
  );
  const fromIdx = items.findIndex((item) => item.id === activeItemId);
  const toIdx = items.findIndex((item) => item.id === overItemId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;
  const nextItems = [...items];
  const [moved] = nextItems.splice(fromIdx, 1);
  nextItems.splice(toIdx, 0, moved);
  return { nextOrder: nextItems.map((item) => item.id), nextItems };
}

/**
 * Map every draggable sidebar row id to the priority group it is displayed in:
 * true for rows the priority sort floats to the top, false for the rest.
 *
 * Ids that are not rows — the folder and project drop zones — are absent, so
 * callers can tell "different group" apart from "not a row at all".
 */
export function buildDragPriorityIndex(
  groups: readonly ProjectFolderProjectGroup[],
): Map<string, boolean> {
  const index = new Map<string, boolean>();
  for (const group of groups) {
    for (const folderGroup of group.folders) {
      index.set(
        sidebarFolderItemId(folderGroup.folder.id),
        folderGroup.sessions.some(hasPriorityStatus),
      );
      for (const session of folderGroup.sessions) {
        index.set(sidebarSessionItemId(session.id), hasPriorityStatus(session));
      }
    }
  }
  return index;
}

/**
 * Whether a row may be dropped onto another while the priority sort is on.
 *
 * The sort re-floats waiting and errored rows on every render, so a drop that
 * crosses the group boundary can never hold its slot — it snaps back the
 * instant it lands. Refusing the drop keeps the boundary honest instead.
 *
 * Ids missing from the index are drop zones rather than rows, and stay open.
 */
export function isSameDragPriorityGroup(
  index: ReadonlyMap<string, boolean>,
  activeId: string,
  overId: string,
): boolean {
  const active = index.get(activeId);
  const over = index.get(overId);
  if (active === undefined || over === undefined) return true;
  return active === over;
}

export function orderSessionsByPriority(
  sessions: readonly Session[],
  prioritizeNeedsInputTabs: boolean,
): Session[] {
  if (!prioritizeNeedsInputTabs) return [...sessions];
  return stablePartition(sessions, hasPriorityStatus);
}

function orderItemsByPriority(
  items: readonly ProjectTopLevelItem[],
): ProjectTopLevelItem[] {
  return stablePartition(items, itemHasPriorityStatus);
}

function itemHasPriorityStatus(item: ProjectTopLevelItem): boolean {
  if (item.type === "session") return hasPriorityStatus(item.session);
  return item.folderGroup.sessions.some(hasPriorityStatus);
}

function hasPriorityStatus(session: Session): boolean {
  return (
    session.status === "waiting_for_input" || session.status === "errored"
  );
}

function stablePartition<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T[] {
  const matching: T[] = [];
  const rest: T[] = [];
  for (const value of values) {
    if (predicate(value)) matching.push(value);
    else rest.push(value);
  }
  return [...matching, ...rest];
}

function sidebarFolderItemId(folderId: string): string {
  return `folder:${folderId}`;
}

function sidebarSessionItemId(sessionId: string): string {
  return `session:${sessionId}`;
}
