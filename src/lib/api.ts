import { invoke } from "@tauri-apps/api/core";
import type {
  CommitInfo,
  DiffPayload,
  MemoryUsage,
  Project,
  Session,
  SessionStatus,
  StagedFile,
  TodoItem,
} from "./types";

export const api = {
  listSessions(): Promise<Session[]> {
    return invoke<Session[]>("list_sessions");
  },
  createSession(
    name: string,
    repoPath: string,
    isolated = false,
  ): Promise<Session> {
    return invoke<Session>("create_session", { name, repoPath, isolated });
  },
  removeSession(id: string, removeWorktree = false): Promise<void> {
    return invoke<void>("remove_session", { id, removeWorktree });
  },
  setSessionStatus(id: string, status: SessionStatus): Promise<Session> {
    return invoke<Session>("set_session_status", { id, status });
  },
  renameSession(id: string, name: string): Promise<Session> {
    return invoke<Session>("rename_session", { id, name });
  },
  listProjects(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  },
  addProject(repoPath: string): Promise<Project> {
    return invoke<Project>("add_project", { repoPath });
  },
  removeProject(
    repoPath: string,
    removeSessions = true,
    removeWorktrees = false,
  ): Promise<void> {
    return invoke<void>("remove_project", {
      repoPath,
      removeSessions,
      removeWorktrees,
    });
  },
  reorderProjects(order: string[]): Promise<Project[]> {
    return invoke<Project[]>("reorder_projects", { order });
  },
  listCommits(repoPath: string, offset = 0, limit = 50): Promise<CommitInfo[]> {
    return invoke<CommitInfo[]>("list_commits", { repoPath, offset, limit });
  },
  listStaged(repoPath: string): Promise<StagedFile[]> {
    return invoke<StagedFile[]>("list_staged", { repoPath });
  },
  commitDiff(repoPath: string, sha: string): Promise<DiffPayload> {
    return invoke<DiffPayload>("commit_diff", { repoPath, sha });
  },
  commitWebUrl(repoPath: string, sha: string): Promise<string | null> {
    return invoke<string | null>("commit_web_url", { repoPath, sha });
  },
  claudeSessionExists(cwd: string, sessionId: string): Promise<boolean> {
    return invoke<boolean>("claude_session_exists", { cwd, sessionId });
  },
  openInEditor(command: string, args: string[], path: string): Promise<void> {
    return invoke<void>("open_in_editor", { command, args, path });
  },
  stagedDiff(repoPath: string): Promise<DiffPayload> {
    return invoke<DiffPayload>("staged_diff", { repoPath });
  },
  getMemoryUsage(): Promise<MemoryUsage> {
    return invoke<MemoryUsage>("get_memory_usage");
  },
  readSessionTodos(sessionId: string, cwd: string): Promise<TodoItem[]> {
    return invoke<TodoItem[]>("read_session_todos", { sessionId, cwd });
  },
  detectSessionStatuses(
    ids: string[],
  ): Promise<{ id: string; status: SessionStatus }[]> {
    return invoke<{ id: string; status: SessionStatus }[]>(
      "detect_session_statuses",
      { ids },
    );
  },
};
