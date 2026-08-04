import { api } from "./api";
import { useAppStore } from "../store";

function setGraphSessionStatus(
  sessionId: string,
  status: "working" | "errored",
) {
  useAppStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && session.graph
        ? { ...session, status }
        : session,
    ),
  }));
}

export async function runSavedGraphSession(sessionId: string): Promise<void> {
  setGraphSessionStatus(sessionId, "working");
  try {
    await api.runGraphSession(sessionId);
  } catch (error) {
    setGraphSessionStatus(sessionId, "errored");
    throw error;
  } finally {
    await useAppStore.getState().refreshSessions();
  }
}
