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

// Quiet for 5s after a successful status, mirroring VSCode's git extension
// `await timeout(5000)` in repository.ts:3201. Keeps a busy repo from
// re-running `git status` on every fs burst.
const QUIET_WINDOW_MS = 5_000;

// Debounce fs-event-driven refreshes by 1s, mirroring VSCode's
// `@debounce(1000)` in repository.ts:3192. Collapses a single user save
// (which often emits 2-3 fs events) into one status call.
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
    // Math.max guards against `now < lastSuccessAt` (clock skew, NTP step,
    // tests using fixed timestamps) — without it, elapsed goes negative and
    // remaining exceeds QUIET_WINDOW_MS, deferring refreshes indefinitely.
    const elapsed = Math.max(0, input.now - input.lastSuccessAt);
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
