const LEGACY_RESTORE_MARKER_TEXT = "— restored from previous session —";

const OSC_SEQUENCE_RE = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g;
const STRING_SEQUENCE_RE =
  /(?:\x1b[P_^X]|\x90|\x98|\x9e|\x9f)[\s\S]*?(?:\x1b\\|\x9c)/g;
const CSI_SEQUENCE_RE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE_RE = /\x1b[ -/]*[0-~]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

const LINE_RE = /[^\r\n]*(?:\r\n|\n|\r|$)/g;

function stripTerminalControls(input: string): string {
  return input
    .replace(OSC_SEQUENCE_RE, "")
    .replace(STRING_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(ESCAPE_SEQUENCE_RE, "")
    .replace(CONTROL_RE, "");
}

function visibleLines(input: string): string[] {
  return stripRestoreMarkers(input)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => stripTerminalControls(line).trim())
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
      return !stripTerminalControls(chunk).includes(LEGACY_RESTORE_MARKER_TEXT);
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
