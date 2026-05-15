export type WorktreeAdoptionIntent = { kind: "none" } | { kind: "after-exit" };

export interface WorktreeAdoptionChoiceInput {
  before: readonly string[];
  after: readonly string[];
  intent: WorktreeAdoptionIntent;
  observedLinkedWorktreePath?: string | null;
}

export function chooseWorktreeToAdoptAfterExit({
  before,
  after,
  intent,
  observedLinkedWorktreePath,
}: WorktreeAdoptionChoiceInput): string | null {
  const known = new Set(before);
  const fresh = after.filter((path) => !known.has(path));
  if (intent.kind === "after-exit") {
    return fresh[fresh.length - 1] ?? null;
  }
  if (
    observedLinkedWorktreePath &&
    fresh.includes(observedLinkedWorktreePath)
  ) {
    return observedLinkedWorktreePath;
  }
  return null;
}

export function commandRequestsWorktreeAdoption(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  if (tokens[0] !== "claude") return false;
  return tokens.slice(1).some((token) => token === "--worktree" || token === "-w");
}
