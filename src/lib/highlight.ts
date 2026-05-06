import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
} from "shiki";
import type { ParsedLine } from "./diff";

const THEME: BundledTheme = "github-dark";

const EXT_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "mdx",
  sql: "sql",
  lua: "lua",
  vue: "vue",
  svelte: "svelte",
  dart: "dart",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  dockerfile: "docker",
  xml: "xml",
};

const FILENAME_LANG: Record<string, BundledLanguage> = {
  Dockerfile: "docker",
  Makefile: "make",
  "CMakeLists.txt": "cmake",
};

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<BundledLanguage>();
const loadingLang = new Map<BundledLanguage, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
      langs: [],
    });
  }
  return highlighterPromise;
}

async function ensureLang(h: Highlighter, lang: BundledLanguage): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  let pending = loadingLang.get(lang);
  if (!pending) {
    pending = h
      .loadLanguage(lang)
      .then(() => {
        loadedLangs.add(lang);
      })
      .catch((err) => {
        console.warn("[highlight] loadLanguage failed", lang, err);
      })
      .finally(() => {
        loadingLang.delete(lang);
      });
    loadingLang.set(lang, pending);
  }
  await pending;
  return loadedLangs.has(lang);
}

export function langFromPath(path: string | null | undefined): BundledLanguage | null {
  if (!path) return null;
  const display = path.includes(" → ") ? path.split(" → ").pop() ?? path : path;
  const base = display.split("/").filter(Boolean).pop() ?? display;
  if (FILENAME_LANG[base]) return FILENAME_LANG[base];
  const m = base.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return null;
  return EXT_LANG[m[1].toLowerCase()] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    return "&gt;";
  });
}

async function renderLines(
  src: string[],
  lang: BundledLanguage,
): Promise<string[]> {
  if (src.length === 0) return [];
  const h = await getHighlighter();
  const ok = await ensureLang(h, lang);
  if (!ok) return src.map(escapeHtml);
  const code = src.join("\n");
  const result = h.codeToTokens(code, { lang, theme: THEME });
  return result.tokens.map((line) =>
    line
      .map(
        (t) =>
          `<span style="color:${t.color ?? "inherit"}">${escapeHtml(t.content)}</span>`,
      )
      .join(""),
  );
}

/**
 * Highlight a parsed diff. Splits into the new-side (ctx + add) and old-side
 * (ctx + del) virtual files so the lexer keeps coherent state per side, then
 * maps tokens back to the original line order.
 *
 * Returns one entry per input line. `null` means render plain text (hunk/meta
 * headers, or unsupported languages).
 */
export async function highlightDiff(
  lines: ParsedLine[],
  lang: BundledLanguage,
): Promise<(string | null)[]> {
  const newLines: string[] = [];
  const oldLines: string[] = [];
  const map: ({ side: "new" | "old"; idx: number } | null)[] = lines.map((l) => {
    if (l.kind === "add") {
      newLines.push(l.text);
      return { side: "new", idx: newLines.length - 1 };
    }
    if (l.kind === "del") {
      oldLines.push(l.text);
      return { side: "old", idx: oldLines.length - 1 };
    }
    if (l.kind === "ctx") {
      newLines.push(l.text);
      oldLines.push(l.text);
      return { side: "new", idx: newLines.length - 1 };
    }
    return null;
  });

  const [newHtml, oldHtml] = await Promise.all([
    renderLines(newLines, lang),
    renderLines(oldLines, lang),
  ]);

  return map.map((m) => {
    if (!m) return null;
    return (m.side === "new" ? newHtml[m.idx] : oldHtml[m.idx]) ?? null;
  });
}
