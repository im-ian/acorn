import {
  defaultProjectFolderId,
  isDefaultProjectFolder,
  makeDefaultProjectFolder,
  resolveProjectFolderIdForSession,
  sortProjectFolders,
  type ProjectFolder,
  type ProjectFoldersByRepo,
  type SessionFolderAssignments,
} from "./projectFolders";
import type { Session } from "./types";

export const IPC_LIST_WORKSPACES_REQUEST_EVENT =
  "acorn:ipc-list-workspaces-request";

export interface IpcListWorkspacesRequestPayload {
  request_id?: string;
  source_session_id?: string;
  repo_path?: string;
  source_workspace_path?: string;
}

export interface IpcWorkspaceSummary {
  id: string;
  name: string;
  repo_path: string;
  workspace_path: string;
  is_default: boolean;
  active: boolean;
  source: boolean;
  session_count: number;
}

export interface IpcListWorkspacesResponsePayload {
  request_id: string;
  workspaces: IpcWorkspaceSummary[];
  error?: string | null;
}

export interface IpcWorkspaceState {
  sessions: Session[];
  projectFolders: ProjectFoldersByRepo;
  sessionFolderIds: SessionFolderAssignments;
  activeProject: string | null;
  activeProjectFolderId: string | null;
}

export function parseIpcListWorkspacesRequestPayload(
  value: unknown,
): IpcListWorkspacesRequestPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    request_id:
      typeof raw.request_id === "string" ? raw.request_id : undefined,
    source_session_id:
      typeof raw.source_session_id === "string"
        ? raw.source_session_id
        : undefined,
    repo_path: typeof raw.repo_path === "string" ? raw.repo_path : undefined,
    source_workspace_path:
      typeof raw.source_workspace_path === "string"
        ? raw.source_workspace_path
        : undefined,
  };
}

export function buildIpcWorkspaceSummaries(
  state: IpcWorkspaceState,
  request: IpcListWorkspacesRequestPayload,
): IpcWorkspaceSummary[] {
  const repoPath = request.repo_path;
  if (!repoPath) return [];
  const folders = workspaceFoldersForRepo(state.projectFolders, repoPath);
  const sourceFolderId = sourceWorkspaceFolderId(state, folders, request);
  const activeFolderId =
    state.activeProject === repoPath
      ? (state.activeProjectFolderId ?? defaultProjectFolderId(repoPath))
      : null;
  const sessionCounts = workspaceSessionCounts(state.sessions, folders, state.sessionFolderIds);

  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    repo_path: folder.repoPath,
    workspace_path: folder.cwdPath,
    is_default: isDefaultProjectFolder(folder),
    active: folder.id === activeFolderId,
    source: folder.id === sourceFolderId,
    session_count: sessionCounts.get(folder.id) ?? 0,
  }));
}

function workspaceFoldersForRepo(
  foldersByRepo: ProjectFoldersByRepo,
  repoPath: string,
): ProjectFolder[] {
  const byId = new Map<string, ProjectFolder>();
  for (const folder of foldersByRepo[repoPath] ?? []) {
    if (folder.repoPath === repoPath) byId.set(folder.id, folder);
  }
  const defaultId = defaultProjectFolderId(repoPath);
  if (!byId.has(defaultId)) {
    byId.set(defaultId, makeDefaultProjectFolder(repoPath));
  }
  return sortProjectFolders(Array.from(byId.values()));
}

function sourceWorkspaceFolderId(
  state: IpcWorkspaceState,
  folders: readonly ProjectFolder[],
  request: IpcListWorkspacesRequestPayload,
): string | null {
  const repoPath = request.repo_path;
  if (!repoPath) return null;
  const sourceSession = request.source_session_id
    ? state.sessions.find(
        (session) =>
          session.id === request.source_session_id &&
          session.repo_path === repoPath,
      )
    : null;
  if (sourceSession) {
    return resolveProjectFolderIdForSession(
      folders,
      sourceSession,
      state.sessionFolderIds,
    );
  }
  const sourcePath = request.source_workspace_path;
  if (!sourcePath) return null;
  const exactWorktreeFolder = folders.find(
    (folder) => folder.cwdPath === sourcePath && folder.cwdPath !== folder.repoPath,
  );
  if (exactWorktreeFolder) return exactWorktreeFolder.id;
  return sourcePath === repoPath ? defaultProjectFolderId(repoPath) : null;
}

function workspaceSessionCounts(
  sessions: readonly Session[],
  folders: readonly ProjectFolder[],
  assignments: SessionFolderAssignments,
): Map<string, number> {
  const counts = new Map<string, number>();
  const repoPath = folders[0]?.repoPath;
  if (!repoPath) return counts;
  for (const session of sessions) {
    if (session.repo_path !== repoPath) continue;
    const folderId = resolveProjectFolderIdForSession(
      folders,
      session,
      assignments,
    );
    counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
  }
  return counts;
}
