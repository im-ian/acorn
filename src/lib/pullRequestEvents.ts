export type PullRequestMutationKind =
  | "merged"
  | "closed"
  | "reopened"
  | "draft_changed"
  | "edited"
  | "checks_changed"
  | "synchronized"
  | "commented"
  | "reviewed";

export interface PullRequestMutationEvent {
  kind: PullRequestMutationKind;
  repoPath: string;
  number: number;
  headBranch?: string | null;
  baseBranch?: string | null;
  title?: string | null;
  isDraft?: boolean | null;
}

type PullRequestMutationListener = (event: PullRequestMutationEvent) => void;

const listeners = new Set<PullRequestMutationListener>();

export function onPullRequestMutation(
  listener: PullRequestMutationListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPullRequestMutation(event: PullRequestMutationEvent): void {
  for (const listener of Array.from(listeners)) {
    listener(event);
  }
}

export function pullRequestMutationAffectsOpenContext(
  kind: PullRequestMutationKind,
): boolean {
  switch (kind) {
    case "merged":
    case "closed":
    case "reopened":
    case "draft_changed":
    case "edited":
    case "checks_changed":
    case "synchronized":
      return true;
    case "commented":
    case "reviewed":
      return false;
  }
}
