import type { SessionAgentProvider } from "./types";

function normalizePath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/u, "");
}

export function pathRelativeToCwd(filePath: string, cwd: string): string {
  const normalizedFile = normalizePath(filePath);
  const normalizedCwd = normalizePath(cwd);
  if (normalizedFile === normalizedCwd) return ".";
  const prefix = `${normalizedCwd}/`;
  if (normalizedFile.startsWith(prefix)) {
    return normalizedFile.slice(prefix.length);
  }
  return normalizedFile;
}

function escapeMentionPath(path: string): string {
  return path.replace(/([\\\s])/gu, "\\$1");
}

export function formatTerminalFileMention(
  filePath: string,
  cwd: string,
  options: { agentProvider?: SessionAgentProvider | null } = {},
): string {
  const prefix = options.agentProvider === "claude" ? "@" : "";
  return `${prefix}${escapeMentionPath(pathRelativeToCwd(filePath, cwd))} `;
}
