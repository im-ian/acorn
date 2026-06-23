import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { diffGutterWidth, parseDiff, type ParsedLine } from "../../lib/diff";
import { highlightCode, langFromPath } from "../../lib/highlight";
import { useSettings } from "../../lib/settings";
import { resolveThemeMode, useThemes } from "../../lib/themes";
import { Tooltip } from "../Tooltip";
import { IconButton } from "../ui";

interface ChatCodeBlockProps {
  code: string;
  language?: string | null;
  repoPath?: string;
  className?: string;
  isStreaming?: boolean;
}

const COLLAPSED_MAX_LINES = 18;
const COLLAPSED_MAX_CHARS = 1_600;

const FENCE_LANG_ALIASES: Record<string, string> = {
  bash: "sh",
  shell: "sh",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  markdown: "md",
  md: "md",
  python: "py",
  py: "py",
  rust: "rs",
  rs: "rs",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yml",
};

function normalizedFenceLabel(language: string | null | undefined): string {
  const raw = (language ?? "").trim();
  if (!raw) return "text";
  return raw.replace(/^language-/, "").split(/\s+/)[0] || "text";
}

function highlightLangForFence(language: string | null | undefined) {
  const label = normalizedFenceLabel(language);
  const aliased = FENCE_LANG_ALIASES[label.toLowerCase()] ?? label;
  return langFromPath(label) ?? langFromPath(`snippet.${aliased}`);
}

function stripOneTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function lineText(line: ParsedLine): string {
  if (line.kind === "add") return `+${line.text}`;
  if (line.kind === "del") return `-${line.text}`;
  if (line.kind === "ctx") return `${line.prefix}${line.text}`;
  return line.text;
}

export function ChatCodeBlock({
  code,
  language,
  className,
}: ChatCodeBlockProps) {
  const normalizedCode = stripOneTrailingNewline(code);
  const label = normalizedFenceLabel(language);
  const isDiff = label.toLowerCase() === "diff" || label.toLowerCase() === "patch";
  const sourceLines = useMemo(
    () => (normalizedCode.length ? normalizedCode.split("\n") : [""]),
    [normalizedCode],
  );
  const parsedDiff = useMemo(
    () => (isDiff ? parseDiff(normalizedCode) : []),
    [isDiff, normalizedCode],
  );
  const visibleLineCount = isDiff ? parsedDiff.length : sourceLines.length;
  const isLong =
    visibleLineCount > COLLAPSED_MAX_LINES ||
    normalizedCode.length > COLLAPSED_MAX_CHARS;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<number | null>(null);
  const themeId = useSettings((s) => s.settings.appearance.themeId);
  const themes = useThemes((s) => s.themes);
  const themeMode = useMemo(
    () => resolveThemeMode(themeId, themes),
    [themeId, themes],
  );
  const [highlightedLines, setHighlightedLines] = useState<(string | null)[]>(
    () => new Array(sourceLines.length).fill(null),
  );

  useEffect(() => {
    setExpanded(false);
  }, [normalizedCode]);

  useEffect(() => {
    return () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isDiff) {
      setHighlightedLines(new Array(sourceLines.length).fill(null));
      return;
    }
    const lang = highlightLangForFence(label);
    let cancelled = false;
    setHighlightedLines(new Array(sourceLines.length).fill(null));
    highlightCode(normalizedCode, lang, themeMode)
      .then((lines) => {
        if (!cancelled) setHighlightedLines(lines);
      })
      .catch((err) => {
        console.warn("[ChatCodeBlock] highlight failed", err);
        if (!cancelled) {
          setHighlightedLines(new Array(sourceLines.length).fill(null));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isDiff, label, normalizedCode, sourceLines.length, themeMode]);

  async function copyCode() {
    await navigator.clipboard.writeText(normalizedCode);
    setCopied(true);
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopied(false);
      copyResetTimer.current = null;
    }, 1400);
  }

  return (
    <div
      className={cn(
        "my-3 overflow-hidden rounded-md border border-border bg-bg-sidebar/80 text-fg shadow-sm",
        className,
      )}
      data-chat-code-block
      data-language={label}
      {...(isDiff ? { "data-chat-diff-block": true } : {})}
    >
      <div className="flex h-8 items-center justify-between gap-2 border-b border-border bg-bg-elevated/70 px-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-muted">
          {label}
        </span>
        <span className="flex items-center gap-1">
          {isLong ? (
            <Tooltip
              label={expanded ? "Collapse code block" : "Expand code block"}
              side="bottom"
            >
              <IconButton
                size="sm"
                aria-label={expanded ? "Collapse code block" : "Expand code block"}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip label="Copy code" side="bottom">
            <IconButton
              size="sm"
              aria-label="Copy code block"
              onClick={() => void copyCode()}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </IconButton>
          </Tooltip>
        </span>
      </div>
      <div
        className={cn(
          "acorn-selectable overflow-auto font-mono text-[11px] leading-5 select-text",
          isLong && !expanded ? "max-h-72" : "max-h-none",
        )}
      >
        {isDiff ? (
          <ChatDiffLines lines={parsedDiff} />
        ) : (
          <CodeLines lines={sourceLines} highlightedLines={highlightedLines} />
        )}
      </div>
    </div>
  );
}

function CodeLines({
  lines,
  highlightedLines,
}: {
  lines: string[];
  highlightedLines: (string | null)[];
}) {
  const gutterWidth = String(lines.length).length;
  return (
    <div className="w-max min-w-full py-1">
      {lines.map((line, index) => (
        <div key={index} className="flex min-w-full">
          <span
            aria-hidden
            className="select-none shrink-0 px-2 text-right tabular-nums text-fg-muted/45"
            style={{ minWidth: `${Math.max(2, gutterWidth + 1)}ch` }}
          >
            {index + 1}
          </span>
          {highlightedLines[index] ? (
            <span
              className="whitespace-pre pr-4"
              dangerouslySetInnerHTML={{
                __html: highlightedLines[index] || "&nbsp;",
              }}
            />
          ) : (
            <span className="whitespace-pre pr-4 text-fg">{line || " "}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function ChatDiffLines({ lines }: { lines: ParsedLine[] }) {
  const gutterWidth = diffGutterWidth(lines);
  return (
    <div className="w-max min-w-full py-1" data-chat-diff-lines>
      {lines.map((line, index) => {
        const marker =
          line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        const rowClass =
          line.kind === "add"
            ? "bg-[oklch(35%_0.10_145_/_0.24)] text-[oklch(86%_0.14_145)]"
            : line.kind === "del"
              ? "bg-[oklch(35%_0.16_25_/_0.22)] text-[oklch(82%_0.16_25)]"
              : line.kind === "hunk"
                ? "bg-[oklch(28%_0.04_250)] text-[oklch(70%_0.05_250)]"
                : line.kind === "meta"
                  ? "bg-bg-elevated/40 text-fg-muted"
                  : "text-fg-muted";
        return (
          <div key={index} className={cn("flex min-w-full", rowClass)}>
            <span
              aria-hidden
              className="select-none shrink-0 px-1 text-right tabular-nums text-fg-muted/50"
              style={{ minWidth: `${Math.max(1, gutterWidth)}ch` }}
            >
              {line.oldLine ?? ""}
            </span>
            <span
              aria-hidden
              className="select-none shrink-0 px-1 text-right tabular-nums text-fg-muted/50"
              style={{ minWidth: `${Math.max(1, gutterWidth)}ch` }}
            >
              {line.newLine ?? ""}
            </span>
            <span
              aria-hidden
              className="select-none w-4 shrink-0 text-center opacity-75"
            >
              {line.kind === "hunk" || line.kind === "meta" ? " " : marker}
            </span>
            <span className="whitespace-pre pr-4">{lineText(line) || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
