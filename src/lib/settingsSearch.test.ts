import { describe, expect, it } from "vitest";
import { createTranslator, translate } from "./i18n";
import {
  SETTINGS_SEARCH_TARGETS,
  searchSettings,
  type SettingsSearchOptions,
  type SettingsSearchTarget,
} from "./settingsSearch";

const visible: SettingsSearchOptions = {
  showMacPermissions: true,
  showMacPower: true,
};

const hiddenMac: SettingsSearchOptions = {
  showMacPermissions: false,
  showMacPower: false,
};

function hitsFor(query: string, options: SettingsSearchOptions = visible) {
  return searchSettings(query, SETTINGS_SEARCH_TARGETS, createTranslator("en"), options);
}

describe("searchSettings", () => {
  it("resolves every catalog label and detail", () => {
    for (const target of SETTINGS_SEARCH_TARGETS) {
      expect(translate("en", target.labelKey), target.labelKey).not.toBe(
        target.labelKey,
      );
      for (const key of target.detailKeys ?? []) {
        expect(translate("en", key), key).not.toBe(key);
      }
    }
    const keys = SETTINGS_SEARCH_TARGETS.map(
      (target) => `${target.id}\u0000${target.labelKey}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns nothing for a blank query", () => {
    expect(hitsFor("")).toEqual([]);
    expect(hitsFor("   ")).toEqual([]);
  });

  it("matches a label ahead of a looser description", () => {
    const hits = hitsFor("font size");
    expect(hits[0]?.id).toBe("setting-font-size");
    expect(hits[0]?.tab).toBe("terminal");
  });

  it("matches every word across the label and description", () => {
    const hits = hitsFor("waiting error tabs");
    expect(hits.map((hit) => hit.id)).toContain("setting-project-tab-priority");
    expect(hitsFor("waiting zebra")).toEqual([]);
  });

  it("matches the English label while the interface is Korean", () => {
    const hits = searchSettings(
      "language",
      SETTINGS_SEARCH_TARGETS,
      createTranslator("ko"),
      visible,
    );
    expect(hits[0]).toMatchObject({
      id: "setting-language",
      label: "언어",
    });
  });

  it("matches the active language too", () => {
    const hits = searchSettings(
      "언어",
      SETTINGS_SEARCH_TARGETS,
      createTranslator("ko"),
      visible,
    );
    expect(hits[0]?.id).toBe("setting-language");
  });

  it("hides macOS-only settings when those sections are unavailable", () => {
    const microphone: SettingsSearchTarget = {
      id: "setting-permission-microphone",
      tab: "permissions",
      labelKey: "settings.permissions.items.microphone.label",
      platform: "mac",
    };
    const targets = [...SETTINGS_SEARCH_TARGETS, microphone];
    expect(
      searchSettings("microphone", targets, createTranslator("en"), hiddenMac).map(
        (hit) => hit.id,
      ),
    ).not.toContain("setting-permission-microphone");
    expect(hitsFor("keep this mac awake", hiddenMac)).toEqual([]);
    expect(hitsFor("keep this mac awake").map((hit) => hit.id)).toContain(
      "setting-prevent-sleep",
    );
  });
});
