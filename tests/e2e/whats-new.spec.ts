import { test, expect, pressHotkey } from "./support";

// The base tauriMock returns "0.0.0-test" for plugin:app|version, which is
// what the updater store records as `currentVersion`. The About tab's
// "What's new in {currentVersion}" button echoes that string in its label.
const TEST_VERSION = "0.0.0-test";

async function openAboutTab(page: import("@playwright/test").Page) {
  await page.goto("/");
  await pressHotkey(page, { mod: true, key: "," });
  const modal = page.getByRole("dialog", { name: /Settings/i });
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "About", exact: true }).click();
  await expect(
    modal.getByRole("heading", { name: "About Acorn" }),
  ).toBeVisible();
  return modal;
}

test.describe("about tab: what's new button", () => {
  test("renders a 'What's new in {currentVersion}' button on the About tab", async ({
    page,
  }) => {
    const modal = await openAboutTab(page);

    await expect(
      modal.getByRole("button", {
        name: new RegExp(`What's new in ${TEST_VERSION}`),
      }),
    ).toBeVisible();
  });

  test("clicking the button fetches release notes from GitHub and opens the modal", async ({
    page,
  }) => {
    // Mock GitHub Releases API at the network layer so the fetch in
    // src/lib/releases.ts hits a deterministic payload.
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/tags/v0.0.0-test",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tag_name: "v0.0.0-test",
            body: "## Highlights\n\n- Test release body",
            html_url: "https://github.com/im-ian/acorn/releases/tag/v0.0.0-test",
            published_at: "2026-05-11T07:00:00Z",
          }),
        });
      },
    );

    const modal = await openAboutTab(page);
    await modal
      .getByRole("button", {
        name: new RegExp(`What's new in ${TEST_VERSION}`),
      })
      .click();

    const dialog = page.getByRole("dialog", {
      name: new RegExp(`What's new in Acorn ${TEST_VERSION}`),
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Test release body/)).toBeVisible();
    // The "current version" subtitle should NOT show the running-version
    // hint because the modal is showing notes for the running version
    // itself ("you're on this version").
    await expect(dialog.getByText(/you're on this version/i)).toBeVisible();
    // No install action on the current-version flow.
    await expect(
      dialog.getByRole("button", { name: /Install & relaunch/i }),
    ).toHaveCount(0);
    // External link to the release page is available.
    await expect(
      dialog.getByRole("link", { name: /View on GitHub/i }),
    ).toHaveAttribute(
      "href",
      "https://github.com/im-ian/acorn/releases/tag/v0.0.0-test",
    );
  });

  test("falls back to the latest release when the running version has no public tag", async ({
    page,
    errorTracker,
  }) => {
    // Chromium logs a "Failed to load resource: 404" console.error for
    // any 4xx response regardless of how the app handles it. That's a
    // network-layer artifact, not an app bug.
    errorTracker.allow(/Failed to load resource/);
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/tags/v0.0.0-test",
      async (route) => {
        await route.fulfill({ status: 404, body: "not found" });
      },
    );
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/latest",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tag_name: "v1.0.7",
            body: "## v1.0.7\n\n- public release body",
            html_url: "https://github.com/im-ian/acorn/releases/tag/v1.0.7",
            published_at: "2026-05-11T01:59:13Z",
          }),
        });
      },
    );

    const modal = await openAboutTab(page);
    await modal
      .getByRole("button", {
        name: new RegExp(`What's new in ${TEST_VERSION}`),
      })
      .click();

    const dialog = page.getByRole("dialog", {
      name: /What's new in Acorn 1\.0\.7/,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/public release body/)).toBeVisible();
    await expect(
      dialog.getByText(
        new RegExp(`latest published .* no public release for ${TEST_VERSION}`),
      ),
    ).toBeVisible();
  });

  test("surfaces a network/rate-limit error inline without opening the modal", async ({
    page,
    errorTracker,
  }) => {
    // Same Chromium-level network warning as the 404 case — plus our own
    // inline error rendering.
    errorTracker.allow(/Failed to load resource/);
    errorTracker.allow(/GitHub releases request failed/);
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/tags/v0.0.0-test",
      async (route) => {
        await route.fulfill({ status: 403, body: "rate limit" });
      },
    );

    const modal = await openAboutTab(page);
    await modal
      .getByRole("button", {
        name: new RegExp(`What's new in ${TEST_VERSION}`),
      })
      .click();

    await expect(modal.getByText(/GitHub releases request failed: 403/)).toBeVisible();
    // The dialog must not have opened on failure.
    await expect(
      page.getByRole("dialog", { name: /What's new in Acorn/ }),
    ).toHaveCount(0);
  });
});
