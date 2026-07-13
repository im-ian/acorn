import { test, expect } from "./support";

test.describe("app recovery", () => {
  test("recovers from incompatible persisted UI state instead of staying blank", async ({
    page,
    errorTracker,
  }) => {
    errorTracker.allow(/cannot read properties of undefined/i);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn-workspaces",
        JSON.stringify({
          state: {
            workspaces: {
              "/tmp/legacy-project": {
                panes: {},
                focusedPaneId: "legacy-pane",
              },
            },
            activeProject: "/tmp/legacy-project",
            activeProjectFolderId: "/tmp/legacy-project",
          },
          version: 4,
        }),
      );
    });

    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Acorn을 열지 못했습니다" }),
    ).toBeVisible();
    await expect(page.getByText("저장된 세션과 프로젝트는 삭제되지 않습니다"))
      .toBeVisible();

    await page
      .getByRole("button", { name: "화면 설정 초기화 후 다시 열기" })
      .click();

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.localStorage.getItem("acorn-workspaces")),
      )
      .toBeNull();
  });
});
