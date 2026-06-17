import { suggestLocalSessionName, suggestSessionName } from "./sessionName";
import type {
  Project,
  Session,
  SessionAgentProvider,
  SessionKind,
  SessionMode,
} from "./types";

export interface SessionCreationContext {
  sessions: Session[];
  projects: Project[];
  activeSessionId?: string | null;
  activeWorkspaceRepoPath?: string | null;
  activeWorkspaceCwdPath?: string | null;
  activeProjectFolderId?: string | null;
}

export interface SessionCreatePlacement {
  repoPath: string;
  projectScoped: boolean;
  projectFolderId?: string;
}

export type SessionLaunchCwd =
  | { kind: "projectRoot" }
  | { kind: "workspaceCwd"; cwdPath: string };

export interface SessionCreateScope {
  placement: SessionCreatePlacement;
  launch: SessionLaunchCwd;
}

export interface SessionCreateRequest {
  name: string;
  repoPath: string;
  cwdPath: string;
  isolated: boolean;
  kind: SessionKind;
  agentProvider: SessionAgentProvider | null;
  projectScoped: boolean;
  mode: SessionMode;
  projectFolderId?: string;
}

export interface BuildSessionCreateOptions {
  repoPath: string;
  launch?: SessionLaunchCwd;
  isolated?: boolean;
  kind?: SessionKind;
  agentProvider?: SessionAgentProvider | null;
  projectScoped?: boolean;
  mode?: SessionMode;
  name?: string;
  projectFolderId?: string;
}

function projectRootLaunch(): SessionLaunchCwd {
  return { kind: "projectRoot" };
}

function workspaceLaunch(cwdPath: string): SessionLaunchCwd {
  return { kind: "workspaceCwd", cwdPath };
}

function cwdPathForLaunch(repoPath: string, launch: SessionLaunchCwd): string {
  return launch.kind === "workspaceCwd" ? launch.cwdPath : repoPath;
}

export function scopeWithProjectRootLaunch(
  scope: SessionCreateScope,
): SessionCreateScope {
  return {
    placement: scope.placement,
    launch: projectRootLaunch(),
  };
}

export function scopeForSession(session: Session): SessionCreateScope {
  return {
    placement: {
      repoPath: session.repo_path,
      projectScoped: session.project_scoped !== false,
    },
    launch: workspaceLaunch(session.worktree_path),
  };
}

export function resolveActiveSessionScope(
  context: SessionCreationContext,
): SessionCreateScope | null {
  const active = context.activeSessionId
    ? context.sessions.find((session) => session.id === context.activeSessionId)
    : null;
  if (active) {
    const scope = scopeForSession(active);
    if (
      context.activeProjectFolderId &&
      context.activeWorkspaceRepoPath === active.repo_path
    ) {
      const projectFolderId =
        context.activeProjectFolderId !== active.repo_path
          ? context.activeProjectFolderId
          : undefined;
      return {
        placement: {
          ...scope.placement,
          ...(projectFolderId ? { projectFolderId } : {}),
        },
        launch: workspaceLaunch(
          context.activeWorkspaceCwdPath ??
            cwdPathForLaunch(active.repo_path, scope.launch),
        ),
      };
    }
    return scope;
  }
  if (!context.activeWorkspaceRepoPath) return null;
  return {
    placement: {
      repoPath: context.activeWorkspaceRepoPath,
      projectScoped: resolveProjectScopedForRepoPath(
        context,
        context.activeWorkspaceRepoPath,
      ),
      projectFolderId: context.activeProjectFolderId ?? undefined,
    },
    launch: workspaceLaunch(
      context.activeWorkspaceCwdPath ?? context.activeWorkspaceRepoPath,
    ),
  };
}

export function resolveProjectScopedForRepoPath(
  context: Pick<SessionCreationContext, "sessions" | "projects">,
  repoPath: string,
): boolean {
  const hasLocalSessions = context.sessions.some(
    (session) =>
      session.repo_path === repoPath && session.project_scoped === false,
  );
  const hasProjectSessions = context.sessions.some(
    (session) =>
      session.repo_path === repoPath && session.project_scoped !== false,
  );
  if (hasLocalSessions && !hasProjectSessions) return false;
  return true;
}

export function buildSessionCreateRequest(
  context: Pick<SessionCreationContext, "sessions" | "projects">,
  options: BuildSessionCreateOptions,
): SessionCreateRequest {
  const isolated = options.isolated ?? false;
  const kind = options.kind ?? "regular";
  const projectScoped =
    options.projectScoped ??
    resolveProjectScopedForRepoPath(context, options.repoPath);
  const launch = isolated
    ? projectRootLaunch()
    : (options.launch ?? projectRootLaunch());
  const cwdPath = cwdPathForLaunch(options.repoPath, launch);
  const name =
    options.name ??
    (projectScoped
      ? suggestSessionName(options.repoPath, context.sessions, kind, isolated)
      : suggestLocalSessionName(context.sessions));

  return {
    name,
    repoPath: options.repoPath,
    cwdPath,
    isolated,
    kind,
    agentProvider: options.agentProvider ?? null,
    projectScoped,
    mode: options.mode ?? "terminal",
    ...(options.projectFolderId
      ? { projectFolderId: options.projectFolderId }
      : {}),
  };
}

export function buildLocalSessionCreateRequest(
  context: Pick<SessionCreationContext, "sessions" | "projects">,
  repoPath: string,
): SessionCreateRequest {
  return buildSessionCreateRequest(context, {
    repoPath,
    projectScoped: false,
  });
}

export function buildSessionCreateRequestFromScope(
  context: Pick<SessionCreationContext, "sessions" | "projects">,
  scope: SessionCreateScope,
  options: Omit<BuildSessionCreateOptions, "repoPath" | "projectScoped"> = {},
): SessionCreateRequest {
  return buildSessionCreateRequest(context, {
    ...options,
    repoPath: scope.placement.repoPath,
    launch: options.launch ?? scope.launch,
    projectScoped: scope.placement.projectScoped,
    projectFolderId: options.projectFolderId ?? scope.placement.projectFolderId,
  });
}

export function applySessionCreateRequest(
  createSession: (
    name: string,
    repoPath: string,
    isolated?: boolean,
    kind?: SessionKind,
    agentProvider?: SessionAgentProvider | null,
    projectScoped?: boolean,
    mode?: SessionMode,
    projectFolderId?: string,
    cwdPath?: string,
  ) => Promise<Session | null>,
  request: SessionCreateRequest,
): Promise<Session | null> {
  const cwdPath =
    request.cwdPath === request.repoPath ? undefined : request.cwdPath;
  if (request.mode !== "terminal") {
    return createSession(
      request.name,
      request.repoPath,
      request.isolated,
      request.kind,
      request.agentProvider,
      request.projectScoped,
      request.mode,
      request.projectFolderId,
      cwdPath,
    );
  }
  return createSession(
    request.name,
    request.repoPath,
    request.isolated,
    request.kind,
    request.agentProvider,
    request.projectScoped,
    undefined,
    request.projectFolderId,
    cwdPath,
  );
}
