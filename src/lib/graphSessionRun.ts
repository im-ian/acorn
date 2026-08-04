import { useAppStore } from "../store";
import { api } from "./api";
import type {
  GraphNodeVerdict,
  GraphRunState,
  GraphRunStatus,
  SessionStatus,
} from "./types";

export const GRAPH_RUN_STATE_CHANGED_EVENT =
  "acorn:graph-run-state-changed" as const;

export interface GraphRunStateChangedPayload {
  session_id: string;
  state: GraphRunState;
}

type GraphRunStateListener = (state: GraphRunState) => void;

const graphRunStateCache = new Map<string, GraphRunState>();
const graphRunStateListeners = new Map<string, Set<GraphRunStateListener>>();

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectLatestGraphRunState(
  current: GraphRunState | null,
  candidate: GraphRunState,
): GraphRunState {
  if (!current) return candidate;
  if (candidate.session_id !== current.session_id) return current;
  if (candidate.run_id === current.run_id) {
    return candidate.revision > current.revision ? candidate : current;
  }
  const startedDelta =
    timestamp(candidate.started_at) - timestamp(current.started_at);
  if (startedDelta !== 0) return startedDelta > 0 ? candidate : current;
  return timestamp(candidate.updated_at) > timestamp(current.updated_at)
    ? candidate
    : current;
}

export function subscribeGraphRunState(
  sessionId: string,
  listener: GraphRunStateListener,
): () => void {
  const listeners = graphRunStateListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  graphRunStateListeners.set(sessionId, listeners);
  const cached = graphRunStateCache.get(sessionId);
  if (cached) listener(cached);
  return () => {
    const current = graphRunStateListeners.get(sessionId);
    current?.delete(listener);
    if (current?.size === 0) graphRunStateListeners.delete(sessionId);
  };
}

export function sessionStatusForGraphRun(
  status: GraphRunStatus,
): SessionStatus {
  switch (status) {
    case "running":
      return "working";
    case "waiting":
      return "waiting_for_input";
    case "failed":
      return "errored";
    case "completed":
    case "cancelled":
      return "ready";
  }
}

function setGraphSessionStatus(
  sessionId: string,
  status: SessionStatus,
) {
  useAppStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && session.graph
        ? { ...session, status }
        : session,
    ),
  }));
}

export function applyGraphRunState(state: GraphRunState): GraphRunState {
  const current = graphRunStateCache.get(state.session_id) ?? null;
  const latest = selectLatestGraphRunState(current, state);
  if (latest !== state) return latest;
  graphRunStateCache.set(state.session_id, state);
  setGraphSessionStatus(
    state.session_id,
    sessionStatusForGraphRun(state.status),
  );
  for (const listener of graphRunStateListeners.get(state.session_id) ?? []) {
    listener(state);
  }
  return state;
}

async function refreshSessions(): Promise<void> {
  await useAppStore.getState().refreshSessions();
}

export async function runSavedGraphSession(
  sessionId: string,
): Promise<GraphRunState> {
  setGraphSessionStatus(sessionId, "working");
  try {
    return applyGraphRunState(await api.runGraphSession(sessionId));
  } catch (error) {
    setGraphSessionStatus(sessionId, "errored");
    throw error;
  } finally {
    await refreshSessions();
  }
}

export async function submitSavedGraphNodeInput(
  state: GraphRunState,
  nodeId: string,
  input: string,
  verdict?: GraphNodeVerdict,
): Promise<GraphRunState> {
  const next = await api.submitGraphNodeInput(
    state.session_id,
    state.run_id,
    nodeId,
    input,
    verdict,
    state.revision,
  );
  applyGraphRunState(next);
  await refreshSessions();
  return next;
}

export async function cancelSavedGraphRun(
  state: GraphRunState,
): Promise<GraphRunState> {
  const next = await api.cancelGraphRun(
    state.session_id,
    state.run_id,
    state.revision,
  );
  applyGraphRunState(next);
  await refreshSessions();
  return next;
}
