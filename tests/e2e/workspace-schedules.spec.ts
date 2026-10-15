import { expect, test } from "./support";

test("a schedule can be created and its board tab opened from the list", async ({
  page,
  tauri,
}) => {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => [
    {
      id: "s-1",
      name: "sess",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
  // The list starts empty and the created row is served back on the next read,
  // so the board tab has something to resolve its schedule id against.
  await tauri.handle("list_project_schedules", () => {
    const store = (
      window as typeof window & { __scheduleCreated?: unknown[] }
    ).__scheduleCreated;
    return store ?? [];
  });
  await tauri.handle("create_project_schedule", (args) => {
    const input = args as {
      name?: string;
      prompt?: string;
      trigger?: unknown;
      mode?: string;
      background?: boolean;
    };
    const created = {
      id: "schedule-1",
      name: input.name ?? "",
      prompt: input.prompt ?? "",
      trigger: input.trigger ?? { kind: "daily", time: "09:00" },
      mode: input.mode ?? "session",
      background: input.background ?? false,
      created_at: "2026-01-01T00:00:00Z",
      last_run_at: null,
      last_slot_at: null,
      runs: [
        {
          id: "run-1",
          started_at: "2026-01-01T09:00:00Z",
          session_id: "s-1",
          worktree_path: "/tmp/demo",
          summary_path: "/tmp/demo/.acorn/schedule-summaries/run-1.md",
          summary_ready: true,
          error: null,
        },
      ],
    };
    (
      window as typeof window & { __scheduleCreated?: unknown[] }
    ).__scheduleCreated = [created];
    return created;
  });

  await tauri.handle("clear_project_schedule_runs", () => {
    const holder = window as typeof window & {
      __scheduleCreated?: { runs: unknown[] }[];
    };
    const stored = holder.__scheduleCreated ?? [];
    const cleared = stored.map((item) => ({ ...item, runs: [] }));
    holder.__scheduleCreated = cleared;
    return cleared[0];
  });

  await tauri.handle("fs_read_file", () => ({
    content: "## Result\nall clear\n",
    size: 24,
    truncated: false,
    binary: false,
  }));

  await page.goto("/");

  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await groups.getByRole("button", { name: "Workspace" }).click();
  await panel.getByRole("button", { name: "Schedules" }).click();
  await expect(panel.getByText("No schedules yet")).toBeVisible();

  await panel.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New schedule" });
  await editor.getByLabel("Name").fill("Nightly audit");
  await editor.getByLabel("Repeat", { exact: true }).selectOption("daily");
  await editor.getByLabel("Time").fill("09:30");
  await editor.getByLabel("Run as").selectOption("oneshot");
  // The daemon is off in the shared mock, so the background option explains
  // itself instead of offering a run that has nowhere to live.
  const backgroundBox = editor.getByRole("checkbox", {
    name: /Run in the background/,
  });
  await expect(backgroundBox).toBeDisabled();
  await expect(
    editor.getByText(
      "Needs the acornd daemon, which is off in Settings → Background sessions.",
    ),
  ).toBeVisible();
  await editor.getByLabel("Agent prompt").fill("Review open dependencies");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  const row = panel.getByRole("button", { name: /Nightly audit/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("Daily 09:30")).toBeVisible();

  await row.click();
  // The board tab lands in the focused pane with the schedule's prompt and the
  // run that links back to its session.
  await expect(page.getByText("Review open dependencies")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume session" }),
  ).toBeVisible();

  // The run links to the summary the agent was asked to write; until that file
  // lands the board says so rather than showing an empty report.
  // The badge is the run's headline state; SUCCESS means the agent got as far
  // as writing its summary.
  await expect(page.getByText("SUCCESS", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Summary" }).click();
  const summary = page.getByRole("dialog", { name: /Work summary/ });
  await expect(summary.getByText("all clear")).toBeVisible();

  // The summary is the run's deliverable, so it has to be liftable out of the
  // modal; the button confirms in place.
  await summary.getByRole("button", { name: "Copy" }).click();
  await expect(summary.getByRole("button", { name: "Copied" })).toBeVisible();
  await summary.getByRole("button", { name: "Close" }).click();

  // Each run can be dropped on its own, not just as a whole history.
  await page
    .getByRole("button", { name: "Delete this run" })
    .first()
    .click();
  await expect(page.getByText("No runs yet.")).toBeVisible();

  // Summaries are files, so the board can drop a schedule's whole history —
  // records and summary files together — behind a confirmation.
});

test("a background schedule is offered once the daemon is on", async ({
  page,
  tauri,
}) => {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => []);
  await tauri.handle("daemon_status", () => ({
    running: true,
    enabled: true,
    daemon_version: "1.40.0",
    uptime_seconds: 10,
    session_count_total: 0,
    session_count_alive: 0,
    log_path: null,
    last_error: null,
  }));
  await tauri.handle("list_project_schedules", () => {
    const holder = window as typeof window & { __bgSchedule?: unknown[] };
    return holder.__bgSchedule ?? [];
  });
  await tauri.handle("create_project_schedule", (args) => {
    const input = args as { name?: string; background?: boolean };
    const created = {
      id: "schedule-bg",
      name: input.name ?? "",
      prompt: "watch the queue",
      trigger: { kind: "interval", every_minutes: 30 },
      mode: "oneshot",
      background: input.background ?? false,
      created_at: "2026-01-01T00:00:00Z",
      last_run_at: null,
      last_slot_at: null,
      runs: [],
    };
    (window as typeof window & { __bgSchedule?: unknown[] }).__bgSchedule = [
      created,
    ];
    return created;
  });

  await page.goto("/");

  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await groups.getByRole("button", { name: "Workspace" }).click();
  await panel.getByRole("button", { name: "Schedules" }).click();

  await panel.getByRole("button", { name: "New", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New schedule" });
  await editor.getByLabel("Name").fill("Queue watch");
  await editor.getByLabel("Repeat", { exact: true }).selectOption("interval");
  await editor.getByLabel("Agent prompt").fill("watch the queue");
  const backgroundBox = editor.getByRole("checkbox", {
    name: /Run in the background/,
  });
  await expect(backgroundBox).toBeEnabled();
  // The hint has to say what the option is for, since the trade-off (no tab,
  // report only) decides whether a job suits it.
  await expect(
    editor.getByText(/Best for one-off jobs that just report/),
  ).toBeVisible();

  const modeSelect = editor.getByLabel("Run as");
  await modeSelect.selectOption("session");
  await backgroundBox.check();
  // Background forces one-shot, so the form stops offering the choice rather
  // than letting the backend silently override it.
  await expect(modeSelect).toBeDisabled();
  await expect(modeSelect).toHaveValue("oneshot");
  await expect(
    editor.getByText("A background schedule always runs one-shot."),
  ).toBeVisible();

  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  // The row is tagged so a schedule that never opens a tab is still
  // recognisable in the list.
  await expect(panel.getByText("background", { exact: true })).toBeVisible();
  await expect(panel.getByText("Every 30m")).toBeVisible();
});

test("a schedule can be edited and its whole run history cleared", async ({
  page,
  tauri,
}) => {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => []);
  await tauri.handle("list_project_schedules", () => {
    const holder = window as typeof window & { __editSchedule?: unknown[] };
    if (!holder.__editSchedule) {
      holder.__editSchedule = [
        {
          id: "schedule-1",
          name: "Nightly audit",
          prompt: "Review open dependencies",
          trigger: { kind: "daily", time: "09:30" },
          mode: "session",
          background: false,
          created_at: "2026-01-01T00:00:00Z",
          last_run_at: "2026-01-01T09:30:00Z",
        last_slot_at: "2026-01-01T09:30:00Z",
          last_slot_at: "2026-01-01T09:30:00Z",
          runs: [
            {
              id: "run-1",
              started_at: "2026-01-01T09:30:00Z",
              session_id: null,
              worktree_path: "/tmp/demo",
              summary_path: "/tmp/demo/.acorn/schedule-summaries/run-1.md",
              summary_ready: true,
              error: null,
            },
          ],
        },
      ];
    }
    return holder.__editSchedule;
  });
  await tauri.handle("update_project_schedule", (args) => {
    const input = args as {
      patch?: {
        name?: string;
        prompt?: string;
        trigger?: unknown;
        mode?: string;
        background?: boolean;
      };
    };
    const holder = window as typeof window & {
      __editSchedule?: Record<string, unknown>[];
    };
    const current = (holder.__editSchedule ?? [])[0] ?? {};
    const next = { ...current, ...(input.patch ?? {}) };
    holder.__editSchedule = [next];
    return next;
  });
  await tauri.handle("clear_project_schedule_runs", () => {
    const holder = window as typeof window & {
      __editSchedule?: Record<string, unknown>[];
    };
    const current = (holder.__editSchedule ?? [])[0] ?? {};
    const next = { ...current, runs: [] };
    holder.__editSchedule = [next];
    return next;
  });

  await page.goto("/");

  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await groups.getByRole("button", { name: "Workspace" }).click();
  await panel.getByRole("button", { name: "Schedules" }).click();

  const row = panel.getByRole("button", { name: /Nightly audit/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("Daily 09:30")).toBeVisible();

  // Editing reopens the same form prefilled, so a schedule is not
  // delete-and-recreate to change.
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editor = page.getByRole("dialog", { name: "Edit schedule" });
  await expect(editor.getByLabel("Name")).toHaveValue("Nightly audit");
  await expect(editor.getByLabel("Agent prompt")).toHaveValue(
    "Review open dependencies",
  );
  await editor.getByLabel("Repeat", { exact: true }).selectOption("interval");
  await editor.getByLabel("Minutes").fill("90");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByText("Every 1h 30m")).toBeVisible();

  await panel.getByRole("button", { name: /Nightly audit/ }).click();
  await page.getByRole("button", { name: "Clear history" }).click();
  const confirm = page.getByRole("dialog", {
    name: /Clear this schedule's run history/,
  });
  await confirm.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("No runs yet.")).toBeVisible();

  // The board carries the same edit affordance as the list, so a schedule open
  // in a pane does not have to be found in the sidebar again to change it.
  const board = page.locator("[data-pane-body]");
  await board.getByRole("button", { name: "Edit" }).click();
  const boardEditor = page.getByRole("dialog", { name: "Edit schedule" });
  await boardEditor.getByLabel("Name").fill("Renamed from the board");
  await boardEditor.getByRole("button", { name: "Save" }).click();
  await expect(boardEditor).toHaveCount(0);
  await expect(board.getByText("Renamed from the board")).toBeVisible();

  // Deleting from the board closes the tab, since there is nothing left to show.
  await board.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteConfirm = page.getByRole("dialog", {
    name: /Delete this schedule/,
  });
  await deleteConfirm
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByText("Review open dependencies")).toHaveCount(0);
});

test("an open board picks up a new run and follows it to SUCCESS", async ({
  page,
  tauri,
}) => {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => [
    {
      id: "s-run",
      name: "Queue watch · 09:30",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "working",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message: null,
    },
  ]);
  // The run's summary lands a few seconds in, keyed off wall-clock rather than
  // a call counter: the scheduler's own startup tick also lists schedules, so
  // the number of reads before the board mounts is not something to count on.
  await tauri.handle("list_project_schedules", () => {
    const holder = window as typeof window & { __runStartedAt?: number };
    holder.__runStartedAt ??= Date.now();
    return [
      {
        id: "schedule-live",
        name: "Queue watch",
        prompt: "watch the queue",
        trigger: { kind: "interval", every_minutes: 30 },
        mode: "session",
        background: false,
        created_at: "2026-01-01T00:00:00Z",
        // Recent, so the scheduler never finds this due and launches a real
        // session underneath the test.
        last_run_at: new Date(holder.__runStartedAt).toISOString(),
        last_slot_at: new Date(holder.__runStartedAt).toISOString(),
        runs: [
          {
            id: "run-live",
            started_at: new Date(holder.__runStartedAt).toISOString(),
            session_id: "s-run",
            worktree_path: "/tmp/demo",
            summary_path: "/tmp/demo/.acorn/schedule-summaries/run-live.md",
            summary_ready: Date.now() - holder.__runStartedAt > 3_000,
            error: null,
          },
        ],
      },
    ];
  });

  await page.goto("/");

  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await groups.getByRole("button", { name: "Workspace" }).click();
  await panel.getByRole("button", { name: "Schedules" }).click();
  await panel.getByRole("button", { name: /Queue watch/ }).click();

  await expect(page.getByText("watch the queue")).toBeVisible();

  // The board polls while a run is in flight, so both states arrive on their
  // own — no refresh click in this test.
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
  await expect(page.getByText("SUCCESS", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Summary" })).toBeVisible();
});
