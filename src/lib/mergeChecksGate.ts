import type { PullRequestCheck } from "./types";

export interface MergeChecksGate {
  blocked: boolean;
  failed: number;
  pending: number;
}

/**
 * States where GitHub has not told us the checks are green. `UNSTABLE` is a
 * failing or still-running check; `UNKNOWN` is a verdict GitHub has not
 * computed yet. Other non-clean states (`BEHIND`, `DIRTY`, `DRAFT`, `BLOCKED`)
 * describe the branch or review rather than the checks and are left to the
 * caller's own `mergeable` / draft handling, so merging a behind-but-green
 * branch keeps working.
 */
const UNSETTLED_STATES = new Set(["UNSTABLE", "UNKNOWN"]);

/**
 * Counting the check list alone cannot tell a PR whose workflows have not
 * reported yet from a PR that no workflow matches: both arrive with zero
 * checks, and reading that as "nothing is blocking" opens the merge button
 * seconds after a PR is created, before any result exists. GitHub already
 * separates the two, so its verdict overrides an empty list.
 *
 * `mergeStateStatus` is absent when the field is missing from the response; the
 * count alone decides then, which is all an older response can support.
 */
export function summarizeMergeChecks(
  mergeStateStatus: string | null | undefined,
  checks: PullRequestCheck[],
): MergeChecksGate {
  let failed = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.status.toUpperCase() !== "COMPLETED") {
      pending += 1;
      continue;
    }
    switch ((check.conclusion ?? "").toUpperCase()) {
      case "FAILURE":
      case "TIMED_OUT":
      case "ACTION_REQUIRED":
        failed += 1;
        break;
      default:
        break;
    }
  }
  const unsettled = UNSETTLED_STATES.has((mergeStateStatus ?? "").toUpperCase());
  return { blocked: failed > 0 || pending > 0 || unsettled, failed, pending };
}
