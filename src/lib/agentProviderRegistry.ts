import antigravityIconUrl from "../assets/vendor/lobe-icons/antigravity.svg";
import claudeIconUrl from "../assets/vendor/lobe-icons/claude.svg";
import codexIconUrl from "../assets/vendor/lobe-icons/codex.svg";
import type {
  AgentProviderDefinition,
  AgentTokenProvider,
  SessionAgentProvider,
} from "./types";

type AgentProviderRegistry = {
  readonly [Provider in SessionAgentProvider]: AgentProviderDefinition<Provider>;
};

export const AGENT_PROVIDER_REGISTRY = {
  claude: {
    id: "claude",
    label: "Claude",
    agentOptionLabel: "Claude Code",
    oneshotHint: "claude -p --output-format text",
    icon: {
      kind: "mask",
      url: claudeIconUrl,
      alt: "Claude",
    },
    capabilities: ["history", "resume", "fork", "status", "hooks", "tokenUsage"],
    hooks: {
      supportsHooks: true,
      providerEnvValue: "claude",
    },
    session: {
      supportsSessionResume: true,
      markerFile: "claude.id",
      acknowledgedMarkerFile: "claude.id.acknowledged",
      resumeCommandPrefix: "claude --resume",
      forkCommandPrefix: "claude --resume",
      forkCommandSuffix: "--fork-session",
      requiresForkTranscriptPrep: true,
    },
    imagePasteFallback: true,
    mentionPrefix: "@",
    supportsWorktreeAdoption: true,
    brandToneClassName: "bg-[#de7356]/15 text-[#de7356]",
    inferNamePattern: /\bclaude\b/i,
  },
  codex: {
    id: "codex",
    label: "Codex",
    agentOptionLabel: "Codex",
    oneshotHint: "codex exec --skip-git-repo-check",
    icon: {
      kind: "mask",
      url: codexIconUrl,
      alt: "Codex",
    },
    capabilities: ["history", "resume", "fork", "status", "hooks", "tokenUsage"],
    hooks: {
      supportsHooks: true,
      providerEnvValue: "codex",
    },
    session: {
      supportsSessionResume: true,
      markerFile: "codex.id",
      acknowledgedMarkerFile: "codex.id.acknowledged",
      resumeCommandPrefix: "codex resume",
      forkCommandPrefix: "codex fork",
      requiresForkTranscriptPrep: false,
    },
    imagePasteFallback: true,
    mentionPrefix: "",
    supportsWorktreeAdoption: false,
    brandToneClassName: "bg-[#3867ff]/15 text-[#5f7dff]",
    inferNamePattern: /\bcodex\b/i,
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    agentOptionLabel: "Antigravity",
    oneshotHint: "agy -p <prompt>",
    icon: {
      kind: "mask",
      url: antigravityIconUrl,
      alt: "Antigravity",
    },
    capabilities: ["history", "resume", "fork", "status", "hooks"],
    hooks: {
      supportsHooks: true,
      providerEnvValue: "antigravity",
    },
    session: {
      supportsSessionResume: true,
      markerFile: "antigravity.id",
      acknowledgedMarkerFile: "antigravity.id.acknowledged",
      resumeCommandPrefix: "agy --conversation",
      forkCommandPrefix: "agy --conversation",
      forkCommandSuffix: '--prompt-interactive "/fork"',
      requiresForkTranscriptPrep: false,
    },
    imagePasteFallback: false,
    mentionPrefix: "",
    supportsWorktreeAdoption: false,
    brandToneClassName: "bg-[#19a974]/15 text-[#22b47e]",
    inferNamePattern: /\b(antigravity|agy)\b/i,
  },
} as const satisfies AgentProviderRegistry;

export function isSessionAgentProvider(
  value: string | null | undefined,
): value is SessionAgentProvider {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(AGENT_PROVIDER_REGISTRY, value)
  );
}

export const AGENT_PROVIDER_ORDER = Object.freeze(
  Object.keys(AGENT_PROVIDER_REGISTRY).filter(isSessionAgentProvider),
) as readonly SessionAgentProvider[];

export function getAgentProviderDefinition(
  provider: SessionAgentProvider,
): AgentProviderDefinition {
  return AGENT_PROVIDER_REGISTRY[provider];
}

export function inferAgentProvider(name: string): SessionAgentProvider | null {
  for (const provider of AGENT_PROVIDER_ORDER) {
    const definition = getAgentProviderDefinition(provider);
    if (definition.inferNamePattern.test(name)) return provider;
  }
  return null;
}

export function providerSupportsCapability(
  provider: SessionAgentProvider,
  capability: AgentProviderDefinition["capabilities"][number],
): boolean {
  return getAgentProviderDefinition(provider).capabilities.includes(capability);
}

export function providerSupportsHooks(provider: SessionAgentProvider): boolean {
  const definition = getAgentProviderDefinition(provider);
  return (
    definition.hooks.supportsHooks &&
    providerSupportsCapability(provider, "hooks") &&
    Boolean(definition.hooks.providerEnvValue)
  );
}

export function getAgentHookProviderEnvValue(
  provider: SessionAgentProvider,
): SessionAgentProvider | null {
  if (!providerSupportsHooks(provider)) return null;
  return getAgentProviderDefinition(provider).hooks.providerEnvValue ?? null;
}

export function providerSupportsTokenUsage(
  provider: SessionAgentProvider | null | undefined,
): provider is AgentTokenProvider {
  return Boolean(provider && providerSupportsCapability(provider, "tokenUsage"));
}

export const AGENT_TOKEN_PROVIDER_ORDER = Object.freeze(
  AGENT_PROVIDER_ORDER.filter(providerSupportsTokenUsage),
) as readonly AgentTokenProvider[];

export function providerSupportsImagePasteFallback(
  provider: SessionAgentProvider | null | undefined,
): boolean {
  return Boolean(provider && getAgentProviderDefinition(provider).imagePasteFallback);
}

export function getAgentMentionPrefix(
  provider: SessionAgentProvider | null | undefined,
): string {
  return provider ? getAgentProviderDefinition(provider).mentionPrefix : "";
}

export function providerSupportsWorktreeAdoption(
  provider: SessionAgentProvider,
): boolean {
  return getAgentProviderDefinition(provider).supportsWorktreeAdoption;
}

export function buildAgentResumeCommand(
  provider: SessionAgentProvider,
  sessionId: string,
): string {
  const definition = getAgentProviderDefinition(provider);
  const { session } = definition;
  if (
    !session.supportsSessionResume ||
    !providerSupportsCapability(provider, "resume") ||
    !session.resumeCommandPrefix
  ) {
    throw new Error(`${definition.label} does not support session resume`);
  }
  return `${session.resumeCommandPrefix} ${sessionId}`;
}

export function buildAgentForkCommand(
  provider: SessionAgentProvider,
  sessionId: string,
): string {
  const definition = getAgentProviderDefinition(provider);
  const { session } = definition;
  if (!providerSupportsCapability(provider, "fork") || !session.forkCommandPrefix) {
    throw new Error(`${definition.label} does not support session fork`);
  }
  return [session.forkCommandPrefix, sessionId, session.forkCommandSuffix]
    .filter(Boolean)
    .join(" ");
}

export function providerRequiresForkTranscriptPrep(
  provider: SessionAgentProvider,
): boolean {
  return Boolean(
    getAgentProviderDefinition(provider).session.requiresForkTranscriptPrep,
  );
}
