import {
  buildAgentStartCommand,
  isSessionAgentProvider,
} from "./agentProviderRegistry";
import { api } from "./api";
import {
  createGithubWorkSession,
  githubWorkSessionName,
  githubWorkSlug,
  renderGithubStartWorkPrompt,
  type GithubStartWorkOutcome,
  type GithubStartWorkPlan,
} from "./githubStartWork";
import {
  PREVIOUS_STANDARD_START_WORK_PROMPT,
  STANDARD_START_WORK_PROMPT,
} from "./project-settings";
import { useSettings } from "./settings";
import type { SessionAgentProvider } from "./types";
import { useAppStore } from "../store";

export const TASK_START_WORK_PROMPT = `Work on task #{number}: {title}

Branch: {branch}

{body}

Implement the requested change in this checkout. Follow existing project conventions. If the request is ambiguous, ask a brief clarifying question before making large changes.`;

export interface TaskStartWorkTarget {
  number: number;
  title: string;
  description: string;
}

export function planTaskStartWork(task: {
  number: number;
  title: string;
}): GithubStartWorkPlan {
  const slug = githubWorkSlug(task.title);
  const branch = slug ? `task-${task.number}-${slug}` : `task-${task.number}`;
  return {
    branch,
    nameHint: branch,
    sessionName: githubWorkSessionName(task.number, task.title),
    createIfMissing: true,
    fetchRef: null,
  };
}

export function taskStartWorkTemplate(
  stored: string | null | undefined,
): string {
  const trimmed = stored?.trim() ?? "";
  if (
    trimmed.length === 0 ||
    trimmed === STANDARD_START_WORK_PROMPT ||
    trimmed === PREVIOUS_STANDARD_START_WORK_PROMPT
  ) {
    return TASK_START_WORK_PROMPT;
  }
  return trimmed;
}

export async function buildTaskAgentCommand(
  repoPath: string,
  task: TaskStartWorkTarget,
  branch: string,
  agentProvider: SessionAgentProvider,
): Promise<string> {
  let template = TASK_START_WORK_PROMPT;
  try {
    const record = await api.getProjectSettings(repoPath);
    template = taskStartWorkTemplate(record.settings.start_work?.agent_prompt);
  } catch {
    template = TASK_START_WORK_PROMPT;
  }
  const prompt = renderGithubStartWorkPrompt(template, {
    kind: "task",
    number: String(task.number),
    title: task.title.trim(),
    url: "",
    branch,
    body: task.description.trim(),
  });
  return buildAgentStartCommand(agentProvider, prompt);
}

export async function launchTaskStartWork(
  repoPath: string,
  task: TaskStartWorkTarget,
): Promise<GithubStartWorkOutcome> {
  const plan = planTaskStartWork(task);
  const selected = useSettings.getState().settings.agents.selected;
  const agentProvider = isSessionAgentProvider(selected) ? selected : null;
  try {
    const created = await createGithubWorkSession(
      (...args) => useAppStore.getState().createSession(...args),
      repoPath,
      plan,
      agentProvider,
    );
    const storeError = useAppStore.getState().consumeError();
    if (!created || storeError) {
      return { ok: false, error: storeError };
    }
    if (agentProvider) {
      const command = await buildTaskAgentCommand(
        repoPath,
        task,
        plan.branch,
        agentProvider,
      );
      useAppStore.getState().setPendingTerminalInput(created.id, command, {
        agentProvider,
        adoptWorktreeOnExit: false,
      });
    }
    return { ok: true, session: created };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
