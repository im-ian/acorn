const SHELL_COMMAND_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

export function normalizeShellCommandWhitespace(input: string): string {
  return input.replace(SHELL_COMMAND_SPACE_RE, " ");
}
