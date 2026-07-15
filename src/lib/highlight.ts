import {
  createHighlighter,
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
} from "shiki";
import type { ParsedLine } from "./diff";
import type { ThemeMode } from "./themes";

const DARK_THEME: BundledTheme = "github-dark";
const LIGHT_THEME: BundledTheme = "github-light-high-contrast";
const THEMES: BundledTheme[] = [DARK_THEME, LIGHT_THEME];

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

// Use the pure-JS regex engine instead of shiki's default oniguruma WASM
// engine: the hardened renderer CSP (script-src 'self', no wasm-unsafe-eval)
// blocks WebAssembly instantiation in the WKWebView, which would otherwise
// make createHighlighter reject and silently drop all highlighting.
//
// `singleline: false` is a JavaScriptCore workaround, not a semantic choice.
// Shiki's default (`singleline: true`) compiles TextMate `^` to a bare `^`
// anchor, and JSC then treats the whole pattern as start-anchored even when the
// `^` sits inside an optional group — so `(^[\t ]+)?(//)` never matches a
// trailing `//` and comments stop tokenizing, which lets a backtick inside a
// comment open a template literal that swallows the rest of the file. Turning
// the rule off emits a `(?<=^|\n)` lookbehind instead, which JSC scans
// correctly. Shiki tokenizes one newline-free line at a time, so line-anchored
// and string-anchored `^`/`$` are equivalent here.
//
// JSC's optimizeBOL bug is open and unassigned to a release:
// https://bugs.webkit.org/show_bug.cgi?id=216671 (filed 2020)
// https://bugs.webkit.org/show_bug.cgi?id=317274
export function compileGrammarRegex(pattern: string): RegExp {
  return defaultJavaScriptRegexConstructor(pattern, {
    target: "auto",
    rules: {
      allowOrphanBackrefs: true,
      asciiWordBoundaries: true,
      captureGroup: true,
      recursionLimit: 5,
      singleline: false,
    },
  });
}

const jsEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: compileGrammarRegex,
});

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<BundledLanguage>();
const loadingLang = new Map<BundledLanguage, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: THEMES,
      langs: [],
      engine: jsEngine,
    });
  }
  return highlighterPromise;
}

export function highlightThemeForMode(mode: ThemeMode): BundledTheme {
  return mode === "light" ? LIGHT_THEME : DARK_THEME;
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
  mode: ThemeMode,
): Promise<string[]> {
  if (src.length === 0) return [];
  const h = await getHighlighter();
  const ok = await ensureLang(h, lang);
  if (!ok) return src.map(escapeHtml);
  const code = src.join("\n");
  const result = h.codeToTokens(code, {
    lang,
    theme: highlightThemeForMode(mode),
  });
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
 * Highlight full file content as token-painted HTML lines. Returns one
 * entry per source line — null when the language is unknown / failed to
 * load, in which case the caller should render plain text.
 */
export async function highlightCode(
  content: string,
  lang: BundledLanguage | null,
  mode: ThemeMode = "dark",
): Promise<(string | null)[]> {
  const lines = content.split("\n");
  if (!lang) return lines.map(() => null);
  const out = await renderLines(lines, lang, mode);
  return out;
}

/**
 * Highlight a parsed diff. Each hunk is tokenized independently because
 * unified diffs omit unchanged ranges between hunks, so lexer state cannot
 * safely cross hunk boundaries.
 */
export async function highlightDiff(
  lines: ParsedLine[],
  lang: BundledLanguage,
  mode: ThemeMode = "dark",
): Promise<(string | null)[]> {
  const html: (string | null)[] = new Array(lines.length).fill(null);
  const segments: DiffHighlightSegment[] = [];
  let segment = createDiffHighlightSegment();

  const flush = () => {
    if (segment.refs.length > 0) segments.push(segment);
    segment = createDiffHighlightSegment();
  };

  lines.forEach((line, lineIndex) => {
    if (line.kind === "hunk" || line.kind === "meta") {
      flush();
      return;
    }
    if (line.kind === "add") {
      segment.newLines.push(line.text);
      segment.refs.push({
        lineIndex,
        side: "new",
        sourceIndex: segment.newLines.length - 1,
      });
      return;
    }
    if (line.kind === "del") {
      segment.oldLines.push(line.text);
      segment.refs.push({
        lineIndex,
        side: "old",
        sourceIndex: segment.oldLines.length - 1,
      });
      return;
    }
    segment.newLines.push(line.text);
    segment.oldLines.push(line.text);
    segment.refs.push({
      lineIndex,
      side: "new",
      sourceIndex: segment.newLines.length - 1,
    });
  });
  flush();

  await Promise.all(
    segments.map(async (part) => {
      const [newHtml, oldHtml] = await Promise.all([
        renderLines(part.newLines, lang, mode),
        renderLines(part.oldLines, lang, mode),
      ]);
      for (const ref of part.refs) {
        const rendered = ref.side === "new" ? newHtml : oldHtml;
        html[ref.lineIndex] = rendered[ref.sourceIndex] ?? null;
      }
    }),
  );

  return html;
}

interface DiffHighlightSegment {
  newLines: string[];
  oldLines: string[];
  refs: DiffHighlightRef[];
}

interface DiffHighlightRef {
  lineIndex: number;
  side: "new" | "old";
  sourceIndex: number;
}

function createDiffHighlightSegment(): DiffHighlightSegment {
  return { newLines: [], oldLines: [], refs: [] };
}
