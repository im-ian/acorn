export const RESTORE_MARKER_TEXT = "— restored from previous session —";

const ANSI_ESCAPE_RE =
  // OSC, CSI, and common one-character escape sequences.
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;

const LINE_RE = /[^\r\n]*(?:\r\n|\n|\r|$)/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

function visibleLines(input: string): string[] {
  return stripRestoreMarkers(input)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0);
}

function isLikelyPromptOnlyLine(line: string): boolean {
  if (/^[#$%>❯]\s*$/u.test(line)) return true;
  return /^[\w.@:/~+\-()[\]]+(?:\s+[\w.@:/~+\-()[\]]+)*\s+[#$%>❯]\s*$/u.test(
    line,
  );
}

export function stripRestoreMarkers(input: string): string {
  const chunks = input.match(LINE_RE) ?? [];
  return chunks
    .filter((chunk) => {
      if (chunk.length === 0) return false;
      return !stripAnsi(chunk).includes(RESTORE_MARKER_TEXT);
    })
    .join("");
}

export function shouldRestoreScrollback(input: string): boolean {
  const lines = visibleLines(input);
  if (lines.length === 0) return false;
  return lines.some((line) => !isLikelyPromptOnlyLine(line));
}

export function prepareScrollbackForSave(input: string): string {
  const withoutMarkers = stripRestoreMarkers(input);
  return shouldRestoreScrollback(withoutMarkers) ? withoutMarkers : "";
}
