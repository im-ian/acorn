import { test, expect, pressHotkey } from "./support";

const SETTINGS_STORAGE_KEY = "acorn:settings:v1";
const SETTINGS_DIALOG_NAME = /^(Settings|설정)$/;

// Each Settings tab has a label / heading unique enough to anchor against.
// Asserting one element per tab is enough to catch "clicked tab N but
// content M still rendered" regressions without locking us into specific
// form widgets.
const TAB_MARKERS: Array<{
  tab: RegExp;
  label: string;
  marker: { kind: "text"; pattern: RegExp } | { kind: "heading"; name: string };
}> = [
  {
    tab: /^(Terminal|터미널)$/,
    label: "Terminal",
    marker: {
      kind: "text",
      pattern: /Font family|글꼴 패밀리/i,
    },
  },
  {
    tab: /^(Agents|에이전트)$/,
    label: "Agents",
    marker: { kind: "text", pattern: /Claude Code/i },
  },
  {
    tab: /^(Sessions|세션)$/,
    label: "Sessions",
    marker: {
      kind: "text",
      pattern: /Confirm before removing|세션 제거 전 확인/i,
    },
  },
  {
    tab: /^(Editor|편집기)$/,
    label: "Editor",
    marker: {
      kind: "text",
      pattern: /Editor command|편집기 명령/i,
    },
  },
  {
    tab: /^(Notifications|알림)$/,
    label: "Notifications",
    marker: {
      kind: "text",
      pattern: /System notifications|시스템 알림/i,
    },
  },
  {
    tab: /^(Storage|저장 공간)$/,
    label: "Storage",
    marker: {
      kind: "text",
      pattern: /Reclaimable cache|회수 가능한 캐시/i,
    },
  },
  {
    tab: /^(About|정보)$/,
    label: "About",
    marker: { kind: "text", pattern: /About Acorn|Acorn 정보/i },
  },
];

test.describe("settings modal: tab content", () => {
  test("clicking each tab swaps the body content", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal).toBeVisible();

    for (const { tab, label, marker } of TAB_MARKERS) {
      await modal.getByRole("button", { name: tab }).click();
      const expected =
        marker.kind === "heading"
          ? modal.getByRole("heading", { name: marker.name })
          : modal.getByText(marker.pattern);
      await expect(
        expected,
        `Settings → ${label} should reveal its content marker`,
      ).toBeVisible();
    }
  });

  test("Korean mode localizes tab buttons and representative Settings markers", async ({
    page,
  }) => {
    await page.addInitScript((storageKey) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ language: "ko" }),
      );
    }, SETTINGS_STORAGE_KEY);

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: "설정" });
    await expect(modal).toBeVisible();

    for (const tab of [
      "터미널",
      "에이전트",
      "세션",
      "GitHub",
      "모양",
      "편집기",
      "알림",
      "저장 공간",
      "실험 기능",
      "정보",
    ]) {
      await expect(
        modal.getByRole("button", { name: tab, exact: true }),
      ).toBeVisible();
    }

    await modal.getByRole("button", { name: "모양", exact: true }).click();
    await expect(modal.getByText("언어", { exact: true })).toBeVisible();
    await expect(modal.getByRole("combobox", { name: "언어" })).toHaveValue(
      "ko",
    );
    await expect(
      modal.getByRole("button", { name: "기본값으로 재설정" }),
    ).toBeVisible();

    await modal.getByRole("button", { name: "터미널", exact: true }).click();
    await expect(modal.getByText("글꼴 패밀리")).toBeVisible();
  });
});
