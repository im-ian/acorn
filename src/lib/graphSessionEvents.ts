import type { SessionCreateScope } from "./sessionCreation";

export const NEW_GRAPH_SESSION_EVENT = "acorn:new-graph-session";

export interface NewGraphSessionEventDetail {
  scope?: SessionCreateScope;
}

export function requestNewGraphSession(scope?: SessionCreateScope): void {
  window.dispatchEvent(
    new CustomEvent<NewGraphSessionEventDetail>(NEW_GRAPH_SESSION_EVENT, {
      detail: { scope },
    }),
  );
}
