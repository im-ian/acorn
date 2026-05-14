import { test, expect } from "./support";

const REPO_PATH = "/tmp/demo";
const PROJECT = {
  repo_path: REPO_PATH,
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};
const SESSION = {
  id: "s-resume",
  name: "alpha",
  repo_path: REPO_PATH,
  worktree_path: REPO_PATH,
  branch: "main",
  isolated: false,
  status: "idle",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:05Z",
  last_message: null,
  kind: "regular",
};
const CANDIDATE_UUID = "deadbeef-1234-5678-9abc-def012345678";

test.describe("agent resume modal", () => {
  test("focusing a session with a claude candidate pops the modal and Resume writes claude --resume", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);
    await tauri.handle("get_claude_resume_candidate", () => ({
      uuid: "deadbeef-1234-5678-9abc-def012345678",
      lastActivityUnix: Math.floor(Date.now() / 1000) - 600,
      preview: "Preview of the previous conversation",
    }));
    // Stash every pty_write call on window so we can assert against
    // it from outside the page context — the handler body cannot
    // close over node-side variables.
    await tauri.handle("pty_write", (args) => {
      const w = window as unknown as {
        __ACORN_PTY_WRITES__?: { sessionId: string; data: string }[];
      };
      w.__ACORN_PTY_WRITES__ = w.__ACORN_PTY_WRITES__ ?? [];
      const input = (args ?? {}) as { sessionId?: string; data?: string };
      const decoded = input.data
        ? new TextDecoder().decode(
            Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0)),
          )
        : "";
      w.__ACORN_PTY_WRITES__.push({
        sessionId: input.sessionId ?? "",
        data: decoded,
      });
      return undefined;
    });
    await tauri.handle("acknowledge_claude_resume", (args) => {
      const w = window as unknown as {
        __ACORN_ACKED__?: string[];
      };
      w.__ACORN_ACKED__ = w.__ACORN_ACKED__ ?? [];
      const input = (args ?? {}) as { sessionId?: string };
      if (input.sessionId) w.__ACORN_ACKED__.push(input.sessionId);
      return undefined;
    });

    await page.goto("/");

    // The seeded session becomes activeSessionId on reconcile, so
    // App.tsx's effect fires the resume probes at boot and the modal
    // surfaces immediately — no explicit focus click needed.
    const modal = page.getByRole("dialog", {
      name: /Resume previous conversation/,
    });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(CANDIDATE_UUID);
    await expect(modal).toContainText("Preview of the previous conversation");
    await expect(modal).toContainText("Claude");

    await modal.getByRole("button", { name: /Resume/ }).click();
    await expect(modal).toBeHidden();

    const writes = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ACORN_PTY_WRITES__?: { sessionId: string; data: string }[];
          }
        ).__ACORN_PTY_WRITES__ ?? [],
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionId).toBe(SESSION.id);
    expect(writes[0].data).toBe(`claude --resume ${CANDIDATE_UUID}\r`);

    const acked = await page.evaluate(
      () =>
        (window as unknown as { __ACORN_ACKED__?: string[] }).__ACORN_ACKED__ ??
        [],
    );
    // Resume is the one button that does NOT ack — the user signalled
    // they want to keep working with this conversation, so subsequent
    // exits should re-offer the modal at the next cold boot.
    expect(acked).not.toContain(SESSION.id);
  });

  test("focusing a session with a codex candidate dispatches `codex resume`", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);
    await tauri.handle("get_codex_resume_candidate", () => ({
      uuid: "deadbeef-1234-5678-9abc-def012345678",
      lastActivityUnix: Math.floor(Date.now() / 1000) - 120,
      preview: null,
    }));
    await tauri.handle("pty_write", (args) => {
      const w = window as unknown as {
        __ACORN_PTY_WRITES__?: { sessionId: string; data: string }[];
      };
      w.__ACORN_PTY_WRITES__ = w.__ACORN_PTY_WRITES__ ?? [];
      const input = (args ?? {}) as { sessionId?: string; data?: string };
      const decoded = input.data
        ? new TextDecoder().decode(
            Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0)),
          )
        : "";
      w.__ACORN_PTY_WRITES__.push({
        sessionId: input.sessionId ?? "",
        data: decoded,
      });
      return undefined;
    });
    await tauri.handle("acknowledge_codex_resume", (args) => {
      const w = window as unknown as { __ACORN_CODEX_ACKED__?: string[] };
      w.__ACORN_CODEX_ACKED__ = w.__ACORN_CODEX_ACKED__ ?? [];
      const input = (args ?? {}) as { sessionId?: string };
      if (input.sessionId) w.__ACORN_CODEX_ACKED__.push(input.sessionId);
      return undefined;
    });

    await page.goto("/");

    const modal = page.getByRole("dialog", {
      name: /Resume previous conversation/,
    });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Codex");
    await modal.getByRole("button", { name: /Resume/ }).click();
    await expect(modal).toBeHidden();

    const writes = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ACORN_PTY_WRITES__?: { sessionId: string; data: string }[];
          }
        ).__ACORN_PTY_WRITES__ ?? [],
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toBe(`codex resume ${CANDIDATE_UUID}\r`);

    const acked = await page.evaluate(
      () =>
        (window as unknown as { __ACORN_CODEX_ACKED__?: string[] })
          .__ACORN_CODEX_ACKED__ ?? [],
    );
    // Same rule as the claude case: Resume must not ack.
    expect(acked).not.toContain(SESSION.id);
  });

  test("Cancel writes a shell-comment hint with the resume command", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);
    await tauri.handle("get_claude_resume_candidate", () => ({
      uuid: "deadbeef-1234-5678-9abc-def012345678",
      lastActivityUnix: Math.floor(Date.now() / 1000) - 60,
      preview: null,
    }));
    await tauri.handle("pty_write", (args) => {
      const w = window as unknown as {
        __ACORN_PTY_WRITES__?: { sessionId: string; data: string }[];
      };
      w.__ACORN_PTY_WRITES__ = w.__ACORN_PTY_WRITES__ ?? [];
      const input = (args ?? {}) as { sessionId?: string; data?: string };
      const decoded = input.data
        ? new TextDecoder().decode(
            Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0)),
          )
        : "";
      w.__ACORN_PTY_WRITES__.push({
        sessionId: input.sessionId ?? "",
        data: decoded,
      });
      return undefined;
    });

    await page.goto("/");

    const modal = page.getByRole("dialog", {
      name: /Resume previous conversation/,
    });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toBeHidden();

    const writes = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ACORN_PTY_WRITES__?: { sessionId: string; data: string }[];
          }
        ).__ACORN_PTY_WRITES__ ?? [],
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toBe(`# claude --resume ${CANDIDATE_UUID}\r`);
  });
});
