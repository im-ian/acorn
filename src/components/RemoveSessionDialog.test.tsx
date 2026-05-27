import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../lib/types";
import { useSettings } from "../lib/settings";
import { RemoveSessionDialog } from "./RemoveSessionDialog";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    name: "Session 1",
    repo_path: "/repo",
    worktree_path: "/repo/.claude/worktrees/session-1",
    branch: "main",
    isolated: false,
    status: "idle",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

describe("RemoveSessionDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettings.getState().patchLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  function renderDialog(target: Session) {
    const onClose = vi.fn();
    act(() => {
      root.render(<RemoveSessionDialog session={target} onClose={onClose} />);
    });
    return onClose;
  }

  it("offers worktree deletion for a non-isolated linked worktree session", () => {
    renderDialog(session({ in_worktree: true }));

    expect(document.body.textContent).toContain(
      "This session is using a linked git worktree:",
    );
    expect(document.body.textContent).toContain("Keep worktree");
    expect(document.body.textContent).toContain("Delete worktree");
    expect(document.body.textContent).not.toContain("Don't ask again");
  });

  it("keeps the plain session remove confirmation for non-worktree sessions", () => {
    renderDialog(session({ worktree_path: "/repo" }));

    expect(document.body.textContent).toContain("will not be touched");
    expect(document.body.textContent).toContain("Don't ask again");
    expect(document.body.textContent).not.toContain("Delete worktree");
  });
});
