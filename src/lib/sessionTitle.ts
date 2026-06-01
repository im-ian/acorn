import type { Session } from "./types";
import { inferAgentProvider } from "./agentProviderRegistry";

export interface AutoSessionTitlePlanOptions {
  sessions: readonly Session[];
  enabled: boolean;
  inFlightIds: ReadonlySet<string>;
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
    (session.kind ?? "regular") === "regular" &&
    (session.owner?.kind ?? "user") === "user" &&
    (titleSource === "default" ||
      (titleSource === "generated" &&
        currentTranscriptId != null &&
        currentTranscriptId.length > 0 &&
        session.generated_title_transcript_id !== currentTranscriptId))
  );
}

function hasSessionTitleAgentSignal(session: Session): boolean {
  return (
    session.agent_transcript_id != null ||
    session.agent_provider != null ||
    inferAgentProvider(session.name) != null ||
    session.status === "running" ||
    session.status === "needs_input"
  );
}

export function canAutoGenerateSessionTitle(
  session: Session,
  enabled: boolean,
): boolean {
  return (
    enabled && canGenerateSessionTitle(session) && hasSessionTitleAgentSignal(session)
  );
}

export function planAutoGenerateSessionTitles({
  sessions,
  enabled,
  inFlightIds,
  lastAttemptAt,
  now,
  retryMs,
}: AutoSessionTitlePlanOptions): AutoSessionTitlePlan {
  if (!enabled) return { sessionIds: [], retryDelayMs: null };

  const sessionIds: string[] = [];
  let retryDelayMs: number | null = null;

  for (const session of sessions) {
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
