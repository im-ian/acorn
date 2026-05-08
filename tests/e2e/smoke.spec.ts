import { test, expect } from "./support";

test.describe("smoke: app boots in mocked browser", () => {
  // Console-error gating runs automatically via the errorTracker fixture
  // for every test in the suite.
  test("renders sidebar header with empty state by default", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add project" }),
    ).toBeVisible();
    await expect(page.getByText(/No projects yet/i)).toBeVisible();
    await expect(page.getByText(/update available/i)).toHaveCount(0);
  });
});
