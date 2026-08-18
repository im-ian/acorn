import { test, expect } from "./support";

test.describe("update banner", () => {
  test("does not show when the latest release matches the running version", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("plugin:app|version", "1.2.3");
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/latest",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tag_name: "v1.2.3",
            body: "Current release.",
            html_url: "https://github.com/im-ian/acorn/releases/tag/v1.2.3",
            published_at: "2026-01-01T00:00:00Z",
          }),
        }),
    );

    await page.goto("/");

    await expect(page.getByText(/Acorn .* is available/)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /View download/i }),
    ).toHaveCount(0);
  });

  test("shows the banner for a newer canonical GitHub release", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("plugin:app|version", "1.0.0");
    await tauri.handle("open_external_url", (args) => {
      const target = String((args as { url?: unknown })?.url ?? "");
      (window as unknown as { __openedUpdateUrl?: string }).__openedUpdateUrl =
        target;
      return true;
    });
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/latest",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tag_name: "v1.2.3",
            body: "Bug fixes and improvements.",
            html_url: "https://github.com/im-ian/acorn/releases/tag/v1.2.3",
            published_at: "2026-01-01T00:00:00Z",
          }),
        }),
    );

    await page.goto("/");

    await expect(page.getByText(/Acorn 1\.2\.3/)).toBeVisible();
    await expect(page.getByText(/is available\./)).toBeVisible();
    const viewDownload = page.getByRole("button", { name: /View download/i });
    await expect(viewDownload).toBeVisible();
    await expect(
      page.getByRole("button", { name: /What's new/i }),
    ).toBeVisible();

    await viewDownload.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __openedUpdateUrl?: string })
              .__openedUpdateUrl,
        ),
      )
      .toBe("https://github.com/im-ian/acorn/releases/tag/v1.2.3");
  });

  test("dismiss hides the banner for the same version", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("plugin:app|version", "1.0.0");
    await page.route(
      "https://api.github.com/repos/im-ian/acorn/releases/latest",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tag_name: "v1.2.3",
            body: "",
            html_url: "https://github.com/im-ian/acorn/releases/tag/v1.2.3",
            published_at: "2026-01-01T00:00:00Z",
          }),
        }),
    );

    await page.goto("/");

    const banner = page.getByText(/Acorn 1\.2\.3/);
    await expect(banner).toBeVisible();

    await page.getByRole("button", { name: /Hide until next version/i }).click();

    await expect(banner).toHaveCount(0);
  });
});
