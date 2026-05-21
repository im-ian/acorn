import { suggestLocalSessionName, suggestSessionName } from "./sessionName";
import type {
  Project,
  Session,
  SessionAgentProvider,
  SessionKind,
} from "./types";

export interface SessionCreationContext {
  sessions: Session[];
  projects: Project[];
  activeSessionId?: string | null;
  activeWorkspaceRepoPath?: string | null;
}

export interface SessionCreateScope {
  repoPath: string;
  projectScoped: boolean;
}

export interface SessionCreateRequest {
  name: string;
  repoPath: string;
  isolated: boolean;
  kind: SessionKind;
  agentProvider: SessionAgentProvider | null;
  projectScoped: boolean;
}

export interface BuildSessionCreateOptions {
  repoPath: string;
  isolated?: boolean;
  kind?: SessionKind;
  agentProvider?: SessionAgentProvider | null;
  projectScoped?: boolean;
  name?: string;
}

export function scopeForSession(session: Session): SessionCreateScope {
  return {
    repoPath: session.repo_path,
    projectScoped: session.project_scoped !== false,
  };
}

export function resolveActiveSessionScope(
  context: SessionCreationContext,
): SessionCreateScope | null {
  const active = context.activeSessionId
    ? context.sessions.find((session) => session.id === context.activeSessionId)
    : null;
  if (active) return scopeForSession(active);
  if (!context.activeWorkspaceRepoPath) return null;
  return {
    repoPath: context.activeWorkspaceRepoPath,
    projectScoped: resolveProjectScopedForRepoPath(
      context,
      context.activeWorkspaceRepoPath,
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
  const name =
    options.name ??
    (projectScoped
      ? suggestSessionName(options.repoPath, context.sessions, kind, isolated)
      : suggestLocalSessionName(context.sessions));

  return {
    name,
    repoPath: options.repoPath,
    isolated,
    kind,
    agentProvider: options.agentProvider ?? null,
    projectScoped,
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
    repoPath: scope.repoPath,
    projectScoped: scope.projectScoped,
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
  ) => Promise<Session | null>,
  request: SessionCreateRequest,
): Promise<Session | null> {
  return createSession(
    request.name,
    request.repoPath,
    request.isolated,
    request.kind,
    request.agentProvider,
    request.projectScoped,
  );
}
