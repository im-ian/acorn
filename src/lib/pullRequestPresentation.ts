export interface PullRequestStateLike {
  state: string;
  is_draft: boolean;
}

export function pullRequestNumberClassName(
  pr: PullRequestStateLike,
): string {
  const upper = pr.state.toUpperCase();
  if (pr.is_draft && upper === "OPEN") return "text-fg-muted";
  if (upper === "OPEN") return "text-emerald-400";
  if (upper === "MERGED") return "text-purple-400";
  return "text-rose-400";
}
