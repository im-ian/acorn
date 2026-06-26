import type { Session } from "./types";

export function hasActiveAgentSignal(session: Session): boolean {
  return session.mode === "chat" || session.agent_provider != null;
}

export function canConfigureSessionAutoClose(session: Session): boolean {
  return (
    (session.kind ?? "regular") === "regular" && hasActiveAgentSignal(session)
  );
}
