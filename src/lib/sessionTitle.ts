import type { Session } from "./types";
import { inferAgentProvider } from "./agentProviderRegistry";

export interface AutoSessionTitlePlanOptions {
  sessions: readonly Session[];
  enabled: boolean;
  inFlightIds: ReadonlySet<string>;
  excludedSessionIds?: ReadonlySet<string>;
  lastAttemptAt: ReadonlyMap<string, number>;
  now: number;
  retryMs: number;
}

export interface AutoSessionTitlePlan {
  sessionIds: string[];
  retryDelayMs: number | null;
}

export interface SessionRenameOptions {
  isGeneratingTitle?: boolean;
}

export function canRenameSession(
  session: Session,
  options: SessionRenameOptions = {},
): boolean {
  return session.owner?.kind !== "control" && !options.isGeneratingTitle;
}

export function canGenerateSessionTitle(session: Session): boolean {
  const titleSource = session.title_source ?? "manual";
  const currentTranscriptId = session.agent_transcript_id?.trim();
  return (
    canForceGenerateSessionTitle(session) &&
    autoTitleEligibleForSession(session) &&
    (titleSource === "default" ||
      (titleSource === "generated" &&
        currentTranscriptId != null &&
        currentTranscriptId.length > 0 &&
        session.generated_title_transcript_id !== currentTranscriptId))
  );
}

export function canForceGenerateSessionTitle(session: Session): boolean {
  return (
    (session.kind ?? "regular") === "regular" &&
    (session.owner?.kind ?? "user") === "user"
  );
}

export function canRegenerateSessionTitle(session: Session): boolean {
  return canForceGenerateSessionTitle(session) && hasAgentChatWork(session);
}

export function autoTitleGenerationEnabledForSession(
  session: Session,
  enabled: boolean,
): boolean {
  return enabled || session.mode === "chat";
}

function autoTitleEligibleForSession(session: Session): boolean {
  if (typeof session.auto_title_enabled === "boolean") {
    return session.auto_title_enabled;
  }

  return (
    session.mode === "chat" ||
    session.title_source === "generated" ||
    inferAgentProvider(session.name) != null
  );
}

function hasAgentChatWork(session: Session): boolean {
  const transcriptId = session.agent_transcript_id?.trim();
  if (transcriptId) return true;

  const hasWorkStatus =
    session.status === "working" ||
    session.status === "waiting_for_input" ||
    session.status === "errored";
  if (!hasWorkStatus) return false;

  return session.mode === "chat" || session.agent_provider != null;
}

function hasSessionTitleAgentSignal(session: Session): boolean {
  return (
    session.mode === "chat" ||
    session.agent_transcript_id != null ||
    session.agent_provider != null ||
    inferAgentProvider(session.name) != null ||
    session.status === "working" ||
    session.status === "waiting_for_input"
  );
}

export function canAutoGenerateSessionTitle(
  session: Session,
  enabled: boolean,
): boolean {
  return (
    autoTitleGenerationEnabledForSession(session, enabled) &&
    canGenerateSessionTitle(session) &&
    hasSessionTitleAgentSignal(session)
  );
}

export function planAutoGenerateSessionTitles({
  sessions,
  enabled,
  inFlightIds,
  excludedSessionIds,
  lastAttemptAt,
  now,
  retryMs,
}: AutoSessionTitlePlanOptions): AutoSessionTitlePlan {
  const sessionIds: string[] = [];
  let retryDelayMs: number | null = null;

  for (const session of sessions) {
    if (excludedSessionIds?.has(session.id)) continue;
    if (!canAutoGenerateSessionTitle(session, enabled)) continue;
    if (inFlightIds.has(session.id)) continue;

    const last = lastAttemptAt.get(session.id);
    if (last !== undefined) {
      const remaining = retryMs - (now - last);
      if (remaining > 0) {
        retryDelayMs =
          retryDelayMs === null ? remaining : Math.min(retryDelayMs, remaining);
        continue;
      }
    }

    sessionIds.push(session.id);
  }

  return { sessionIds, retryDelayMs };
}
