import {
  buildAgentStartCommand,
  isSessionAgentProvider,
} from "./agentProviderRegistry";
import { api } from "./api";
import { resolveStartWorkAgentPrompt } from "./project-settings";
import { findSessionsForPullRequest } from "./sessionContext";
import {
  readSessionPullRequestBranchLinks,
  writeSessionPullRequestBranchLinks,
} from "./sessionPullRequestLinks";
import { useSettings } from "./settings";
import type {
  Session,
  SessionAgentProvider,
  SessionKind,
  SessionMode,
} from "./types";
import { useAppStore } from "../store";

const SLUG_MAX = 40;
const START_WORK_PLACEHOLDER_RE = /\{(kind|number|title|url|branch|body)\}/g;

export type GithubStartWorkKind = "pr" | "issue";

export interface GithubStartWorkTarget {
  kind: GithubStartWorkKind;
  number: number;
  title: string;
  url?: string;
  headBranch?: string;
}

export interface GithubStartWorkPlan {
  branch: string;
  nameHint: string;
  sessionName: string;
  createIfMissing: boolean;
  fetchRef: string | null;
}

export interface GithubStartWorkPromptVars {
  kind: string;
  number: string;
  title: string;
  url: string;
  branch: string;
  body: string;
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

export type GithubStartWorkCommandQueue = (
  sessionId: string,
  command: string,
  options?: {
    agentProvider?: SessionAgentProvider;
    adoptWorktreeOnExit?: boolean;
  },
) => void;

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

export function findSessionsForGithubWork(
  sessions: readonly Session[],
  repoPath: string,
  target: GithubStartWorkTarget,
): Session[] {
  if (target.kind === "pr") {
    return findSessionsForPullRequest(
      sessions,
      repoPath,
      target.headBranch ?? "",
      readSessionPullRequestBranchLinks(),
    );
  }
  const plan = planGithubStartWork(target);
  if (!plan) return [];
  return findSessionsForPullRequest(sessions, repoPath, plan.branch);
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

function githubStartWorkKindLabel(kind: GithubStartWorkKind): string {
  return kind === "pr" ? "pull request" : "issue";
}

export function renderGithubStartWorkPrompt(
  template: string,
  vars: GithubStartWorkPromptVars,
): string {
  const rendered = template.replace(
    START_WORK_PLACEHOLDER_RE,
    (match, name: keyof GithubStartWorkPromptVars) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
  return rendered.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function createGithubWorkSession(
  createSession: GithubWorkSessionFactory,
  repoPath: string,
  plan: GithubStartWorkPlan,
  agentProvider: SessionAgentProvider | null = null,
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
    agentProvider,
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
  agentProvider?: SessionAgentProvider | null;
  queueTerminalCommand?: GithubStartWorkCommandQueue;
}): Promise<GithubStartWorkOutcome> {
  const plan = planGithubStartWork(options.target);
  if (!plan) return { ok: false, error: null };
  const agentProvider = options.agentProvider ?? null;
  try {
    const created = await createGithubWorkSession(
      options.createSession,
      options.repoPath,
      plan,
      agentProvider,
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
    if (agentProvider && options.queueTerminalCommand) {
      const command = await buildGithubStartWorkCommand(
        options.repoPath,
        options.target,
        plan,
        agentProvider,
      );
      options.queueTerminalCommand(created.id, command, {
        agentProvider,
        adoptWorktreeOnExit: false,
      });
    }
    return { ok: true, session: created };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function launchGithubStartWork(
  repoPath: string,
  target: GithubStartWorkTarget,
): Promise<GithubStartWorkOutcome> {
  const selected = useSettings.getState().settings.agents.selected;
  const agentProvider = isSessionAgentProvider(selected) ? selected : null;
  return runGithubStartWork({
    repoPath,
    target,
    createSession: (...args) =>
      useAppStore.getState().createSession(...args),
    consumeError: () => useAppStore.getState().consumeError(),
    agentProvider,
    queueTerminalCommand: (sessionId, command, queueOptions) => {
      useAppStore
        .getState()
        .setPendingTerminalInput(sessionId, command, queueOptions);
    },
  });
}

async function buildGithubStartWorkCommand(
  repoPath: string,
  target: GithubStartWorkTarget,
  plan: GithubStartWorkPlan,
  agentProvider: SessionAgentProvider,
): Promise<string> {
  const template = await loadStartWorkPromptTemplate(repoPath);
  if (!template) return buildAgentStartCommand(agentProvider);
  const body = template.includes("{body}")
    ? await fetchGithubStartWorkBody(repoPath, target)
    : "";
  const prompt = renderGithubStartWorkPrompt(template, {
    kind: githubStartWorkKindLabel(target.kind),
    number: String(target.number),
    title: target.title.trim(),
    url: target.url?.trim() ?? "",
    branch: plan.branch,
    body,
  });
  return buildAgentStartCommand(agentProvider, prompt);
}

async function loadStartWorkPromptTemplate(
  repoPath: string,
): Promise<string | null> {
  try {
    const record = await api.getProjectSettings(repoPath);
    return resolveStartWorkAgentPrompt(record.settings.start_work?.agent_prompt);
  } catch {
    return resolveStartWorkAgentPrompt(undefined);
  }
}

async function fetchGithubStartWorkBody(
  repoPath: string,
  target: GithubStartWorkTarget,
): Promise<string> {
  try {
    if (target.kind === "issue") {
      const listing = await api.getIssueDetail(repoPath, target.number);
      return listing.kind === "ok" ? listing.detail.body.trim() : "";
    }
    const listing = await api.getPullRequestDetail(repoPath, target.number);
    return listing.kind === "ok" ? listing.detail.body.trim() : "";
  } catch {
    return "";
  }
}
