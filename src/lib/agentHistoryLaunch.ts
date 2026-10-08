import { isArchivedSession, liveSessions } from "./sessionArchive";

/** A live Acorn tab that can stand in for a History resume. */
export interface HistoryLaunchSession {
  id: string;
  archived_at?: string | null;
  updated_at?: string;
  agent_provider?: string | null;
  agent_transcript_provider?: string | null;
  agent_transcript_id?: string | null;
}

export interface HistoryLaunchPendingInput {
  command: string;
  agentProvider?: string | null;
}

export interface HistoryLaunchItem {
  provider: string;
  id: string;
  resume_command?: string | null;
}

export interface FindOpenHistorySessionInput {
  sessions: readonly HistoryLaunchSession[];
  pendingTerminalInput: Readonly<
    Record<string, HistoryLaunchPendingInput | undefined>
  >;
  rememberedSessionId: string | null;
  activeSessionId: string | null;
  item: HistoryLaunchItem;
}

const rememberedSessionIds = new Map<string, string>();
const inflightLaunches = new Map<string, Promise<string | null>>();

export function historyLaunchKey(item: Pick<HistoryLaunchItem, "provider" | "id">): string {
  return `${item.provider}:${item.id}`;
}

export function rememberedHistorySessionId(
  item: Pick<HistoryLaunchItem, "provider" | "id">,
): string | null {
  return rememberedSessionIds.get(historyLaunchKey(item)) ?? null;
}

export function resetHistoryLaunchesForTests(): void {
  rememberedSessionIds.clear();
  inflightLaunches.clear();
}

/**
 * One History row shares one in-flight create. A second click joins the
 * first launch instead of opening another tab.
 */
export function openHistoryLaunchGate(item: Pick<HistoryLaunchItem, "provider" | "id">): {
  joined: Promise<string | null> | null;
  finish: (sessionId: string | null) => void;
} {
  const key = historyLaunchKey(item);
  const existing = inflightLaunches.get(key);
  if (existing) {
    return { joined: existing, finish: () => {} };
  }
  let settle!: (sessionId: string | null) => void;
  let settled = false;
  const promise = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  inflightLaunches.set(key, promise);
  return {
    joined: null,
    finish(sessionId) {
      if (settled) return;
      settled = true;
      if (sessionId) rememberedSessionIds.set(key, sessionId);
      inflightLaunches.delete(key);
      settle(sessionId);
    },
  };
}

export function findOpenHistorySession(
  input: FindOpenHistorySessionInput,
): HistoryLaunchSession | null {
  const live = liveSessions(input.sessions);
  const paired = live.filter((session) => isPairedHistorySession(session, input.item));
  if (paired.length > 0) return preferSession(paired, input.activeSessionId);

  if (input.rememberedSessionId) {
    const remembered = live.find(
      (session) => session.id === input.rememberedSessionId,
    );
    if (remembered && sessionStillMatchesHistory(remembered, input.item)) {
      return remembered;
    }
  }

  const queued = live.filter((session) =>
    isPendingHistoryResume(
      session,
      input.pendingTerminalInput[session.id],
      input.item,
    ),
  );
  if (queued.length > 0) return preferSession(queued, input.activeSessionId);
  return null;
}

function isPairedHistorySession(
  session: HistoryLaunchSession,
  item: HistoryLaunchItem,
): boolean {
  if (!session.agent_transcript_id || session.agent_transcript_id !== item.id) {
    return false;
  }
  return providerMatches(session, item.provider);
}

function sessionStillMatchesHistory(
  session: HistoryLaunchSession,
  item: HistoryLaunchItem,
): boolean {
  if (session.agent_transcript_id && session.agent_transcript_id !== item.id) {
    return false;
  }
  if (isArchivedSession(session)) return false;
  return providerMatches(session, item.provider);
}

function isPendingHistoryResume(
  session: HistoryLaunchSession,
  pending: HistoryLaunchPendingInput | undefined,
  item: HistoryLaunchItem,
): boolean {
  if (!item.resume_command || !pending) return false;
  if (pending.command !== item.resume_command) return false;
  // A restored queue must not pull a tab that already belongs to another conversation.
  if (!sessionStillMatchesHistory(session, item)) return false;
  const provider = pending.agentProvider ?? session.agent_provider;
  return provider == null || provider === item.provider;
}

function providerMatches(session: HistoryLaunchSession, provider: string): boolean {
  const current = session.agent_transcript_provider ?? session.agent_provider;
  return current == null || current === provider;
}

function preferSession<T extends HistoryLaunchSession>(
  sessions: readonly T[],
  activeSessionId: string | null,
): T {
  const active = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)
    : undefined;
  if (active) return active;
  return [...sessions].sort((a, b) =>
    (a.updated_at ?? "").localeCompare(b.updated_at ?? ""),
  )[sessions.length - 1];
}
