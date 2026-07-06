import { GitBranch, GitFork, MessageSquarePlus } from "lucide-react";
import type { ContextMenuItem } from "../components/ContextMenu";
import { AGENT_PROVIDER_ORDER } from "./agentProviderRegistry";
import type { TranslationKey, Translator } from "./i18n";
import type { SessionAgentDetection, SessionAgentProvider } from "./types";

type ForkSurface = "pane" | "sidebar";

type AgentContextMenuOptions =
  | {
      mode: "fork";
      surface: ForkSurface;
      detection: SessionAgentDetection | null;
      t: Translator;
      onFork: (
        provider: SessionAgentProvider,
        transcriptId: string,
        inNewWorktree: boolean,
      ) => void;
    }
  | {
      mode: "attach";
      surface: "fileExplorer";
      detection: SessionAgentDetection | null;
      t: Translator;
      onAttach: (provider: SessionAgentProvider, transcriptId: string) => void;
    };

const EMPTY_SESSION_AGENT_DETECTION: SessionAgentDetection = {
  claude: null,
  codex: null,
  antigravity: null,
};

const FORK_KEYS = {
  pane: {
    session: {
      generic: "pane.menu.forkSession",
      provider: {
        claude: "pane.menu.forkClaudeSession",
        codex: "pane.menu.forkCodexSession",
        antigravity: "pane.menu.forkAntigravitySession",
      },
    },
    worktree: {
      generic: "pane.menu.forkInNewWorktree",
      provider: {
        claude: "pane.menu.forkClaudeInNewWorktree",
        codex: "pane.menu.forkCodexInNewWorktree",
        antigravity: "pane.menu.forkAntigravityInNewWorktree",
      },
    },
  },
  sidebar: {
    session: {
      generic: "sidebar.actions.forkSession",
      provider: {
        claude: "sidebar.actions.forkClaudeSession",
        codex: "sidebar.actions.forkCodexSession",
        antigravity: "sidebar.actions.forkAntigravitySession",
      },
    },
    worktree: {
      generic: "sidebar.actions.forkInNewWorktree",
      provider: {
        claude: "sidebar.actions.forkClaudeInNewWorktree",
        codex: "sidebar.actions.forkCodexInNewWorktree",
        antigravity: "sidebar.actions.forkAntigravityInNewWorktree",
      },
    },
  },
} as const satisfies Record<
  ForkSurface,
  {
    session: {
      generic: TranslationKey;
      provider: Record<SessionAgentProvider, TranslationKey>;
    };
    worktree: {
      generic: TranslationKey;
      provider: Record<SessionAgentProvider, TranslationKey>;
    };
  }
>;

const ATTACH_KEYS = {
  claude: "fileExplorer.menu.attachToClaude",
  codex: "fileExplorer.menu.attachToCodex",
  antigravity: "fileExplorer.menu.attachToAntigravity",
} as const satisfies Record<SessionAgentProvider, TranslationKey>;

export function createEmptySessionAgentDetection(): SessionAgentDetection {
  return { ...EMPTY_SESSION_AGENT_DETECTION };
}

export function hasDetectedAgent(
  detection: SessionAgentDetection | null,
): boolean {
  return detectedProviders(detection).length > 0;
}

export function buildAgentContextMenuItems(
  options: AgentContextMenuOptions,
): ContextMenuItem[] {
  const providers = detectedProviders(options.detection);
  if (providers.length === 0) return [];

  if (options.mode === "attach") {
    return providers.map((provider) => {
      const transcriptId = options.detection?.[provider] ?? "";
      return {
        label: options.t(ATTACH_KEYS[provider]),
        icon: <MessageSquarePlus size={13} />,
        onClick: () => options.onAttach(provider, transcriptId),
      };
    });
  }

  const keys = FORK_KEYS[options.surface];
  const multiple = providers.length > 1;
  return providers.flatMap((provider) => {
    const transcriptId = options.detection?.[provider] ?? "";
    return [
      {
        label: options.t(
          multiple ? keys.session.provider[provider] : keys.session.generic,
        ),
        icon: <GitFork size={12} />,
        onClick: () => options.onFork(provider, transcriptId, false),
      },
      {
        label: options.t(
          multiple ? keys.worktree.provider[provider] : keys.worktree.generic,
        ),
        icon: <GitBranch size={12} />,
        onClick: () => options.onFork(provider, transcriptId, true),
      },
    ];
  });
}

function detectedProviders(
  detection: SessionAgentDetection | null,
): SessionAgentProvider[] {
  if (!detection) return [];
  return AGENT_PROVIDER_ORDER.filter((provider) => Boolean(detection[provider]));
}
