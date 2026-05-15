import en from "../locales/en.json";
import ko from "../locales/ko.json";

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

export type TranslationKey = keyof typeof en;

const EN_TRANSLATIONS: Record<TranslationKey, string> = en;
const KO_TRANSLATIONS: Record<TranslationKey, string> = ko;

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
