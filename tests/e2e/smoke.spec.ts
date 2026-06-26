import { test, expect, pressHotkey } from "./support";

test.describe("smoke: app boots in mocked browser", () => {
  // Console-error gating runs automatically via the errorTracker fixture
  // for every test in the suite.
  test("renders sidebar header with empty state by default", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New project" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add existing project" }),
    ).toBeVisible();
    await expect(page.getByText(/Click to open a project/i)).toBeVisible();
    await expect(page.getByText(/update available/i)).toHaveCount(0);
  });

  test("resizes app UI with keyboard shortcuts", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    await pressHotkey(page, { mod: true, key: "=" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.05");

    await pressHotkey(page, { mod: true, shift: true, key: "+" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.1");

    await pressHotkey(page, { mod: true, key: "-" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.05");

    await pressHotkey(page, { mod: true, shift: true, key: "_" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1");

    await pressHotkey(page, { mod: true, key: "=" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.05");

    await pressHotkey(page, { mod: true, key: "0" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1");
  });

  test("blocks modified wheel zoom without changing UI scale", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    const result = await page.evaluate(() => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const event = new WheelEvent("wheel", {
        deltaY: -160,
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      });

      return {
        dispatched: window.dispatchEvent(event),
        defaultPrevented: event.defaultPrevented,
        scale: document.documentElement.style.getPropertyValue(
          "--acorn-ui-scale",
        ),
      };
    });

    expect(result).toEqual({
      dispatched: false,
      defaultPrevented: true,
      scale: "1",
    });
  });
});
