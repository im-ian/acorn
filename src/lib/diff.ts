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
}

export interface DiffStats {
  add: number;
  del: number;
}

export function parseDiff(patch: string): ParsedLine[] {
  return patch.split("\n").map((raw) => {
    if (raw.startsWith("@@")) {
      return { kind: "hunk" as const, prefix: "@@", text: raw };
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
      return { kind: "meta" as const, prefix: "", text: raw };
    }
    if (raw.startsWith("+")) {
      return { kind: "add" as const, prefix: "+", text: raw.slice(1) };
    }
    if (raw.startsWith("-")) {
      return { kind: "del" as const, prefix: "-", text: raw.slice(1) };
    }
    if (raw.startsWith(" ")) {
      return { kind: "ctx" as const, prefix: " ", text: raw.slice(1) };
    }
    return { kind: "ctx" as const, prefix: "", text: raw };
  });
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
