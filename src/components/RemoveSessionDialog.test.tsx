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
    useSettings.getState().reset();
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

  function renderDialog(target: Session, canDeleteWorktree = true) {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <RemoveSessionDialog
          session={target}
          canDeleteWorktree={canDeleteWorktree}
          onClose={onClose}
        />,
      );
    });
    return onClose;
  }

  it("offers worktree deletion for a non-isolated linked worktree session", () => {
    renderDialog(session({ in_worktree: true }));

    expect(document.body.textContent).toContain(
      "This session is using a linked git worktree:",
    );
    expect(document.body.textContent).toContain("Remove only");
    expect(document.body.textContent).toContain("Remove + delete worktree");
    expect(document.body.textContent).not.toContain(
      "Delete standalone isolated worktrees without asking next time",
    );
    expect(document.body.textContent).not.toContain("Don't ask again");
  });

  it("lets standalone isolated sessions update the future cleanup setting", () => {
    const onClose = renderDialog(
      session({
        isolated: true,
        in_worktree: true,
        worktree_path: "/repo/.acorn/worktrees/session-1",
      }),
    );

    expect(document.body.textContent).toContain(
      "Delete standalone isolated worktrees without asking next time",
    );

    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    expect(checkbox?.checked).toBe(false);

    act(() => {
      checkbox?.click();
    });

    expect(checkbox?.checked).toBe(true);
    expect(
      useSettings.getState().settings.sessions
        .confirmDeleteIsolatedWorktrees,
    ).toBe(true);

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove + delete worktree",
    );
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      deleteButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(
      useSettings.getState().settings.sessions
        .confirmDeleteIsolatedWorktrees,
    ).toBe(false);
    expect(onClose).toHaveBeenCalledWith("session_and_worktree");
  });

  it("keeps shared worktree workspace sessions on disk", () => {
    renderDialog(session({ isolated: true, in_worktree: true }), false);

    expect(document.body.textContent).toContain(
      "This worktree is shared by a workspace and will be kept on disk.",
    );
    expect(document.body.textContent).not.toContain("Remove only");
    expect(document.body.textContent).not.toContain("Remove + delete worktree");
    expect(document.body.textContent).toContain("Remove");
    expect(document.body.textContent).not.toContain(
      "Delete standalone isolated worktrees without asking next time",
    );
  });

  it("keeps the plain session remove confirmation for non-worktree sessions", () => {
    renderDialog(session({ worktree_path: "/repo" }));

    expect(document.body.textContent).toContain("will not be touched");
    expect(document.body.textContent).toContain("Don't ask again");
    expect(document.body.textContent).not.toContain("Remove + delete worktree");
  });
});
