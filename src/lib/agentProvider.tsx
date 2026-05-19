import type { CSSProperties } from "react";
import claudeIconUrl from "../assets/vendor/lobe-icons/claude.svg";
import codexIconUrl from "../assets/vendor/lobe-icons/codex.svg";
import { cn } from "./cn";
import type { Session, SessionAgentProvider } from "./types";

const ICON_URL: Record<SessionAgentProvider, string> = {
  claude: claudeIconUrl,
  codex: codexIconUrl,
};

const LABEL: Record<SessionAgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function resolveSessionAgentProvider(
  session: Pick<Session, "agent_provider" | "name">,
): SessionAgentProvider | null {
  if (session.agent_provider) return session.agent_provider;
  return inferAgentProvider(session.name);
}

export function collectSessionAgentProviders(
  sessions: Array<Pick<Session, "agent_provider" | "name">>,
): SessionAgentProvider[] {
  const providers = new Set<SessionAgentProvider>();
  for (const session of sessions) {
    const provider = resolveSessionAgentProvider(session);
    if (provider) providers.add(provider);
  }
  return (["claude", "codex"] as const).filter((provider) =>
    providers.has(provider),
  );
}

export function AgentProviderIcon({
  provider,
  className,
}: {
  provider: SessionAgentProvider;
  className?: string;
}) {
  const iconStyle: CSSProperties = {
    WebkitMaskImage: `url("${ICON_URL[provider]}")`,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
    maskImage: `url("${ICON_URL[provider]}")`,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
  };

  return (
    <span
      role="img"
      aria-label={LABEL[provider]}
      className={cn(
        "inline-flex size-3 shrink-0 items-center justify-center bg-current align-middle",
        className,
      )}
      style={iconStyle}
    />
  );
}

function inferAgentProvider(name: string): SessionAgentProvider | null {
  const normalized = name.toLowerCase();
  if (/\bclaude\b/.test(normalized)) return "claude";
  if (/\bcodex\b/.test(normalized)) return "codex";
  return null;
}
