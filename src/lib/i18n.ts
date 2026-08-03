import en from "../locales/en.json";
import ja from "../locales/ja.json";
import ko from "../locales/ko.json";
import zhCN from "../locales/zh-CN.json";

export type Language = "en" | "ja" | "ko" | "zh-CN";

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: Language;
  label: string;
  nativeLabel: string;
}> = [
  { value: "en", label: "English", nativeLabel: "English" },
  { value: "ja", label: "Japanese", nativeLabel: "日本語" },
  { value: "ko", label: "Korean", nativeLabel: "한국어" },
  {
    value: "zh-CN",
    label: "Simplified Chinese",
    nativeLabel: "简体中文",
  },
];

const LANGUAGE_VALUES = new Set<Language>(LANGUAGE_OPTIONS.map((o) => o.value));

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && LANGUAGE_VALUES.has(value as Language);
}

type LocaleTree = typeof en;
type StringPath<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends Record<string, unknown>
      ? `${K}.${StringPath<T[K]>}`
      : never;
}[keyof T & string];

export type TranslationKey = StringPath<LocaleTree>;
export type Translator = (key: TranslationKey) => string;

const TRANSLATIONS: Record<Language, LocaleTree> = {
  en,
  ja,
  ko,
  "zh-CN": zhCN,
};

function lookup(tree: LocaleTree, key: TranslationKey): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (!node || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[part];
  }, tree);

  return typeof value === "string" ? value : key;
}

export function translate(language: Language, key: TranslationKey): string {
  return lookup(TRANSLATIONS[language], key);
}

export function createTranslator(language: Language): Translator {
  return (key: TranslationKey) => translate(language, key);
}
