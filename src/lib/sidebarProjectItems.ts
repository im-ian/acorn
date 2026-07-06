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
