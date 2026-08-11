import { getAgentMentionPrefix } from "./agentProviderRegistry";
import { normalizePath, pathsEqual, relativePath } from "./pathUtils";
import type { SessionAgentProvider } from "./types";

export function pathRelativeToCwd(filePath: string, cwd: string): string {
  if (pathsEqual(filePath, cwd)) return ".";
  return normalizePath(relativePath(cwd, filePath));
}

function escapeMentionPath(path: string): string {
  return path.replace(/([\\\s])/gu, "\\$1");
}

export function formatTerminalFileMention(
  filePath: string,
  cwd: string,
  options: { agentProvider?: SessionAgentProvider | null } = {},
): string {
  const prefix = getAgentMentionPrefix(options.agentProvider);
  return `${prefix}${escapeMentionPath(pathRelativeToCwd(filePath, cwd))} `;
}
