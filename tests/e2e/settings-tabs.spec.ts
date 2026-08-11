import {
  test,
  expect,
  pressHotkey,
  seedSettingsLanguage,
} from "./support";

const SETTINGS_DIALOG_NAME = /^(Settings|設定|설정|设置)$/;

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
    tab: /^(Interface|인터페이스)$/,
    label: "Interface",
    marker: {
      kind: "text",
      pattern: /UI scale|UI 배율/i,
    },
  },
  {
    tab: /^(Appearance|모양)$/,
    label: "Appearance",
    marker: {
      kind: "text",
      pattern: /Background image|배경 이미지/i,
    },
  },
  {
    tab: /^(Terminal|터미널)$/,
    label: "Terminal",
    marker: {
      kind: "text",
      pattern: /Open links on|링크 열기 방식/i,
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
      pattern: /Session removal confirmation|세션 제거 확인/i,
    },
  },
  {
    tab: /^GitHub$/,
    label: "GitHub",
    marker: {
      kind: "text",
      pattern: /Refresh interval|새로고침 간격/i,
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
    tab: /^(Shortcuts|단축키)$/,
    label: "Shortcuts",
    marker: {
      kind: "text",
      pattern: /Reset all shortcuts|모든 단축키 초기화/i,
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
  test("hides macOS-only permissions on Windows", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", {
        get: () => "Win32",
        configurable: true,
      });
    });
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /^(Permissions|権限|권한|权限)$/ }),
    ).toHaveCount(0);
  });

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
    await seedSettingsLanguage(page, "ko");

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: "설정" });
    await expect(modal).toBeVisible();

    for (const tab of [
      "인터페이스",
      "모양",
      "테마",
      "터미널",
      "세션",
      "에이전트",
      "GitHub",
      "편집기",
      "알림",
      "단축키",
      "저장 공간",
      "실험 기능",
      "정보",
    ]) {
      await expect(
        modal.getByRole("button", { name: tab, exact: true }),
      ).toBeVisible();
    }

    await modal.getByRole("button", { name: "인터페이스", exact: true }).click();
    await expect(modal.getByText("언어", { exact: true })).toBeVisible();
    await expect(modal.getByRole("combobox", { name: "언어" })).toContainText(
      "한국어",
    );
    await expect(
      modal.getByRole("button", { name: "기본값으로 재설정" }),
    ).toBeVisible();

    await modal.getByRole("button", { name: "테마", exact: true }).click();
    await expect(modal.getByRole("combobox", { name: "테마" })).toBeVisible();

    await modal.getByRole("button", { name: "터미널", exact: true }).click();
    await expect(modal.getByText("글꼴 패밀리")).toBeVisible();
    await expect(modal.getByText("링크 열기 방식")).toBeVisible();
  });

  test("Simplified Chinese mode localizes Settings and the language selector", async ({
    page,
  }) => {
    await seedSettingsLanguage(page, "zh-CN");

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: "设置" });
    await expect(modal).toBeVisible();

    for (const tab of [
      "界面",
      "外观",
      "主题",
      "终端",
      "会话",
      "智能体",
      "GitHub",
      "编辑器",
      "通知",
      "快捷键",
      "存储",
      "实验",
      "关于",
    ]) {
      await expect(
        modal.getByRole("button", { name: tab, exact: true }),
      ).toBeVisible();
    }

    await modal.getByRole("button", { name: "界面", exact: true }).click();
    await expect(modal.getByText("语言", { exact: true })).toBeVisible();
    await expect(modal.getByRole("combobox", { name: "语言" })).toContainText(
      "简体中文",
    );
    await expect(
      modal.getByRole("button", { name: "重置为默认值" }),
    ).toBeVisible();
  });

  test("Japanese mode localizes Settings and the language selector", async ({
    page,
  }) => {
    await seedSettingsLanguage(page, "ja");

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: "設定" });
    await expect(modal).toBeVisible();

    for (const tab of [
      "インターフェース",
      "外観",
      "テーマ",
      "ターミナル",
      "セッション",
      "エージェント",
      "GitHub",
      "エディタ",
      "通知",
      "ショートカット",
      "ストレージ",
      "実験",
      "Acorn について",
    ]) {
      await expect(
        modal.getByRole("button", { name: tab, exact: true }),
      ).toBeVisible();
    }

    await modal
      .getByRole("button", { name: "インターフェース", exact: true })
      .click();
    await expect(modal.getByText("言語", { exact: true })).toBeVisible();
    await expect(modal.getByRole("combobox", { name: "言語" })).toContainText(
      "日本語",
    );
    await expect(
      modal.getByRole("button", { name: "デフォルトに戻す" }),
    ).toBeVisible();

    await modal.getByRole("button", { name: "ターミナル", exact: true }).click();
    await expect(modal.getByText("フォントファミリー")).toBeVisible();
    await expect(modal.getByText("リンクを開く方法")).toBeVisible();
  });
});
