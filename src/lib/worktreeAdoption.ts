export type WorktreeAdoptionIntent = { kind: "none" } | { kind: "after-exit" };

export interface WorktreeAdoptionChoiceInput {
  before: readonly string[];
  after: readonly string[];
  intent: WorktreeAdoptionIntent;
}

export function chooseWorktreeToAdoptAfterExit({
  before,
  after,
  intent,
}: WorktreeAdoptionChoiceInput): string | null {
  if (intent.kind !== "after-exit") return null;

  const known = new Set(before);
  const fresh = after.filter((path) => !known.has(path));
  return fresh[fresh.length - 1] ?? null;
}

export function commandRequestsWorktreeAdoption(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  if (tokens[0] !== "claude") return false;
  return tokens.slice(1).some((token) => token === "--worktree" || token === "-w");
}
