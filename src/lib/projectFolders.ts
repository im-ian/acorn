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

/**
 * Every repository root a project spans, primary first. Sessions still record
 * exactly one of these as their `repo_path`, so git operations stay anchored to
 * a real repo — the project is only the grouping drawn around them.
 */
export function projectRootPaths(project: Project): string[] {
  return [project.repo_path, ...(project.source_paths ?? [])];
}

/**
 * Map every project root — primary and extra source folders alike — to the
 * primary repo path of the project that owns it. Sidebar grouping and every
 * "is this a registered project?" check route through this so a session in a
 * source folder lands under its project instead of spawning a second one.
 */
export function buildProjectRootIndex(
  projects: readonly Project[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const project of projects) {
    for (const root of projectRootPaths(project)) {
      index.set(root, project.repo_path);
    }
  }
  return index;
}

export function resolveProjectRootPath(
  index: ReadonlyMap<string, string>,
  repoPath: string,
): string {
  return index.get(repoPath) ?? repoPath;
}

/** Whether the group's folders come from more than one repository root. */
export function projectGroupSpansMultipleRoots(
  group: ProjectFolderProjectGroup,
): boolean {
  const roots = new Set(group.folders.map((entry) => entry.folder.repoPath));
  return roots.size > 1;
}

/**
 * Whether a folder's sessions render flat under the project header. Only a
 * single-root project flattens. Once a project spans several roots every root
 * — the primary one included — draws its own workspace row: the row is where a
 * session or worktree is started in that repository, and each root keeps its
 * own view mode (panes/kanban/canvas) instead of borrowing a sibling's.
 */
export function isGroupDefaultFolder(
  group: ProjectFolderProjectGroup,
  folder: ProjectFolder,
): boolean {
  if (projectGroupSpansMultipleRoots(group)) return false;
  return isDefaultProjectFolder(folder);
}

/** Display name for a source folder's root workspace row. */
export function projectFolderDisplayName(folder: ProjectFolder): string {
  if (isDefaultProjectFolder(folder) && folder.name === DEFAULT_PROJECT_FOLDER_NAME) {
    return basenamePath(folder.repoPath);
  }
  return folder.name;
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

/**
 * Find the non-default workspace folder that already points at the given
 * worktree path, if any. Matching uses the same normalization as the
 * sidebar's worktree grouping (`isMatchingWorktreeFolder`), so callers can
 * use this as a duplicate guard before creating a workspace for a worktree.
 */
export function findWorktreeWorkspaceForPath(
  folders: readonly ProjectFolder[],
  worktreePath: string,
): ProjectFolder | null {
  return (
    folders.find(
      (folder) =>
        isWorktreeFolder(folder) &&
        normalizePath(folder.cwdPath) === normalizePath(worktreePath),
    ) ?? null
  );
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
  const knownRepos = knownWorkspaceRepos(projects, sessions, foldersByRepo);
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
  const rootIndex = buildProjectRootIndex(projects);
  const projectSessions = sessions.filter(isProjectSession);
  const projectSessionPaths = new Set(
    projectSessions.map((session) => session.repo_path),
  );
  const localSessionPaths = new Set(
    sessions.filter(isLocalSession).map((session) => session.repo_path),
  );

  for (const project of projects) {
    const roots = projectRootPaths(project);
    if (
      !roots.some((root) => projectSessionPaths.has(root)) &&
      roots.some((root) => localSessionPaths.has(root))
    ) {
      continue;
    }
    map.set(project.repo_path, {
      repoPath: project.repo_path,
      name: project.name,
      folders: folderGroupsForRoots(roots, foldersByRepo),
      sessions: [],
    });
  }

  for (const session of projectSessions) {
    const groupRepoPath = resolveProjectRootPath(rootIndex, session.repo_path);
    let group = map.get(groupRepoPath);
    if (!group) {
      group = {
        repoPath: groupRepoPath,
        name: basenamePath(groupRepoPath),
        folders: folderGroupsForRoots([groupRepoPath], foldersByRepo),
        sessions: [],
      };
      map.set(groupRepoPath, group);
    }
    if (group.folders.length === 0) {
      group.folders = folderGroupsForRepo([
        makeDefaultProjectFolder(session.repo_path),
      ]);
    }
    const folderId = resolveProjectFolderIdForSession(
      group.folders
        .map((folderGroup) => folderGroup.folder)
        .filter((folder) => folder.repoPath === session.repo_path),
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

export function buildLocalSessionFolderGroups(
  projects: Project[],
  sessions: Session[],
  foldersByRepo: ProjectFoldersByRepo,
  assignments: SessionFolderAssignments = {},
): ProjectFolderProjectGroup[] {
  const projectRepoPaths = new Set(projects.flatMap(projectRootPaths));
  for (const session of sessions) {
    if (isProjectSession(session)) projectRepoPaths.add(session.repo_path);
  }

  const localSessions = sessions.filter(isLocalSession);
  const localSessionPaths = new Set(
    localSessions.map((session) => session.repo_path),
  );
  const repoPaths = new Set(localSessionPaths);
  for (const [repoPath, folders] of Object.entries(foldersByRepo)) {
    if (projectRepoPaths.has(repoPath)) continue;
    if (folders.some((folder) => !isDefaultProjectFolder(folder))) {
      repoPaths.add(repoPath);
    }
  }

  return Array.from(repoPaths)
    .sort((a, b) => basenamePath(a).localeCompare(basenamePath(b)))
    .map((repoPath) => {
      const folders = sortProjectFolders(
        foldersByRepo[repoPath] ?? [makeDefaultProjectFolder(repoPath)],
      );
      const group: ProjectFolderProjectGroup = {
        repoPath,
        name: basenamePath(repoPath),
        folders: folderGroupsForRepo(folders),
        sessions: [],
      };
      for (const session of localSessions) {
        if (session.repo_path !== repoPath) continue;
        const folderId = resolveProjectFolderIdForSession(
          folders,
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
      group.sessions = sortSessions(group.sessions);
      group.folders = group.folders.map((folderGroup) => ({
        ...folderGroup,
        sessions: sortSessions(folderGroup.sessions),
      }));
      return group;
    });
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

/**
 * Flatten a project's roots into one workspace list: the primary root's
 * folders first, then each source root's workspaces in the order the roots
 * were added. Rendering decides whether the single-root default is flattened.
 */
function folderGroupsForRoots(
  roots: readonly string[],
  foldersByRepo: ProjectFoldersByRepo,
): ProjectFolderGroup[] {
  return roots.flatMap((root) =>
    folderGroupsForRepo(
      foldersByRepo[root] ?? (roots.length > 1 ? [makeDefaultProjectFolder(root)] : []),
    ),
  );
}

function knownWorkspaceRepos(
  projects: Project[],
  sessions: Session[],
  foldersByRepo: ProjectFoldersByRepo,
): string[] {
  const repos = new Map<string, number>();
  for (const project of projects) {
    // Source folders get a workspace entry of their own so they show up in the
    // sidebar before anything has been opened inside them.
    for (const root of projectRootPaths(project)) {
      repos.set(root, project.position ?? Number.MAX_SAFE_INTEGER);
    }
  }
  for (const session of sessions) {
    if (!repos.has(session.repo_path)) {
      repos.set(session.repo_path, Number.MAX_SAFE_INTEGER);
    }
  }
  for (const [repoPath, folders] of Object.entries(foldersByRepo)) {
    if (repos.has(repoPath)) continue;
    if (folders.some((folder) => !isDefaultProjectFolder(folder))) {
      repos.set(repoPath, Number.MAX_SAFE_INTEGER);
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
