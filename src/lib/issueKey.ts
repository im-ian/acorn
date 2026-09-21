const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/gi;

export function parseIssueKey(
  text: string,
  allowedPrefixes: readonly string[],
): string | null {
  const prefixes = new Set(
    allowedPrefixes
      .map((prefix) => prefix.trim().toUpperCase())
      .filter((prefix) => prefix.length > 0),
  );
  if (prefixes.size === 0) return null;
  for (const match of text.matchAll(ISSUE_KEY_RE)) {
    const key = match[1]?.toUpperCase();
    if (!key) continue;
    const prefix = key.slice(0, key.lastIndexOf("-"));
    if (prefixes.has(prefix)) return key;
  }
  return null;
}
