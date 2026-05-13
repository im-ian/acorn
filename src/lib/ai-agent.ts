import type { AiAgent, Session } from "./types";

export interface TerminalInputState {
  draft: string;
  lastSubmitted: string | null;
  activeAgentHint?: AiAgent | null;
}

const AGENT_LABEL: Record<AiAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  ollama: "Ollama",
};

const AGENT_SHORT_LABEL: Record<AiAgent, string> = {
  claude: "Cl",
  codex: "Cx",
  gemini: "Ge",
  ollama: "Ol",
};

const PROMPT_MAX = 64;

const STATUS_LABEL: Record<Session["status"], string> = {
  idle: "Idle",
  running: "Running",
  needs_input: "Needs input",
  failed: "Failed",
  completed: "Completed",
};

const AGENT_STATUS_LABEL: Record<NonNullable<Session["agent_status"]>, string> = {
  open: "Open",
  idle: "Idle",
  running: "Running",
  needs_input: "Needs input",
};

export function aiAgentLabel(agent: AiAgent): string {
  return AGENT_LABEL[agent];
}

export function aiAgentShortLabel(agent: AiAgent): string {
  return AGENT_SHORT_LABEL[agent];
}

export function sessionStatusLabel(session: Session): string {
  if (session.active_agent) {
    const status = AGENT_STATUS_LABEL[session.agent_status ?? "open"];
    return `${aiAgentLabel(session.active_agent)} ${status.toLowerCase()}`;
  }
  return STATUS_LABEL[session.status];
}

export function sessionStatusDotClass(session: Session): string {
  if (session.active_agent) {
    return {
      open: "bg-accent/60",
      idle: "bg-fg-muted",
      running: "bg-accent animate-pulse",
      needs_input: "bg-warning",
    }[session.agent_status ?? "open"];
  }
  return {
    idle: "bg-fg-muted",
    running: "bg-accent animate-pulse",
    needs_input: "bg-warning",
    failed: "bg-danger",
    completed: "bg-accent/60",
  }[session.status];
}

export function buildAiSessionName(
  agent: AiAgent,
  prompt: string | null,
  options: { includePrompt: boolean },
): string {
  const label = aiAgentLabel(agent);
  if (!options.includePrompt || !prompt || !isCleanPromptSnippet(prompt)) {
    return label;
  }
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return label;
  const clipped =
    compact.length > PROMPT_MAX
      ? `${compact.slice(0, PROMPT_MAX - 1).trimEnd()}…`
      : compact;
  return `${label}: ${clipped}`;
}

export function shouldRepairGeneratedAiSessionName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed.includes(":")) return false;
  const knownPrefix = Object.values(AGENT_LABEL).some((label) =>
    trimmed.startsWith(`${label}:`),
  );
  if (!knownPrefix) return false;
  return !isCleanPromptSnippet(trimmed) || /\[\??\d|rgb:|\\\]1[01];/.test(trimmed);
}

export function reduceTerminalInput(
  previous: TerminalInputState,
  data: string,
): TerminalInputState {
  let draft = previous.draft;
  let lastSubmitted = previous.lastSubmitted;
  let activeAgentHint = previous.activeAgentHint ?? null;

  for (const ch of stripTerminalControlSequences(data)) {
    if (ch === "\r" || ch === "\n") {
      activeAgentHint = extractCommandAgent(draft) ?? activeAgentHint;
      const prompt = extractPromptSnippet(draft);
      if (prompt) lastSubmitted = prompt;
      draft = "";
    } else if (ch === "\x7F" || ch === "\b") {
      draft = draft.slice(0, -1);
    } else if (ch === "\x03") {
      draft = "";
    } else if (ch >= " ") {
      draft += ch;
    }
  }

  return { draft, lastSubmitted, activeAgentHint };
}

export function extractPromptSnippet(input: string): string | null {
  const clean = stripTerminalControlSequences(input).trim();
  if (!isCleanPromptSnippet(clean)) return null;
  const tokens = splitShellish(clean);
  if (tokens.length === 0) return null;
  const first = basename(tokens[0]);
  if (
    first === "claude" ||
    first === "gemini" ||
    first === "gemini-cli"
  ) {
    return promptAfterFlags(tokens, 1, new Set(["-p", "--prompt"]));
  }
  if (first === "codex") {
    return promptAfterFlags(tokens, 1, new Set(["-p", "--prompt"]));
  }
  if (first === "ollama") {
    const run = tokens[1] === "run" ? 2 : 1;
    const afterModel = tokens.length > run ? run + 1 : run;
    return joinPrompt(tokens.slice(afterModel));
  }
  return joinPrompt(tokens);
}

export function extractCommandAgent(input: string): AiAgent | null {
  const clean = stripTerminalControlSequences(input).trim();
  if (!isCleanPromptSnippet(clean)) return null;
  const tokens = splitShellish(clean);
  if (tokens.length === 0) return null;
  const first = basename(tokens[0]);
  if (first === "claude" || first === "claude-code") return "claude";
  if (first === "codex") return "codex";
  if (first === "gemini" || first === "gemini-cli") return "gemini";
  if (first === "ollama") return "ollama";
  return null;
}

function promptAfterFlags(
  tokens: string[],
  start: number,
  promptFlags: Set<string>,
): string | null {
  const prompt: string[] = [];
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (promptFlags.has(token)) continue;
    if (token.startsWith("-")) continue;
    prompt.push(token);
  }
  return joinPrompt(prompt);
}

function joinPrompt(tokens: string[]): string | null {
  const text = tokens.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 && isCleanPromptSnippet(text) ? text : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function splitShellish(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function isCleanPromptSnippet(input: string): boolean {
  if (!input.trim()) return false;
  // Terminal responses to DA / OSC color queries look printable after xterm
  // sends them back to the PTY; never treat them as typed prompts.
  if (/[\u001B\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input)) {
    return false;
  }
  if (/\[\??\d+(?:;\d+)*[Rc]|rgb:[0-9a-f/]+|\\\]1[01];/i.test(input)) {
    return false;
  }
  return true;
}

function stripTerminalControlSequences(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\x1B") {
      i = skipEscapeSequence(input, i);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (
      code < 0x20 &&
      ch !== "\r" &&
      ch !== "\n" &&
      ch !== "\b" &&
      ch !== "\x03"
    ) {
      continue;
    }
    out += ch;
  }
  return out;
}

function skipEscapeSequence(input: string, start: number): number {
  const kind = input[start + 1];
  if (!kind) return start;
  if (kind === "]") {
    return skipUntilStringTerminator(input, start + 2);
  }
  if (kind === "P" || kind === "^" || kind === "_" || kind === "X") {
    return skipUntilStringTerminator(input, start + 2);
  }
  if (kind === "[") {
    let i = start + 2;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i;
      i += 1;
    }
    return input.length - 1;
  }
  return Math.min(start + 2, input.length - 1);
}

function skipUntilStringTerminator(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === "\x07") return i;
    if (input[i] === "\x1B" && input[i + 1] === "\\") return i + 1;
  }
  return input.length - 1;
}
