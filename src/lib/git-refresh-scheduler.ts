export type GitRefreshTrigger = "mount" | "fs-event" | "user";

export interface GitRefreshInput {
  now: number;
  lastSuccessAt: number | null;
  inFlight: boolean;
  focused: boolean;
  huge: boolean;
  trigger: GitRefreshTrigger;
  dotgitChanged: boolean;
  hasWorkingTreeChange: boolean;
}

export type GitRefreshDecision =
  | { action: "run"; debounceMs: number }
  | { action: "defer"; waitMs: number }
  | { action: "defer-until-focus" }
  | { action: "coalesce-with-inflight" }
  | { action: "skip-huge" }
  | { action: "skip-nothing-changed" };

const QUIET_WINDOW_MS = 5_000;
const DEBOUNCE_MS = 1_000;

export function planGitRefresh(input: GitRefreshInput): GitRefreshDecision {
  if (input.trigger === "mount") {
    return { action: "run", debounceMs: 0 };
  }
  if (
    !input.dotgitChanged &&
    !input.hasWorkingTreeChange &&
    input.trigger !== "user"
  ) {
    return { action: "skip-nothing-changed" };
  }
  if (input.huge && input.trigger !== "user") {
    return { action: "skip-huge" };
  }
  if (!input.focused) {
    return { action: "defer-until-focus" };
  }
  if (input.inFlight) {
    return { action: "coalesce-with-inflight" };
  }

  if (input.lastSuccessAt !== null) {
    const elapsed = input.now - input.lastSuccessAt;
    if (elapsed < QUIET_WINDOW_MS) {
      const remaining = QUIET_WINDOW_MS - elapsed;
      if (remaining > DEBOUNCE_MS) {
        return { action: "defer", waitMs: remaining };
      }
    }
  }

  const debounceMs = input.trigger === "user" ? 0 : DEBOUNCE_MS;
  return { action: "run", debounceMs };
}
