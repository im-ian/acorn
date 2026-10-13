import { api } from "./api";
import type { Translator } from "./i18n";
import { basename, pathsEqual } from "./pathUtils";
import {
  findWorktreeWorkspaceForPath,
  isDefaultProjectFolder,
  resolveProjectFolderIdForSession,
  type ProjectFolder,
} from "./projectFolders";
import { hasRecordedWorktree } from "./sessionWorktree";
import type { Session } from "./types";
import { useAppStore } from "../store";

export function isWorktreeWorkspace(folder: ProjectFolder): boolean {
  return !pathsEqual(folder.cwdPath, folder.repoPath);
}

export function canAssignSessionToWorkspace(
  session: Session,
  currentFolder: ProjectFolder | null,
  targetFolder: ProjectFolder,
): boolean {
  if (
    currentFolder &&
    isWorktreeWorkspace(currentFolder) &&
    currentFolder.id !== targetFolder.id
  ) {
    return false;
  }
  if (
    isWorktreeWorkspace(targetFolder) &&
    !pathsEqual(session.worktree_path, targetFolder.cwdPath)
  ) {
    return false;
  }
  return true;
}

export function canCreateWorkspaceFromSessionWorktree(
  session: Session,
  projectFolders: readonly ProjectFolder[],
  currentProjectFolderId: string | undefined,
): boolean {
  if (!hasRecordedWorktree(session)) return false;
  if (pathsEqual(session.worktree_path, session.repo_path)) {
    return false;
  }
  const currentFolder = currentProjectFolderId
    ? projectFolders.find((folder) => folder.id === currentProjectFolderId)
    : null;
  if (currentFolder && !isDefaultProjectFolder(currentFolder)) {
    return false;
  }
  return !findWorktreeWorkspaceForPath(projectFolders, session.worktree_path);
}

/**
 * Click-time counterpart of `canCreateWorkspaceFromSessionWorktree`, which
 * only gates the context-menu item's *visibility* with a snapshot taken when
 * the menu opened. By the time the item is clicked, another click or session
 * may already have created a workspace for the same worktree, so eligibility
 * is re-resolved against fresh store state: an existing workspace pointing at
 * the same path is activated instead of duplicated, a worktree missing from
 * disk surfaces a toast, and any other stale snapshot silently no-ops.
 */
export async function createWorkspaceFromSessionWorktree(
  session: Session,
  showToast: (message: string) => void,
  t: Translator,
): Promise<ProjectFolder | null> {
  const worktreeOnDisk = await api
    .isPathLinkedWorktree(session.worktree_path)
    .catch((err: unknown) => {
      console.error("[sessionWorkspaces] worktree existence check failed", err);
      return false;
    });
  // Read state only after the IPC roundtrip above so validation and creation
  // run synchronously against the same snapshot, with no await in between.
  const state = useAppStore.getState();
  const folders = state.projectFolders[session.repo_path] ?? [];
  const existing = findWorktreeWorkspaceForPath(
    folders,
    session.worktree_path,
  );
  if (existing) {
    state.setActiveProjectFolder(existing.id);
    return existing;
  }
  const currentFolderId = resolveProjectFolderIdForSession(
    folders,
    session,
    state.sessionFolderIds,
  );
  if (
    !canCreateWorkspaceFromSessionWorktree(session, folders, currentFolderId)
  ) {
    return null;
  }
  if (!worktreeOnDisk) {
    showToast(t("toasts.session.worktreeMissing"));
    return null;
  }
  return state.createProjectFolder(
    session.repo_path,
    basename(session.worktree_path),
    session.worktree_path,
  );
}
