export type Language = "en" | "ko";

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: Language;
  label: string;
  nativeLabel: string;
}> = [
  { value: "en", label: "English", nativeLabel: "English" },
  { value: "ko", label: "Korean", nativeLabel: "한국어" },
];

const LANGUAGE_VALUES = new Set<Language>(LANGUAGE_OPTIONS.map((o) => o.value));

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && LANGUAGE_VALUES.has(value as Language);
}

const EN_TRANSLATIONS = {
  "settings.title": "Settings",
  "settings.reset": "Reset to defaults",
  "settings.tabs.terminal": "Terminal",
  "settings.tabs.agents": "Agents",
  "settings.tabs.sessions": "Sessions",
  "settings.tabs.github": "GitHub",
  "settings.tabs.appearance": "Appearance",
  "settings.tabs.editor": "Editor",
  "settings.tabs.notifications": "Notifications",
  "settings.tabs.storage": "Storage",
  "settings.tabs.experiments": "Experiments",
  "settings.tabs.about": "About",
  "settings.language.label": "Language",
  "settings.language.hint":
    "Language used for the Acorn interface. New translations are added gradually.",
} as const;

export type TranslationKey = keyof typeof EN_TRANSLATIONS;

const KO_TRANSLATIONS: Record<TranslationKey, string> = {
  "settings.title": "설정",
  "settings.reset": "기본값으로 재설정",
  "settings.tabs.terminal": "터미널",
  "settings.tabs.agents": "에이전트",
  "settings.tabs.sessions": "세션",
  "settings.tabs.github": "GitHub",
  "settings.tabs.appearance": "모양",
  "settings.tabs.editor": "편집기",
  "settings.tabs.notifications": "알림",
  "settings.tabs.storage": "저장 공간",
  "settings.tabs.experiments": "실험 기능",
  "settings.tabs.about": "정보",
  "settings.language.label": "언어",
  "settings.language.hint":
    "Acorn 인터페이스에 사용할 언어입니다. 새 번역은 점진적으로 추가됩니다.",
};

const TRANSLATIONS: Record<Language, Record<TranslationKey, string>> = {
  en: EN_TRANSLATIONS,
  ko: KO_TRANSLATIONS,
};

export function translate(language: Language, key: TranslationKey): string {
  return TRANSLATIONS[language][key];
}

export function createTranslator(language: Language) {
  return (key: TranslationKey) => translate(language, key);
}
