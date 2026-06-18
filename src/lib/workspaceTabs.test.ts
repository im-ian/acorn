import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeSessionIdFromTabId,
  isProcessBackedWorkspaceTab,
  isRestorableWorkspaceTab,
  isSessionTabId,
  isWorkspaceTabId,
  makeCodeWorkspaceTab,
  makeSessionWorkspaceTab,
  makeWorkSummaryWorkspaceTab,
} from "./workspaceTabs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace tab identity", () => {
  it("treats session ids as process-backed tab ids", () => {
    expect(isSessionTabId("session-1")).toBe(true);
    expect(isWorkspaceTabId("session-1")).toBe(false);
    expect(activeSessionIdFromTabId("session-1")).toBe("session-1");
  });

  it("treats code-viewer ids as frontend-owned workspace tab ids", () => {
    expect(isSessionTabId("code-viewer:abc")).toBe(false);
    expect(isWorkspaceTabId("code-viewer:abc")).toBe(true);
    expect(activeSessionIdFromTabId("code-viewer:abc")).toBeNull();
  });

  it("treats work-summary ids as frontend-owned workspace tab ids", () => {
    expect(isSessionTabId("work-summary:abc")).toBe(false);
    expect(isWorkspaceTabId("work-summary:abc")).toBe(true);
    expect(activeSessionIdFromTabId("work-summary:abc")).toBeNull();
  });
});

describe("workspace tab lifecycle", () => {
  it("creates session tab descriptors as process-backed", () => {
    const tab = makeSessionWorkspaceTab({
      id: "s1",
      title: "main",
      repoPath: "/repo",
    });

    expect(tab).toMatchObject({
      id: "s1",
      kind: "session",
      lifecycle: "process-backed",
      sessionId: "s1",
      repoPath: "/repo",
      title: "main",
    });
    expect(isProcessBackedWorkspaceTab(tab)).toBe(true);
  });

  it("creates code tabs as ephemeral by default and allows restorable descriptors", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000000",
    );

    const ephemeral = makeCodeWorkspaceTab("/repo/src/App.tsx", "/repo");
    const restorable = makeCodeWorkspaceTab(
      "/repo/src/store.ts",
      "/repo",
      "restorable",
    );

    expect(ephemeral).toMatchObject({
      id: "code-viewer:00000000-0000-4000-8000-000000000000",
      kind: "code",
      lifecycle: "ephemeral",
      title: "App.tsx",
    });
    expect(isRestorableWorkspaceTab(ephemeral)).toBe(false);
    expect(isRestorableWorkspaceTab(restorable)).toBe(true);
  });

  it("adds one-shot code viewer targets when requested", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");

    const tab = makeCodeWorkspaceTab("/repo/src/App.tsx", "/repo", "ephemeral", {
      line: 42,
      column: 7,
    });

    expect(tab.target).toEqual({
      line: 42,
      column: 7,
      token: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("creates work summary tabs scoped to a session worktree", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000003",
    );

    const tab = makeWorkSummaryWorkspaceTab({
      repoPath: "/repo",
      cwdPath: "/repo/.worktrees/feature",
      sessionId: "s1",
      title: "s1 summary",
    });

    expect(tab).toMatchObject({
      id: "work-summary:00000000-0000-4000-8000-000000000003",
      kind: "work-summary",
      lifecycle: "ephemeral",
      repoPath: "/repo",
      cwdPath: "/repo/.worktrees/feature",
      sessionId: "s1",
      title: "s1 summary",
    });
    expect(isRestorableWorkspaceTab(tab)).toBe(false);
  });
});
