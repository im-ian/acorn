import type { WorkSummaryTokenBaseline } from "./workSummary";

export type WorkspaceTabId = string;
export type WorkspaceTabKind = "session" | "code" | "work-summary";
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
  target?: CodeWorkspaceTabTarget;
}

export interface WorkSummaryWorkspaceTab
  extends WorkspaceTabBase<"work-summary", "ephemeral"> {
  cwdPath: string;
  sessionId?: string;
  tokenBaseline?: WorkSummaryTokenBaseline;
}

export interface CodeWorkspaceTabTarget {
  line: number;
  column?: number;
  token: string;
}

export type WorkspaceTab =
  | SessionWorkspaceTab
  | CodeWorkspaceTab
  | WorkSummaryWorkspaceTab;
export type FrontendWorkspaceTab = CodeWorkspaceTab | WorkSummaryWorkspaceTab;
export type RestorableWorkspaceTab = Extract<
  WorkspaceTab,
  { lifecycle: "restorable" }
>;
export type ProcessBackedWorkspaceTab = Extract<
  WorkspaceTab,
  { lifecycle: "process-backed" }
>;

export const CODE_VIEWER_TAB_PREFIX = "code-viewer:";
export const WORK_SUMMARY_TAB_PREFIX = "work-summary:";
const LEGACY_VIEWER_TAB_PREFIX = "viewer:";

export function isWorkspaceTabId(id: string): boolean {
  return (
    id.startsWith(CODE_VIEWER_TAB_PREFIX) ||
    id.startsWith(WORK_SUMMARY_TAB_PREFIX) ||
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
  target?: Omit<CodeWorkspaceTabTarget, "token">,
): CodeWorkspaceTab {
  return {
    id: `${CODE_VIEWER_TAB_PREFIX}${crypto.randomUUID()}`,
    kind: "code",
    lifecycle,
    path,
    repoPath,
    title: basename(path),
    ...(target ? { target: makeCodeWorkspaceTabTarget(target) } : {}),
  };
}

export function makeCodeWorkspaceTabTarget(
  target: Omit<CodeWorkspaceTabTarget, "token">,
): CodeWorkspaceTabTarget {
  return {
    line: target.line,
    ...(target.column === undefined ? {} : { column: target.column }),
    token: crypto.randomUUID(),
  };
}

export function makeWorkSummaryWorkspaceTab(input: {
  repoPath: string;
  cwdPath: string;
  sessionId?: string;
  title?: string;
  tokenBaseline?: WorkSummaryTokenBaseline;
}): WorkSummaryWorkspaceTab {
  return {
    id: `${WORK_SUMMARY_TAB_PREFIX}${crypto.randomUUID()}`,
    kind: "work-summary",
    lifecycle: "ephemeral",
    repoPath: input.repoPath,
    cwdPath: input.cwdPath,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.tokenBaseline ? { tokenBaseline: input.tokenBaseline } : {}),
    title: input.title ?? "Work Summary",
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
