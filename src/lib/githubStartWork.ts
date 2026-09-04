import { api } from "./api";
import {
  readSessionPullRequestBranchLinks,
  writeSessionPullRequestBranchLinks,
} from "./sessionPullRequestLinks";
import type {
  Session,
  SessionAgentProvider,
  SessionKind,
  SessionMode,
} from "./types";

const SLUG_MAX = 40;

export type GithubStartWorkKind = "pr" | "issue";

export interface GithubStartWorkTarget {
  kind: GithubStartWorkKind;
  number: number;
  title: string;
  headBranch?: string;
}

export interface GithubStartWorkPlan {
  branch: string;
  nameHint: string;
  sessionName: string;
  createIfMissing: boolean;
  fetchRef: string | null;
}

export type GithubWorkSessionFactory = (
  name: string,
  repoPath: string,
  isolated?: boolean,
  kind?: SessionKind,
  agentProvider?: SessionAgentProvider | null,
  projectScoped?: boolean,
  mode?: SessionMode,
  projectFolderId?: string,
  cwdPath?: string,
) => Promise<Session | null>;

export function githubWorkSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  if (slug.length <= SLUG_MAX) return slug;
  return slug.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

export function githubWorkSessionName(number: number, title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  return trimmed ? `#${number} ${trimmed}` : `#${number}`;
}

export function planGithubStartWork(
  target: GithubStartWorkTarget,
): GithubStartWorkPlan | null {
  const sessionName = githubWorkSessionName(target.number, target.title);
  const slug = githubWorkSlug(target.title);
  if (target.kind === "pr") {
    const branch = target.headBranch?.trim() ?? "";
    if (!branch) return null;
    return {
      branch,
      nameHint: slug ? `pr-${target.number}-${slug}` : `pr-${target.number}`,
      sessionName,
      createIfMissing: false,
      fetchRef: `refs/pull/${target.number}/head`,
    };
  }
  const branch = slug
    ? `issue-${target.number}-${slug}`
    : `issue-${target.number}`;
  return {
    branch,
    nameHint: branch,
    sessionName,
    createIfMissing: true,
    fetchRef: null,
  };
}

export async function createGithubWorkSession(
  createSession: GithubWorkSessionFactory,
  repoPath: string,
  plan: GithubStartWorkPlan,
): Promise<Session | null> {
  const ensured = await api.ensureProjectWorktreeForBranch(
    repoPath,
    plan.branch,
    plan.nameHint,
    plan.createIfMissing,
    plan.fetchRef,
  );
  return createSession(
    plan.sessionName,
    repoPath,
    ensured.created,
    "regular",
    null,
    true,
    "terminal",
    undefined,
    ensured.path,
  );
}

export type GithubStartWorkOutcome =
  | { ok: true; session: Session }
  | { ok: false; error: string | null };

export async function runGithubStartWork(options: {
  repoPath: string;
  target: GithubStartWorkTarget;
  createSession: GithubWorkSessionFactory;
  consumeError: () => string | null;
}): Promise<GithubStartWorkOutcome> {
  const plan = planGithubStartWork(options.target);
  if (!plan) return { ok: false, error: null };
  try {
    const created = await createGithubWorkSession(
      options.createSession,
      options.repoPath,
      plan,
    );
    const storeError = options.consumeError();
    if (!created || storeError) {
      return { ok: false, error: storeError };
    }
    if (options.target.kind === "pr") {
      const headBranch = options.target.headBranch?.trim() ?? "";
      if (headBranch) {
        writeSessionPullRequestBranchLinks({
          ...readSessionPullRequestBranchLinks(),
          [created.id]: {
            repoPath: options.repoPath,
            headBranch,
          },
        });
      }
    }
    return { ok: true, session: created };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
