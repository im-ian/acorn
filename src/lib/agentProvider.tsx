import type { CSSProperties } from "react";
import { cn } from "./cn";
import {
  AGENT_PROVIDER_ORDER,
  getAgentProviderDefinition,
} from "./agentProviderRegistry";
import type { Session, SessionAgentProvider } from "./types";

export {
  AGENT_PROVIDER_ORDER,
  AGENT_PROVIDER_REGISTRY,
  buildAgentForkCommand,
  buildAgentResumeCommand,
  getAgentHookProviderEnvValue,
  getAgentProviderDefinition,
  inferAgentProvider,
  providerRequiresForkTranscriptPrep,
  providerSupportsHooks,
  providerSupportsCapability,
} from "./agentProviderRegistry";

export function resolveSessionAgentProvider(
  session: Pick<Session, "agent_provider" | "name">,
): SessionAgentProvider | null {
  return session.agent_provider ?? null;
}

export function collectSessionAgentProviders(
  sessions: Array<Pick<Session, "agent_provider" | "name">>,
): SessionAgentProvider[] {
  const providers = new Set<SessionAgentProvider>();
  for (const session of sessions) {
    const provider = resolveSessionAgentProvider(session);
    if (provider) providers.add(provider);
  }
  return AGENT_PROVIDER_ORDER.filter((provider) => providers.has(provider));
}

export function AgentProviderIcon({
  provider,
  className,
}: {
  provider: SessionAgentProvider;
  className?: string;
}) {
  const definition = getAgentProviderDefinition(provider);
  if (definition.icon.kind === "glyph") {
    return (
      <span
        role="img"
        aria-label={definition.icon.alt}
        className={cn(
          "inline-flex size-3 shrink-0 items-center justify-center align-middle text-[9px] font-semibold leading-none",
          className,
        )}
      >
        {definition.icon.text}
      </span>
    );
  }

  const iconStyle: CSSProperties = {
    WebkitMaskImage: `url("${definition.icon.url}")`,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
    maskImage: `url("${definition.icon.url}")`,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
  };

  return (
    <span
      role="img"
      aria-label={definition.icon.alt}
      className={cn(
        "inline-flex size-3 shrink-0 items-center justify-center bg-current align-middle",
        className,
      )}
      style={iconStyle}
    />
  );
}
