import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import zhCN from "../locales/zh-CN.json";
import {
  LANGUAGE_OPTIONS,
  createTranslator,
  isLanguage,
  translate,
} from "./i18n";

function leafStrings(
  value: unknown,
  path: string[] = [],
  result = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "string") {
    result.set(path.join("."), value);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      leafStrings(item, [...path, String(index)], result),
    );
    return result;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      leafStrings(item, [...path, key], result),
    );
  }
  return result;
}

function placeholders(value: string): string[] {
  return value.match(/\{[^{}]+\}/g)?.sort() ?? [];
}

describe("Simplified Chinese translations", () => {
  it("registers zh-CN as a supported language", () => {
    expect(isLanguage("zh-CN")).toBe(true);
    expect(LANGUAGE_OPTIONS).toContainEqual({
      value: "zh-CN",
      label: "Simplified Chinese",
      nativeLabel: "简体中文",
    });
  });

  it("translates representative interface and recovery-adjacent copy", () => {
    const t = createTranslator("zh-CN");

    expect(t("settings.title")).toBe("设置");
    expect(t("settings.tabs.sessions")).toBe("会话");
    expect(t("dialogs.agentResume.title")).toBe("继续上次对话");
  });

  it("preserves interpolation placeholders", () => {
    expect(translate("zh-CN", "settings.about.updateReady")).toContain(
      "{version}",
    );
    expect(
      translate("zh-CN", "toasts.session.worktreeRemovedUndo"),
    ).toContain("{seconds}");
  });

  it("matches every English locale key and placeholder contract", () => {
    const english = leafStrings(en);
    const chinese = leafStrings(zhCN);

    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, source] of english) {
      expect(placeholders(chinese.get(key) ?? ""), key).toEqual(
        placeholders(source),
      );
    }
  });
});

describe("Japanese translations", () => {
  it("registers ja as a supported language", () => {
    expect(isLanguage("ja")).toBe(true);
    expect(LANGUAGE_OPTIONS).toContainEqual({
      value: "ja",
      label: "Japanese",
      nativeLabel: "日本語",
    });
  });

  it("translates representative interface and recovery-adjacent copy", () => {
    const t = createTranslator("ja");

    expect(t("settings.title")).toBe("設定");
    expect(t("settings.tabs.sessions")).toBe("セッション");
    expect(t("dialogs.agentResume.title")).toBe("前の会話を再開する");
  });

  it("preserves interpolation placeholders", () => {
    expect(translate("ja", "settings.about.updateReady")).toContain(
      "{version}",
    );
    expect(
      translate("ja", "toasts.session.worktreeRemovedUndo"),
    ).toContain("{seconds}");
  });

  it("matches every English locale key and placeholder contract", () => {
    const english = leafStrings(en);
    const japanese = leafStrings(ja);

    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, source] of english) {
      expect(placeholders(japanese.get(key) ?? ""), key).toEqual(
        placeholders(source),
      );
    }
  });
});
