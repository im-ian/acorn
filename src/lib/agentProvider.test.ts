import { describe, expect, it } from "vitest";
import {
  AGENT_PROVIDER_ORDER,
  AGENT_PROVIDER_REGISTRY,
  buildAgentForkCommand,
  buildAgentResumeCommand,
  collectSessionAgentProviders,
  getAgentProviderDefinition,
  inferAgentProvider,
  getAgentHookProviderEnvValue,
  providerRequiresForkTranscriptPrep,
  providerSupportsHooks,
  providerSupportsCapability,
  resolveSessionAgentProvider,
} from "./agentProvider";

describe("agent provider registry", () => {
  it("registers claude and codex in display order", () => {
    expect(AGENT_PROVIDER_ORDER).toEqual(["claude", "codex"]);
    expect(Object.keys(AGENT_PROVIDER_REGISTRY)).toEqual(["claude", "codex"]);
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
  });

  it("exposes capability and fork-prep decisions through registry helpers", () => {
    expect(providerSupportsCapability("claude", "hooks")).toBe(true);
    expect(providerSupportsCapability("codex", "resume")).toBe(true);
    expect(providerRequiresForkTranscriptPrep("claude")).toBe(true);
    expect(providerRequiresForkTranscriptPrep("codex")).toBe(false);
  });

  it("exposes hook env support through registry metadata", () => {
    expect(providerSupportsHooks("claude")).toBe(true);
    expect(providerSupportsHooks("codex")).toBe(true);
    expect(getAgentHookProviderEnvValue("claude")).toBe("claude");
    expect(getAgentHookProviderEnvValue("codex")).toBe("codex");
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

  it("infers known providers from session names", () => {
    expect(inferAgentProvider("Claude worktree")).toBe("claude");
    expect(inferAgentProvider("resume codex session")).toBe("codex");
    expect(inferAgentProvider("plain shell")).toBeNull();
  });

  it("collects providers once in registry order", () => {
    expect(
      collectSessionAgentProviders([
        { agent_provider: "codex", name: "first" },
        { agent_provider: null, name: "claude fork" },
        { agent_provider: "codex", name: "second" },
      ]),
    ).toEqual(["claude", "codex"]);
  });
});
