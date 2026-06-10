import type { Project, Session } from "./types";

export const DEFAULT_PROJECT_FOLDER_NAME = "Default";

export interface ProjectFolder {
  id: string;
  repoPath: string;
  name: string;
  cwdPath: string;
  position: number;
}

export interface ProjectFolderGroup {
  folder: ProjectFolder;
  sessions: Session[];
}

export interface ProjectFolderProjectGroup {
  repoPath: string;
  name: string;
  folders: ProjectFolderGroup[];
  sessions: Session[];
}

export type ProjectFoldersByRepo = Record<string, ProjectFolder[]>;
export type SessionFolderAssignments = Record<string, string>;

export function defaultProjectFolderId(repoPath: string): string {
  return repoPath;
}

export function makeDefaultProjectFolder(
  repoPath: string,
): ProjectFolder {
  return {
    id: defaultProjectFolderId(repoPath),
    repoPath,
    name: DEFAULT_PROJECT_FOLDER_NAME,
    cwdPath: repoPath,
    position: 0,
  };
}

export function isDefaultProjectFolder(folder: ProjectFolder): boolean {
  return folder.id === defaultProjectFolderId(folder.repoPath);
}

export function findProjectFolderById(
  foldersByRepo: ProjectFoldersByRepo,
  folderId: string | null | undefined,
): ProjectFolder | null {
  if (!folderId) return null;
  for (const folders of Object.values(foldersByRepo)) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (folder) return folder;
  }
  return null;
}

export function makeProjectFolderId(repoPath: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `project-folder:${repoPath}:${suffix}`;
}

export function basenamePath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function isPathInsideOrEqual(path: string, parentPath: string): boolean {
  const child = normalizePath(path);
  const parent = normalizePath(parentPath);
  return child === parent || child.startsWith(`${parent}/`);
}

export function ensureProjectFolders(
  projects: Project[],
  sessions: Session[],
  foldersByRepo: ProjectFoldersByRepo,
): ProjectFoldersByRepo {
  const knownRepos = knownProjectRepos(projects, sessions);
  const next: ProjectFoldersByRepo = {};
  for (const repoPath of knownRepos) {
    const existing = foldersByRepo[repoPath] ?? [];
    const seen = new Set<string>();
    const folders: ProjectFolder[] = [];
    for (const folder of existing) {
      const normalized = normalizeProjectFolder(folder, repoPath);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      folders.push(normalized);
    }
    if (!seen.has(defaultProjectFolderId(repoPath))) {
      folders.push(makeDefaultProjectFolder(repoPath));
    }
    next[repoPath] = sortProjectFolders(folders);
  }
  return next;
}

export function buildProjectFolderGroups(
  projects: Project[],
  sessions: Session[],
  foldersByRepo: ProjectFoldersByRepo,
  assignments: SessionFolderAssignments = {},
): ProjectFolderProjectGroup[] {
  const map = new Map<string, ProjectFolderProjectGroup>();
  const projectSessions = sessions.filter(isProjectSession);
  const projectSessionPaths = new Set(
    projectSessions.map((session) => session.repo_path),
  );
  const localSessionPaths = new Set(
    sessions.filter(isLocalSession).map((session) => session.repo_path),
  );

  for (const project of projects) {
    if (
      !projectSessionPaths.has(project.repo_path) &&
      localSessionPaths.has(project.repo_path)
    ) {
      continue;
    }
    map.set(project.repo_path, {
      repoPath: project.repo_path,
      name: project.name,
      folders: folderGroupsForRepo(foldersByRepo[project.repo_path] ?? []),
      sessions: [],
    });
  }

  for (const session of projectSessions) {
    let group = map.get(session.repo_path);
    if (!group) {
      group = {
        repoPath: session.repo_path,
        name: basenamePath(session.repo_path),
        folders: folderGroupsForRepo(foldersByRepo[session.repo_path] ?? []),
        sessions: [],
      };
      map.set(session.repo_path, group);
    }
    if (group.folders.length === 0) {
      group.folders = folderGroupsForRepo([
        makeDefaultProjectFolder(session.repo_path),
      ]);
    }
    const folderId = resolveProjectFolderIdForSession(
      group.folders.map((folderGroup) => folderGroup.folder),
      session,
      assignments,
    );
    const folderGroup =
      group.folders.find((candidate) => candidate.folder.id === folderId) ??
      group.folders[0];
    if (!folderGroup) continue;
    folderGroup.sessions.push(session);
    group.sessions.push(session);
  }

  for (const group of map.values()) {
    group.sessions = sortSessions(group.sessions);
    group.folders = group.folders.map((folderGroup) => ({
      ...folderGroup,
      sessions: sortSessions(folderGroup.sessions),
    }));
  }

  return Array.from(map.values());
}

export function resolveProjectFolderIdForSession(
  folders: readonly ProjectFolder[],
  session: Session,
  assignments: SessionFolderAssignments = {},
): string {
  const matchingWorktreeFolder = folders.find((folder) =>
    isMatchingWorktreeFolder(folder, session),
  );
  const assigned = assignments[session.id];
  const assignedFolder = assigned
    ? folders.find(
        (folder) =>
          folder.id === assigned && folder.repoPath === session.repo_path,
      )
    : undefined;
  if (assignedFolder) {
    if (matchingWorktreeFolder) return matchingWorktreeFolder.id;
    if (!isWorktreeFolder(assignedFolder)) return assignedFolder.id;
  }
  if (matchingWorktreeFolder) return matchingWorktreeFolder.id;

  const defaultFolder =
    folders.find(isDefaultProjectFolder) ?? folders[0] ?? null;
  return defaultFolder?.id ?? session.repo_path;
}

export function pruneSessionFolderAssignments(
  assignments: SessionFolderAssignments,
  sessions: readonly Session[],
  foldersByRepo: ProjectFoldersByRepo,
): SessionFolderAssignments {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const folderRepoById = new Map<string, string>();
  for (const folders of Object.values(foldersByRepo)) {
    for (const folder of folders) folderRepoById.set(folder.id, folder.repoPath);
  }
  const next: SessionFolderAssignments = {};
  for (const [sessionId, folderId] of Object.entries(assignments)) {
    const session = sessionById.get(sessionId);
    const sessionRepo = session?.repo_path;
    const folderRepo = folderRepoById.get(folderId);
    const folders = sessionRepo ? (foldersByRepo[sessionRepo] ?? []) : [];
    if (
      session &&
      sessionRepo &&
      folderRepo &&
      sessionRepo === folderRepo &&
      resolveProjectFolderIdForSession(folders, session, {
        [sessionId]: folderId,
      }) === folderId
    ) {
      next[sessionId] = folderId;
    }
  }
  return next;
}

export function sortProjectFolders(
  folders: readonly ProjectFolder[],
): ProjectFolder[] {
  return [...folders].sort((a, b) => {
    if (isDefaultProjectFolder(a) && !isDefaultProjectFolder(b)) return -1;
    if (!isDefaultProjectFolder(a) && isDefaultProjectFolder(b)) return 1;
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name);
  });
}

function normalizeProjectFolder(
  folder: Partial<ProjectFolder>,
  repoPath: string,
): ProjectFolder | null {
  if (typeof folder.id !== "string" || folder.id.trim().length === 0) {
    return null;
  }
  const cwdPath =
    typeof folder.cwdPath === "string" && folder.cwdPath.trim().length > 0
      ? folder.cwdPath
      : repoPath;
  return {
    id: folder.id,
    repoPath,
    name:
      typeof folder.name === "string" && folder.name.trim().length > 0
        ? folder.name.trim()
        : basenamePath(cwdPath),
    cwdPath,
    position:
      typeof folder.position === "number" && Number.isFinite(folder.position)
        ? folder.position
        : isDefaultProjectFolder({ ...folder, repoPath } as ProjectFolder)
          ? 0
          : Number.MAX_SAFE_INTEGER,
  };
}

function isWorktreeFolder(folder: ProjectFolder): boolean {
  return (
    !isDefaultProjectFolder(folder) &&
    normalizePath(folder.cwdPath) !== normalizePath(folder.repoPath)
  );
}

function isMatchingWorktreeFolder(
  folder: ProjectFolder,
  session: Session,
): boolean {
  return (
    isWorktreeFolder(folder) &&
    normalizePath(folder.cwdPath) === normalizePath(session.worktree_path)
  );
}

function folderGroupsForRepo(
  folders: readonly ProjectFolder[],
): ProjectFolderGroup[] {
  return sortProjectFolders(folders).map((folder) => ({
    folder,
    sessions: [],
  }));
}

function knownProjectRepos(projects: Project[], sessions: Session[]): string[] {
  const repos = new Map<string, number>();
  for (const project of projects) {
    repos.set(project.repo_path, project.position ?? Number.MAX_SAFE_INTEGER);
  }
  for (const session of sessions) {
    if (!isProjectSession(session)) continue;
    if (!repos.has(session.repo_path)) {
      repos.set(session.repo_path, Number.MAX_SAFE_INTEGER);
    }
  }
  return Array.from(repos.entries())
    .sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      return basenamePath(a[0]).localeCompare(basenamePath(b[0]));
    })
    .map(([repoPath]) => repoPath);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.length > 0 ? normalized : "/";
}


function isProjectSession(session: Session): boolean {
  return session.project_scoped !== false;
}

function isLocalSession(session: Session): boolean {
  return session.project_scoped === false;
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const ap = a.position ?? Number.POSITIVE_INFINITY;
    const bp = b.position ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    const createdDelta =
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdDelta !== 0) return createdDelta;
    return a.id.localeCompare(b.id);
  });
}
