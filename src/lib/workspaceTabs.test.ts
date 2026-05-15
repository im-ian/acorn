import { describe, expect, it, vi } from "vitest";
import {
  activeSessionIdFromTabId,
  isProcessBackedWorkspaceTab,
  isRestorableWorkspaceTab,
  isSessionTabId,
  isWorkspaceTabId,
  makeCodeWorkspaceTab,
  makeSessionWorkspaceTab,
} from "./workspaceTabs";

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
});
