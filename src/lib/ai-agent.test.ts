import { describe, expect, it } from "vitest";
import {
  buildAiSessionName,
  extractCommandAgent,
  extractPromptSnippet,
  reduceTerminalInput,
  sessionStatusDotClass,
  sessionStatusLabel,
  shouldRepairGeneratedAiSessionName,
} from "./ai-agent";
import type { Session } from "./types";

describe("extractPromptSnippet", () => {
  it("strips known agent one-shot command wrappers", () => {
    expect(extractPromptSnippet('claude -p "fix the login bug"')).toBe(
      "fix the login bug",
    );
    expect(extractPromptSnippet("gemini -p summarize src/store.ts")).toBe(
      "summarize src/store.ts",
    );
    expect(extractPromptSnippet("ollama run llama3 explain this diff")).toBe(
      "explain this diff",
    );
  });

  it("ignores bare launches that do not contain a prompt", () => {
    expect(extractPromptSnippet("claude")).toBeNull();
    expect(extractPromptSnippet("codex --dangerously-bypass-approvals")).toBeNull();
  });
});

describe("extractCommandAgent", () => {
  it("detects interactive agent launches including gemini-cli", () => {
    expect(extractCommandAgent("gemini")).toBe("gemini");
    expect(extractCommandAgent("gemini-cli")).toBe("gemini");
    expect(extractCommandAgent("codex")).toBe("codex");
  });
});

describe("reduceTerminalInput", () => {
  it("records the submitted line when enter is written", () => {
    const next = reduceTerminalInput(
      { draft: "codex review this branch", lastSubmitted: null },
      "\r",
    );
    expect(next).toEqual({
      draft: "",
      lastSubmitted: "review this branch",
      activeAgentHint: "codex",
    });
  });

  it("handles backspace before submit", () => {
    const next = reduceTerminalInput(
      { draft: "gemini -p typo", lastSubmitted: null },
      "\x7F fix\r",
    );
    expect(next.lastSubmitted).toBe("typ fix");
  });

  it("ignores terminal control replies when tracking submitted input", () => {
    const next = reduceTerminalInput(
      { draft: "", lastSubmitted: null },
      "\x1b[?1;2c\x1b]10;rgb:eded/eded/eded\x07gemini-cli\r",
    );
    expect(next).toEqual({
      draft: "",
      lastSubmitted: null,
      activeAgentHint: "gemini",
    });
  });
});

describe("buildAiSessionName", () => {
  it("includes a bounded prompt snippet when enabled", () => {
    expect(
      buildAiSessionName("claude", "please inspect the flaky playwright test", {
        includePrompt: true,
      }),
    ).toBe("Claude: please inspect the flaky playwright test");
  });

  it("falls back to the agent label when prompt inclusion is disabled", () => {
    expect(
      buildAiSessionName("gemini", "make a UI option", {
        includePrompt: false,
      }),
    ).toBe("Gemini");
  });
});

describe("shouldRepairGeneratedAiSessionName", () => {
  it("flags generated names polluted by terminal control replies", () => {
    expect(
      shouldRepairGeneratedAiSessionName(
        "Codex: [[6;1R[?1;2c]10;rgb:eded/eded/eded",
      ),
    ).toBe(true);
  });

  it("keeps normal generated names", () => {
    expect(shouldRepairGeneratedAiSessionName("Gemini: fix tests")).toBe(false);
  });
});

describe("sessionStatusLabel", () => {
  function session(
    status: Session["status"],
    active_agent: Session["active_agent"] = null,
    agent_status: Session["agent_status"] = null,
  ): Session {
    return {
      id: "s1",
      name: "s1",
      repo_path: "/repo",
      worktree_path: "/repo",
      branch: "main",
      isolated: false,
      status,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message: null,
      kind: "regular",
      position: null,
      active_agent,
      agent_status,
      in_worktree: false,
    };
  }

  it("prefixes session status with the active agent name", () => {
    const gemini = session("running", "gemini");
    expect(sessionStatusLabel(gemini)).toBe("Gemini open");
    expect(sessionStatusDotClass(gemini)).toBe("bg-accent/60");
  });

  it("keeps explicit agent needs-input status when the backend reports it", () => {
    expect(sessionStatusLabel(session("needs_input", "codex", "needs_input"))).toBe(
      "Codex needs input",
    );
  });

  it("keeps the normal running label for non-agent shell commands", () => {
    expect(sessionStatusLabel(session("running"))).toBe("Running");
  });
});
