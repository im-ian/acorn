import { test, expect, pressHotkey } from "./support";

const SETTINGS_DIALOG_NAME = /^(Settings|설정)$/;

const NOTE_CSS = `/* @mode light */
:root[data-acorn-theme="note"] {
  --color-bg: #f7f1e1;
  --color-bg-elevated: #eee5cf;
  --color-bg-sidebar: #e5dbc3;
  --color-fg: #2c2922;
  --color-fg-muted: #756e60;
  --color-border: #c9bda4;
  --color-accent: #244e8a;
  --color-accent-hover: #183d70;
  --color-danger: #a33f35;
  --color-warning: #a56b20;
  --color-terminal-bg: #f7f0df;
  --color-terminal-fg: #29261f;
}`;

test.describe("settings modal", () => {
  test("opens with $mod+, and closes with Escape", async ({ page }) => {
    await page.goto("/");

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal).toHaveCount(0);

    await pressHotkey(page, { mod: true, key: "," });
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /^(Terminal|터미널)$/ }),
    ).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /^(Agents|에이전트)$/ }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });

  test("clicking the close button dismisses the modal", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: /close/i }).first().click();
    await expect(modal).toHaveCount(0);
  });

  test("downloads, selects, and removes a catalog theme", async ({
    page,
    tauri,
  }) => {
    await page.route(
      "https://raw.githubusercontent.com/im-ian/acorn-themes/main/manifest.json",
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            themes: [
              {
                id: "note",
                label: "Note",
                mode: "light",
                version: 1,
                file: "themes/note.css",
              },
            ],
          }),
        }),
    );
    await page.route(
      "https://raw.githubusercontent.com/im-ian/acorn-themes/main/themes/note.css",
      (route) => route.fulfill({ contentType: "text/css", body: NOTE_CSS }),
    );
    await tauri.handle("plugin:fs|exists", (args) => {
      const path = String((args as { path?: string })?.path ?? "");
      const state = window as unknown as {
        __themeInstalled?: boolean;
      };
      if (path.endsWith(".catalog.json") || path.endsWith("note.css")) {
        return Boolean(state.__themeInstalled);
      }
      return true;
    });
    await tauri.handle("plugin:fs|read_dir", () => {
      const state = window as unknown as { __themeInstalled?: boolean };
      return state.__themeInstalled
        ? [{ name: "note.css", isFile: true, isDirectory: false, isSymlink: false }]
        : [];
    });
    await tauri.handle("plugin:fs|read_text_file", (args) => {
      const path = String((args as { path?: string })?.path ?? "");
      if (path.endsWith(".catalog.json")) {
        const metadata = JSON.stringify({
          schemaVersion: 1,
          installed: {
            note: {
              label: "Note",
              mode: "light",
              version: 1,
              file: "note.css",
            },
          },
        });
        return Array.from(new TextEncoder().encode(metadata));
      }
      const css = `/* @mode light */
:root[data-acorn-theme="note"] {
  --color-bg: #f7f1e1;
  --color-bg-elevated: #eee5cf;
  --color-bg-sidebar: #e5dbc3;
  --color-fg: #2c2922;
  --color-fg-muted: #756e60;
  --color-border: #c9bda4;
  --color-accent: #244e8a;
  --color-accent-hover: #183d70;
  --color-danger: #a33f35;
  --color-warning: #a56b20;
  --color-terminal-bg: #f7f0df;
  --color-terminal-fg: #29261f;
}`;
      return Array.from(new TextEncoder().encode(css));
    });
    await tauri.handle("plugin:fs|write_text_file", () => {
      const state = window as unknown as {
        __themeInstalled?: boolean;
        __themeRemoving?: boolean;
      };
      if (!state.__themeRemoving) state.__themeInstalled = true;
      return undefined;
    });
    await tauri.handle("plugin:fs|remove", () => {
      const state = window as unknown as {
        __themeInstalled?: boolean;
        __themeRemoving?: boolean;
      };
      state.__themeInstalled = false;
      state.__themeRemoving = true;
      return undefined;
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Themes|테마)$/ }).click();

    const themeSelect = modal.getByRole("combobox", {
      name: /^(Theme|테마)$/,
    });
    await themeSelect.click();
    await expect(page.getByRole("option")).toHaveCount(4);
    await expect(page.getByRole("option", { name: "Note" })).toHaveCount(0);
    await page
      .getByRole("option", { name: "Acorn Dark Green", exact: true })
      .click();

    const noteRow = modal.getByRole("listitem").filter({ hasText: "Note" });
    await expect(noteRow).toContainText(/Available to download|다운로드 가능/);
    await noteRow.getByRole("button", { name: /^(Download|다운로드)$/ }).click();
    await expect(noteRow).toContainText(/Downloaded|다운로드됨/);

    await themeSelect.click();
    await page.getByRole("option", { name: "Note", exact: true }).click();
    await expect(themeSelect).toContainText("Note");
    await expect
      .poll(() =>
        page.evaluate(() => ({
          id: document.documentElement.getAttribute("data-acorn-theme"),
          accent: getComputedStyle(document.documentElement)
            .getPropertyValue("--color-accent")
            .trim(),
        })),
      )
      .toEqual({ id: "note", accent: "#244e8a" });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).appearance?.themeId : null;
        }),
      )
      .toBe("note");

    await noteRow.getByRole("button", { name: /^(Remove|삭제)$/ }).click();
    await expect(noteRow).toContainText(/Available to download|다운로드 가능/);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.getAttribute("data-acorn-theme"),
        ),
      )
      .toBe("acorn-dark");
  });

  test("adjusts terminal letter spacing and persists it", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Terminal|터미널)$/ }).click();

    const field = modal
      .getByText("Letter spacing", { exact: true })
      .locator("..");
    const valueInput = field.getByRole("textbox", { name: /^(Value|값)$/ });
    await expect(valueInput).toHaveValue("0");
    await expect(field).toContainText("px");

    await valueInput.fill("0.75");
    await valueInput.press("Enter");

    await expect(valueInput).toHaveValue("0.75");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).terminal?.letterSpacing : null;
        }),
      )
      .toBe(0.75);
  });

  test("adjusts terminal line height and persists it", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Terminal|터미널)$/ }).click();

    const field = modal.getByText("Line height", { exact: true }).locator("..");
    const valueInput = field.getByRole("textbox", { name: /^(Value|값)$/ });
    await expect(valueInput).toHaveValue("1.00");

    await valueInput.fill("1.35");
    await valueInput.press("Enter");

    await expect(valueInput).toHaveValue("1.35");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).terminal?.lineHeight : null;
        }),
      )
      .toBe(1.35);
  });

  test("changes terminal anti-aliasing and persists it", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Terminal|터미널)$/ }).click();

    const select = modal.getByRole("combobox", {
      name: /^(Anti-aliasing|안티앨리어싱)$/,
    });
    await expect(select).toContainText("Grayscale");

    await select.click();
    await page.getByRole("option", { name: "Subpixel" }).click();

    await expect(select).toContainText("Subpixel");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).terminal?.fontSmoothing : null;
        }),
      )
      .toBe("subpixel");
  });

  test("registers terminal font presets and applies them later", async ({
    page,
  }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Terminal|터미널)$/ }).click();

    const presetSelect = modal.getByRole("combobox", {
      name: /^(Saved font preset|저장된 글꼴 프리셋)$/,
    });
    await expect(presetSelect).toContainText("No saved presets");

    await modal
      .getByRole("textbox", {
        name: /^(Preset name|프리셋 이름)$/,
      })
      .fill("Default copy");
    await modal
      .getByRole("button", {
        name: /^(Save current|현재 설정 저장)$/,
      })
      .click();

    await expect(presetSelect).toContainText("Default copy");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          const settings = raw ? JSON.parse(raw) : null;
          return settings?.fontPresets?.terminal?.[0] ?? null;
        }),
      )
      .toMatchObject({
        id: "font-default-copy",
        name: "Default copy",
        settings: {
          fontSize: 12,
          letterSpacing: 0,
          lineHeight: 1,
        },
        experiments: {
          cjkCellWidthHeuristic: false,
        },
      });

    const fontSizeField = modal
      .getByText("Font size", { exact: true })
      .locator("..");
    const fontSizeInput = fontSizeField.getByRole("textbox", {
      name: /^(Value|값)$/,
    });
    await fontSizeInput.fill("14");
    await fontSizeInput.press("Enter");

    await expect(presetSelect).toContainText("Custom");

    await presetSelect.click();
    await page.getByRole("option", { name: "Default copy" }).click();

    await expect(presetSelect).toContainText("Default copy");
    await expect(fontSizeInput).toHaveValue("12");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          const settings = raw ? JSON.parse(raw) : null;
          return settings?.terminal?.fontSize ?? null;
        }),
      )
      .toBe(12);
  });

  test("changes kanban terminal popover settings and persists them", async ({
    page,
  }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal.getByText("Kanban terminal popover")).toBeVisible();

    await modal
      .getByText("Open new session terminals immediately", { exact: true })
      .click();
    await modal.getByText("Center of screen", { exact: true }).click();
    await modal.getByText("Full screen", { exact: true }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          const settings = raw ? JSON.parse(raw) : null;
          return {
            placement:
              settings?.interface?.kanbanTerminalPopoverPlacement ?? null,
            defaultSize:
              settings?.interface?.kanbanTerminalPopoverDefaultSize ?? null,
            openOnCreate:
              settings?.interface?.openKanbanTerminalOnSessionCreate ?? null,
          };
        }),
      )
      .toEqual({
        placement: "center",
        defaultSize: "fullscreen",
        openOnCreate: true,
      });
  });

  test("records a custom shortcut and reset all restores defaults", async ({
    page,
  }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Shortcuts|단축키)$/ }).click();

    await modal
      .getByRole("button", {
        name: "Record shortcut for Increase UI scale",
      })
      .click();
    await expect(modal.getByText("Press keys")).toBeVisible();

    await pressHotkey(page, { mod: true, alt: true, key: "u" });
    await expect(modal.getByText(/⌥⌘U|Ctrl\+Alt\+U/)).toBeVisible();

    await modal.getByRole("button", { name: /close/i }).first().click();
    await expect(modal).toHaveCount(0);

    await pressHotkey(page, { mod: true, alt: true, key: "u" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.05");

    await pressHotkey(page, { mod: true, key: "," });
    await modal.getByRole("button", { name: /^(Shortcuts|단축키)$/ }).click();
    await modal
      .getByRole("button", { name: "Reset all shortcuts" })
      .click();
    await expect(modal.getByText(/⌘=|Ctrl\+=/).first()).toBeVisible();
  });

  test("records a custom pane focus shortcut", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Shortcuts|단축키)$/ }).click();

    await expect(modal.getByText("Focus pane to the left")).toBeVisible();
    await expect(modal.getByText("Focus pane to the right")).toBeVisible();
    await expect(modal.getByText("Focus pane above")).toBeVisible();
    await expect(modal.getByText("Focus pane below")).toBeVisible();
    await expect(modal.getByText("Find in current view")).toBeVisible();
    await expect(modal.getByText("Rename selected item")).toBeVisible();

    await modal
      .getByRole("button", {
        name: "Record shortcut for Focus pane to the left",
      })
      .click();
    await expect(modal.getByText("Press keys")).toBeVisible();

    await pressHotkey(page, { mod: true, alt: true, key: "u" });
    await expect(modal.getByText(/⌥⌘U|Ctrl\+Alt\+U/)).toBeVisible();
  });

  test("syncs the keep-awake toggle with the backend and local settings", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ power: { preventSleep: true } }),
      );
      (window as typeof window & { __ACORN_PREVENT_SLEEP_CALLS__?: boolean[] })
        .__ACORN_PREVENT_SLEEP_CALLS__ = [];
    });
    await tauri.handle("set_prevent_sleep", (args) => {
      const win = window as typeof window & {
        __ACORN_PREVENT_SLEEP_CALLS__?: boolean[];
      };
      const enabled =
        !!args &&
        typeof args === "object" &&
        "enabled" in args &&
        !!args.enabled;
      win.__ACORN_PREVENT_SLEEP_CALLS__ =
        win.__ACORN_PREVENT_SLEEP_CALLS__ || [];
      win.__ACORN_PREVENT_SLEEP_CALLS__.push(enabled);
      return { supported: true, enabled };
    });

    await page.goto("/");

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & {
              __ACORN_PREVENT_SLEEP_CALLS__?: boolean[];
            }).__ACORN_PREVENT_SLEEP_CALLS__ ?? [],
        ),
      )
      .toEqual([true]);

    await pressHotkey(page, { mod: true, key: "," });
    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Sessions|세션)$/ }).click();

    const checkbox = modal.getByRole("checkbox", {
      name: /Keep this Mac awake|이 Mac 잠자기 방지/,
    });
    await expect(checkbox).toBeChecked();
    await checkbox.click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & {
              __ACORN_PREVENT_SLEEP_CALLS__?: boolean[];
            }).__ACORN_PREVENT_SLEEP_CALLS__ ?? [],
        ),
      )
      .toEqual([true, false]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).power?.preventSleep : null;
        }),
      )
      .toBe(false);
  });

  test("toggles the working-session close warning from Sessions settings", async ({
    page,
  }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Sessions|세션)$/ }).click();

    const checkbox = modal.getByRole("checkbox", {
      name: /Show warning before closing working sessions|작업 중인 세션을 닫기 전에 경고 표시/,
    });
    await expect(checkbox).toBeChecked();
    await checkbox.click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).sessions?.warnBeforeClosingRunning : null;
        }),
      )
      .toBe(false);
  });

  test("resets macOS privacy permissions from Settings", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("reset_macos_developer_permissions", () => {
      const w = window as unknown as { __permissionResetCalls?: number };
      w.__permissionResetCalls = (w.__permissionResetCalls ?? 0) + 1;
      return [
        {
          id: "screen_capture",
          service: "ScreenCapture",
          status: "reset",
          error: null,
        },
        {
          id: "accessibility",
          service: "Accessibility",
          status: "reset",
          error: null,
        },
        {
          id: "app_data",
          service: "SystemPolicyAppData",
          status: "reset",
          error: null,
        },
      ];
    });
    await tauri.handle("warm_macos_folder_permissions", () => {
      const w = window as unknown as { __permissionWarmupCalls?: number };
      w.__permissionWarmupCalls = (w.__permissionWarmupCalls ?? 0) + 1;
      return [
        {
          id: "desktop",
          path: "/Users/tester/Desktop",
          status: "ok",
          error: null,
        },
      ];
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Permissions|권한)$/ }).click();
    await expect(
      modal.getByRole("heading", { name: /^(Permissions|권한)$/ }),
    ).toBeVisible();
    await expect(
      modal.getByText("Protected folders", { exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByText("Automation and capture", { exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByText("Browser and Playwright media", { exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByText("Screen Recording", { exact: true }),
    ).toBeVisible();
    await expect(modal.getByText("App Data", { exact: true })).toBeVisible();
    await expect(modal.getByText("Camera", { exact: true })).toBeVisible();
    await expect(
      modal.getByText("Prompts when used", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      modal.getByText("Browser-managed", { exact: true }).first(),
    ).toBeVisible();

    await modal.getByRole("button", { name: "Reset permissions" }).click();

    // First click only opens the confirmation notice; nothing is reset yet.
    await expect(
      modal.getByText(/revokes ALL of Acorn's granted macOS permissions/),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __permissionResetCalls?: number })
            .__permissionResetCalls ?? 0,
      ),
    ).toBe(0);

    await modal.getByRole("button", { name: "Reset all permissions" }).click();

    await expect(
      modal.getByText("Folder access was reset and checked."),
    ).toBeVisible();
    await expect(modal.getByText("Desktop", { exact: true })).toBeVisible();
    await expect(modal.getByText("Ready", { exact: true })).toBeVisible();
    await expect(
      modal.getByText("Will ask again", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      modal.getByText("SystemPolicyAppData", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __permissionResetCalls?: number })
              .__permissionResetCalls ?? 0,
        ),
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __permissionWarmupCalls?: number })
              .__permissionWarmupCalls ?? 0,
        ),
      )
      .toBe(1);
  });
});
