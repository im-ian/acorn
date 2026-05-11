import { test, expect, pressHotkey } from "./support";

test.describe("control session: settings install section", () => {
  test("renders bundled path + install command when no shim is present", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("get_acorn_ipc_status", {
      bundled_path: "/Applications/Acorn.app/Contents/MacOS/acorn-ipc",
      bundled_exists: true,
      socket_path: "/Users/me/Library/Application Support/io.im-ian.acorn/ipc.sock",
      shim_paths: [
        { path: "/usr/local/bin/acorn-ipc", exists: false },
        { path: "/opt/homebrew/bin/acorn-ipc", exists: false },
      ],
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });
    const modal = page.getByRole("dialog", { name: /Settings/i });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Sessions", exact: true }).click();

    // The section heading is the visible label of the Field wrapping the
    // install card. Matching on the field label keeps us decoupled from
    // the underlying div nesting.
    await expect(
      modal.getByText(/Control sessions \(acorn-ipc CLI\)/i),
    ).toBeVisible();

    // Bundled binary status badge reflects the mock. Match the badge
    // exactly so we do not collide with the install-command line that
    // also includes the path. Strict-mode mandates a single match.
    await expect(modal.getByText("found", { exact: true })).toBeVisible();
    // The bundled path appears verbatim in its own `<code>` element. Using
    // `exact: true` keeps it from matching the install command, where the
    // path is embedded inside `sudo ln -sf "..."`.
    await expect(
      modal.getByText("/Applications/Acorn.app/Contents/MacOS/acorn-ipc", {
        exact: true,
      }),
    ).toBeVisible();

    // Install card surfaces the "not installed" badge and the symlink
    // command. The command target is the first shim path (`/usr/local/bin/...`).
    await expect(
      modal.getByText("not installed", { exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByText(
        /sudo ln -sf "\/Applications\/Acorn\.app\/Contents\/MacOS\/acorn-ipc"/,
      ),
    ).toBeVisible();
  });

  test("renders 'installed' badge and hides the install command when a shim exists", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("get_acorn_ipc_status", {
      bundled_path: "/Applications/Acorn.app/Contents/MacOS/acorn-ipc",
      bundled_exists: true,
      socket_path: "/Users/me/Library/Application Support/io.im-ian.acorn/ipc.sock",
      shim_paths: [
        { path: "/usr/local/bin/acorn-ipc", exists: true },
        { path: "/opt/homebrew/bin/acorn-ipc", exists: false },
      ],
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });
    const modal = page.getByRole("dialog", { name: /Settings/i });
    await modal.getByRole("button", { name: "Sessions", exact: true }).click();

    // Match the badge text exactly so we don't collide with the
    // "Installed shim" label that lives in the same card.
    await expect(modal.getByText("installed", { exact: true })).toBeVisible();
    // The install command block is suppressed when a shim is already in place,
    // so the `sudo ln -sf` text must NOT be visible.
    await expect(
      modal.getByText(/sudo ln -sf/),
    ).toHaveCount(0);
  });

  test("shows a 'missing' badge when the bundled binary is not present", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("get_acorn_ipc_status", {
      bundled_path: "/Applications/Acorn.app/Contents/MacOS/acorn-ipc",
      bundled_exists: false,
      socket_path: "",
      shim_paths: [{ path: "/usr/local/bin/acorn-ipc", exists: false }],
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });
    const modal = page.getByRole("dialog", { name: /Settings/i });
    await modal.getByRole("button", { name: "Sessions", exact: true }).click();

    await expect(modal.getByText("missing", { exact: true })).toBeVisible();
    // No install command should render when the binary is absent — there
    // is nothing to symlink to.
    await expect(modal.getByText(/sudo ln -sf/)).toHaveCount(0);
  });
});
