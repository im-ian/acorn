import { describe, expect, it } from "vitest";
import {
  AGENT_PROVIDER_ORDER,
  AGENT_PROVIDER_REGISTRY,
  AGENT_TOKEN_PROVIDER_ORDER,
  buildAgentForkCommand,
  buildAgentResumeCommand,
  collectSessionAgentProviders,
  getAgentProviderDefinition,
  inferAgentProvider,
  isSessionAgentProvider,
  getAgentHookProviderEnvValue,
  getAgentMentionPrefix,
  providerRequiresForkTranscriptPrep,
  providerSupportsImagePasteFallback,
  providerSupportsHooks,
  providerSupportsCapability,
  providerSupportsTokenUsage,
  providerSupportsWorktreeAdoption,
  resolveSessionAgentProvider,
} from "./agentProvider";

describe("agent provider registry", () => {
  it("registers claude, codex, and antigravity in display order", () => {
    expect(AGENT_PROVIDER_ORDER).toEqual(["claude", "codex", "antigravity"]);
    expect(Object.keys(AGENT_PROVIDER_REGISTRY)).toEqual([
      "claude",
      "codex",
      "antigravity",
    ]);
  });

  it("captures user-facing metadata and supported capabilities", () => {
    expect(getAgentProviderDefinition("claude")).toMatchObject({
      id: "claude",
      label: "Claude",
      icon: { kind: "mask", alt: "Claude" },
      hooks: { supportsHooks: true, providerEnvValue: "claude" },
      session: {
        resumeCommandPrefix: "claude --resume",
        forkCommandPrefix: "claude --resume",
        forkCommandSuffix: "--fork-session",
        markerFile: "claude.id",
      },
    });
    expect(getAgentProviderDefinition("claude").capabilities).toEqual(
      expect.arrayContaining(["history", "resume", "fork", "status", "hooks"]),
    );

    expect(getAgentProviderDefinition("codex")).toMatchObject({
      id: "codex",
      label: "Codex",
      icon: { kind: "mask", alt: "Codex" },
      hooks: { supportsHooks: true, providerEnvValue: "codex" },
      session: {
        resumeCommandPrefix: "codex resume",
        forkCommandPrefix: "codex fork",
        markerFile: "codex.id",
      },
    });

    expect(getAgentProviderDefinition("antigravity")).toMatchObject({
      id: "antigravity",
      label: "Antigravity",
      icon: { kind: "mask", alt: "Antigravity" },
      hooks: { supportsHooks: true, providerEnvValue: "antigravity" },
      session: {
        resumeCommandPrefix: "agy --conversation",
        forkCommandPrefix: "agy --conversation",
        markerFile: "antigravity.id",
      },
    });
    expect(getAgentProviderDefinition("antigravity").capabilities).toEqual([
      "history",
      "resume",
      "fork",
      "status",
      "hooks",
    ]);
  });

  it("builds session commands from registry metadata", () => {
    expect(buildAgentResumeCommand("claude", "session-1")).toBe(
      "claude --resume session-1",
    );
    expect(buildAgentResumeCommand("codex", "session-2")).toBe(
      "codex resume session-2",
    );
    expect(buildAgentForkCommand("claude", "session-3")).toBe(
      "claude --resume session-3 --fork-session",
    );
    expect(buildAgentForkCommand("codex", "session-4")).toBe(
      "codex fork session-4",
    );
    expect(buildAgentResumeCommand("antigravity", "session-5")).toBe(
      "agy --conversation session-5",
    );
    expect(buildAgentForkCommand("antigravity", "session-6")).toBe(
      'agy --conversation session-6 --prompt-interactive "/fork"',
    );
  });

  it("exposes capability and fork-prep decisions through registry helpers", () => {
    expect(providerSupportsCapability("claude", "hooks")).toBe(true);
    expect(providerSupportsCapability("codex", "resume")).toBe(true);
    expect(providerSupportsCapability("antigravity", "status")).toBe(true);
    expect(providerSupportsCapability("antigravity", "history")).toBe(true);
    expect(providerSupportsCapability("antigravity", "resume")).toBe(true);
    expect(providerSupportsCapability("antigravity", "fork")).toBe(true);
    expect(providerRequiresForkTranscriptPrep("claude")).toBe(true);
    expect(providerRequiresForkTranscriptPrep("codex")).toBe(false);
    expect(providerRequiresForkTranscriptPrep("antigravity")).toBe(false);
  });

  it("exposes hook env support through registry metadata", () => {
    expect(providerSupportsHooks("claude")).toBe(true);
    expect(providerSupportsHooks("codex")).toBe(true);
    expect(providerSupportsHooks("antigravity")).toBe(true);
    expect(getAgentHookProviderEnvValue("claude")).toBe("claude");
    expect(getAgentHookProviderEnvValue("codex")).toBe("codex");
    expect(getAgentHookProviderEnvValue("antigravity")).toBe("antigravity");
  });

  it("centralizes per-provider behavior flags", () => {
    expect(isSessionAgentProvider("claude")).toBe(true);
    expect(isSessionAgentProvider("ollama")).toBe(false);
    expect(getAgentProviderDefinition("claude")).toMatchObject({
      agentOptionLabel: "Claude Code",
      oneshotHint: "claude -p --output-format text",
      imagePasteFallback: true,
      mentionPrefix: "@",
      supportsWorktreeAdoption: true,
      brandToneClassName: "bg-[#de7356]/15 text-[#de7356]",
    });
    expect(getAgentProviderDefinition("codex")).toMatchObject({
      agentOptionLabel: "Codex",
      oneshotHint: "codex exec --skip-git-repo-check",
      imagePasteFallback: true,
      mentionPrefix: "",
      supportsWorktreeAdoption: false,
      brandToneClassName: "bg-[#3867ff]/15 text-[#5f7dff]",
    });
    expect(getAgentProviderDefinition("antigravity")).toMatchObject({
      agentOptionLabel: "Antigravity",
      oneshotHint: "agy -p <prompt>",
      imagePasteFallback: false,
      mentionPrefix: "",
      supportsWorktreeAdoption: false,
      brandToneClassName: "bg-[#19a974]/15 text-[#22b47e]",
    });
    expect(providerSupportsTokenUsage("claude")).toBe(true);
    expect(providerSupportsTokenUsage("codex")).toBe(true);
    expect(providerSupportsTokenUsage("antigravity")).toBe(false);
    expect(AGENT_TOKEN_PROVIDER_ORDER).toEqual(["claude", "codex"]);
    expect(providerSupportsImagePasteFallback("claude")).toBe(true);
    expect(providerSupportsImagePasteFallback("antigravity")).toBe(false);
    expect(getAgentMentionPrefix("claude")).toBe("@");
    expect(getAgentMentionPrefix("codex")).toBe("");
    expect(providerSupportsWorktreeAdoption("claude")).toBe(true);
    expect(providerSupportsWorktreeAdoption("codex")).toBe(false);
  });
});

describe("agent provider helpers", () => {
  it("prefers explicit session provider over name inference", () => {
    expect(
      resolveSessionAgentProvider({
        agent_provider: "codex",
        name: "Claude worktree",
      }),
    ).toBe("codex");
  });

  it("does not infer live providers from session names", () => {
    expect(
      resolveSessionAgentProvider({
        agent_provider: null,
        name: "codex shell",
      }),
    ).toBeNull();
  });

  it("infers known providers from session names", () => {
    expect(inferAgentProvider("Claude worktree")).toBe("claude");
    expect(inferAgentProvider("resume codex session")).toBe("codex");
    expect(inferAgentProvider("Antigravity task")).toBe("antigravity");
    expect(inferAgentProvider("agy task")).toBe("antigravity");
    expect(inferAgentProvider("plain shell")).toBeNull();
  });

  it("collects providers once in registry order", () => {
    expect(
      collectSessionAgentProviders([
        { agent_provider: "codex", name: "first" },
        { agent_provider: "antigravity", name: "antigravity" },
        { agent_provider: null, name: "claude fork" },
        { agent_provider: "codex", name: "second" },
      ]),
    ).toEqual(["codex", "antigravity"]);
  });
});
