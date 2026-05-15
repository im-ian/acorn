export type WorkspaceTabId = string;
export type WorkspaceTabKind = "session" | "code";
export type WorkspaceTabLifecycle =
  | "ephemeral"
  | "restorable"
  | "process-backed";

interface WorkspaceTabBase<
  Kind extends WorkspaceTabKind,
  Lifecycle extends WorkspaceTabLifecycle,
> {
  id: WorkspaceTabId;
  kind: Kind;
  lifecycle: Lifecycle;
  title: string;
  repoPath: string;
}

export interface SessionWorkspaceTab
  extends WorkspaceTabBase<"session", "process-backed"> {
  sessionId: string;
}

export interface CodeWorkspaceTab
  extends WorkspaceTabBase<"code", "ephemeral" | "restorable"> {
  path: string;
}

export type WorkspaceTab = SessionWorkspaceTab | CodeWorkspaceTab;
export type FrontendWorkspaceTab = CodeWorkspaceTab;
export type RestorableWorkspaceTab = Extract<
  WorkspaceTab,
  { lifecycle: "restorable" }
>;
export type ProcessBackedWorkspaceTab = Extract<
  WorkspaceTab,
  { lifecycle: "process-backed" }
>;

export const CODE_VIEWER_TAB_PREFIX = "code-viewer:";
const LEGACY_VIEWER_TAB_PREFIX = "viewer:";

export function isWorkspaceTabId(id: string): boolean {
  return (
    id.startsWith(CODE_VIEWER_TAB_PREFIX) ||
    id.startsWith(LEGACY_VIEWER_TAB_PREFIX)
  );
}

export function isSessionTabId(id: string): boolean {
  return !isWorkspaceTabId(id);
}

export function activeSessionIdFromTabId(id: string | null): string | null {
  return id && isSessionTabId(id) ? id : null;
}

export function makeSessionWorkspaceTab(input: {
  id: string;
  title: string;
  repoPath: string;
}): SessionWorkspaceTab {
  return {
    id: input.id,
    kind: "session",
    lifecycle: "process-backed",
    sessionId: input.id,
    title: input.title,
    repoPath: input.repoPath,
  };
}

export function makeCodeWorkspaceTab(
  path: string,
  repoPath: string,
  lifecycle: CodeWorkspaceTab["lifecycle"] = "ephemeral",
): CodeWorkspaceTab {
  return {
    id: `${CODE_VIEWER_TAB_PREFIX}${crypto.randomUUID()}`,
    kind: "code",
    lifecycle,
    path,
    repoPath,
    title: basename(path),
  };
}

export function isRestorableWorkspaceTab(
  tab: WorkspaceTab,
): tab is RestorableWorkspaceTab {
  return tab.lifecycle === "restorable";
}

export function isProcessBackedWorkspaceTab(
  tab: WorkspaceTab,
): tab is ProcessBackedWorkspaceTab {
  return tab.lifecycle === "process-backed";
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
