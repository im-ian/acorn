export const STANDARD_PR_GENERATION_PROMPT = `Use a standard GitHub-style pull request merge message.
- First line: Conventional Commit subject when the type is clear, e.g. feat(scope): concise summary. Keep it imperative/present tense and <=72 chars.
- Body: 1-2 concise paragraphs explaining why the change matters, user-visible impact, and key implementation notes when useful.
- Keep the wording specific to the PR. Avoid boilerplate, markdown headings, labels, and prompt explanations.`;

export const PREVIOUS_STANDARD_START_WORK_PROMPT = `Work on GitHub {kind} #{number}: {title}

URL: {url}
Branch: {branch}

{body}

Implement the requested change in this checkout. Follow existing project conventions. If the request is ambiguous, ask a brief clarifying question before making large changes.`;

export const STANDARD_START_WORK_PROMPT = `Work on GitHub {kind} #{number}: {title}

URL: {url}
Branch: {branch}

Open that GitHub URL, read the issue or pull request, and implement the work in this checkout. Follow existing project conventions. If the request is ambiguous, ask a brief clarifying question before making large changes.`;

export function resolveStartWorkAgentPrompt(
  prompt: string | null | undefined,
): string | null {
  if (prompt === undefined || prompt === PREVIOUS_STANDARD_START_WORK_PROMPT) {
    return STANDARD_START_WORK_PROMPT;
  }
  return prompt;
}
