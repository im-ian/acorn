export const STANDARD_PR_GENERATION_PROMPT = `Use a standard GitHub-style pull request merge message.
- First line: Conventional Commit subject when the type is clear, e.g. feat(scope): concise summary. Keep it imperative/present tense and <=72 chars.
- Body: 1-2 concise paragraphs explaining why the change matters, user-visible impact, and key implementation notes when useful.
- Keep the wording specific to the PR. Avoid boilerplate, markdown headings, labels, and prompt explanations.`;
