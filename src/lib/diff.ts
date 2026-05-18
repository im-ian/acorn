/**
 * Shared parsing helpers for unified-diff patches.
 *
 * Both the compact accordion `DiffView` and the GitHub-style `DiffSplitView`
 * consume these. Keep this file presentation-free so it can be unit-tested
 * without React.
 */

export type LineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export interface ParsedLine {
  kind: LineKind;
  prefix: string;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffStats {
  add: number;
  del: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(patch: string): ParsedLine[] {
  let oldCursor: number | null = null;
  let newCursor: number | null = null;
  return patch.split("\n").map((raw): ParsedLine => {
    if (raw.startsWith("@@")) {
      const match = HUNK_HEADER.exec(raw);
      if (match) {
        oldCursor = Number(match[1]);
        newCursor = Number(match[2]);
      } else {
        oldCursor = null;
        newCursor = null;
      }
      return {
        kind: "hunk",
        prefix: "@@",
        text: raw,
        oldLine: null,
        newLine: null,
      };
    }
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename ")
    ) {
      return {
        kind: "meta",
        prefix: "",
        text: raw,
        oldLine: null,
        newLine: null,
      };
    }
    if (raw.startsWith("+")) {
      const newLine = newCursor;
      if (newCursor !== null) newCursor += 1;
      return {
        kind: "add",
        prefix: "+",
        text: raw.slice(1),
        oldLine: null,
        newLine,
      };
    }
    if (raw.startsWith("-")) {
      const oldLine = oldCursor;
      if (oldCursor !== null) oldCursor += 1;
      return {
        kind: "del",
        prefix: "-",
        text: raw.slice(1),
        oldLine,
        newLine: null,
      };
    }
    if (raw.startsWith(" ")) {
      const oldLine = oldCursor;
      const newLine = newCursor;
      if (oldCursor !== null) oldCursor += 1;
      if (newCursor !== null) newCursor += 1;
      return {
        kind: "ctx",
        prefix: " ",
        text: raw.slice(1),
        oldLine,
        newLine,
      };
    }
    return {
      kind: "ctx",
      prefix: "",
      text: raw,
      oldLine: null,
      newLine: null,
    };
  });
}

export function diffGutterWidth(lines: readonly ParsedLine[]): number {
  let max = 0;
  for (const l of lines) {
    if (l.oldLine !== null && l.oldLine > max) max = l.oldLine;
    if (l.newLine !== null && l.newLine > max) max = l.newLine;
  }
  return max > 0 ? String(max).length : 1;
}

export function countStats(lines: ParsedLine[]): DiffStats {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}
