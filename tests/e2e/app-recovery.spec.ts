import { test, expect } from "./support";

test.describe("app recovery", () => {
  test("recovers from incompatible persisted UI state instead of staying blank", async ({
    page,
    errorTracker,
  }) => {
    errorTracker.allow(/cannot read properties of undefined/i);
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem("acorn:test:legacy-state-seeded")) {
        return;
      }
      window.sessionStorage.setItem("acorn:test:legacy-state-seeded", "1");
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ language: "zh-CN" }),
      );
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
      page.getByRole("heading", { name: "Acorn 无法打开" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "终端会话和项目会保留；只会重置本地工作区偏好设置。",
      ),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "重置工作区视图并重新打开" })
      .click();

    await expect(
      page.getByRole("heading", { name: /^(Projects|프로젝트|项目)$/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn-workspaces");
          if (!raw) return null;
          const parsed = JSON.parse(raw) as {
            state?: { workspaces?: Record<string, unknown> };
          };
          return parsed.state?.workspaces ?? null;
        }),
      )
      .toEqual({});
    await expect
      .poll(() =>
        page.evaluate(() => window.localStorage.getItem("acorn:settings:v1")),
      )
      .not.toBeNull();
  });
});
