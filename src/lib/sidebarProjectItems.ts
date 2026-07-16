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
 * The move is scored against the saved order, never the order on screen: with
 * `prioritizeNeedsInputTabs` on those differ, and rewriting the saved order to
 * match the screen would bake a snapshot of today's waiting tabs into the
 * manual order the setting promises to keep intact.
 *
 * Scoring against the saved order is safe because drags are confined to a
 * single priority group (see [[isPriorityDropAllowed]]): the priority sort is
 * a stable partition, so moving a row among its own kind changes only that
 * group's internal order — which lands identically whether the move is scored
 * on screen or in the saved order.
 *
 * Returns null when the drag is a no-op or references an item that is not on
 * the project's top level.
 */
export function planProjectTopLevelDrag(
  project: ProjectFolderProjectGroup,
  order: readonly string[],
  activeItemId: string,
  overItemId: string,
): ProjectTopLevelDragPlan | null {
  const items = buildProjectTopLevelItems(project, order);
  const fromIdx = items.findIndex((item) => item.id === activeItemId);
  const toIdx = items.findIndex((item) => item.id === overItemId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;
  const nextItems = [...items];
  const [moved] = nextItems.splice(fromIdx, 1);
  nextItems.splice(toIdx, 0, moved);
  return { nextOrder: nextItems.map((item) => item.id), nextItems };
}

/**
 * Map every draggable sidebar row id to its priority group and reorder
 * container. The container distinguishes reordering inside one sorted list
 * from moving a session between workspaces.
 *
 * Pass only groups whose rows are actually displayed with the priority sort
 * applied. An unindexed id is read as "unconstrained" rather than "other
 * group", so rows that are displayed in their saved order keep every drop slot.
 *
 * Ids that are not rows — the folder and project drop zones — are absent for
 * the same reason: dropping onto them moves a session between workspaces
 * instead of reordering it, which the priority sort has no say over.
 */
export interface DragPriorityPlacement {
  containerId: string;
  isPrioritized: boolean;
}

export function buildDragPriorityIndex(
  groups: readonly ProjectFolderProjectGroup[],
): Map<string, DragPriorityPlacement> {
  const index = new Map<string, DragPriorityPlacement>();
  for (const group of groups) {
    const topLevelContainerId = `project:${group.repoPath}`;
    for (const folderGroup of group.folders) {
      const isDefaultFolder = isDefaultProjectFolder(folderGroup.folder);
      // The default folder is flattened into top-level session rows and never
      // drawn as a folder row, so it has no drag id to index.
      if (!isDefaultFolder) {
        index.set(sidebarFolderItemId(folderGroup.folder.id), {
          containerId: topLevelContainerId,
          isPrioritized: folderGroupHasPriorityStatus(folderGroup),
        });
      }
      const sessionContainerId = isDefaultFolder
        ? topLevelContainerId
        : `folder:${folderGroup.folder.id}`;
      for (const session of folderGroup.sessions) {
        index.set(sidebarSessionItemId(session.id), {
          containerId: sessionContainerId,
          isPrioritized: hasPriorityStatus(session),
        });
      }
    }
  }
  return index;
}

/**
 * Whether a row may be dropped onto another while the priority sort is on.
 *
 * The sort re-floats waiting and errored rows on every render, so a drop that
 * crosses the group boundary inside one container can never hold its slot — it
 * snaps back the instant it lands. Across containers, the workspace move still
 * has meaning and the destination sort decides the row's final position.
 *
 * Ids missing from the index are drop zones rather than rows, and stay open.
 */
export function isPriorityDropAllowed(
  index: ReadonlyMap<string, DragPriorityPlacement>,
  activeId: string,
  overId: string,
): boolean {
  const active = index.get(activeId);
  const over = index.get(overId);
  if (active === undefined || over === undefined) return true;
  return (
    active.containerId !== over.containerId ||
    active.isPrioritized === over.isPrioritized
  );
}

/**
 * Drop a drag that landed on a row in the other priority group of the same
 * reorder container.
 *
 * Takes ranked collisions and returns them untouched, or nothing at all. It
 * deliberately does not withhold the offending row from the ranking: a withheld
 * candidate leaves no hole, it hands the slot to whatever ranked next — for a
 * session row typically a neighbouring folder's drop zone, which would file the
 * session away into a folder the user never pointed at.
 *
 * Call only while the priority sort is on; with the sort off every row keeps
 * the slot it is dropped in and there is nothing to refuse.
 */
export function refuseCrossPriorityGroupDrop<T extends { id: string | number }>(
  index: ReadonlyMap<string, DragPriorityPlacement>,
  activeId: string,
  collisions: T[],
): T[] {
  const target = collisions[0];
  if (!target) return collisions;
  return isPriorityDropAllowed(index, activeId, String(target.id))
    ? collisions
    : [];
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
  return folderGroupHasPriorityStatus(item.folderGroup);
}

/** A folder joins the priority group as soon as one session inside it does. */
function folderGroupHasPriorityStatus(folderGroup: ProjectFolderGroup): boolean {
  return folderGroup.sessions.some(hasPriorityStatus);
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
