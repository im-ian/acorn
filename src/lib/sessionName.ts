import type { Session, SessionKind } from "./types";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Pick a session name that doesn't collide with any name in `existing`.
 *
 * Isolated sessions follow a `{repo}-worktree-{random}` convention because
 * each one maps to a linked git worktree at `.acorn/worktrees/<name>/`.
 * Avoiding sequential names keeps old agent transcripts from appearing to
 * point at a newly-created worktree that happened to reuse the same path.
 * Control sessions get a `control-` prefix so they sort into their own
 * namespace. Regular sessions use the bare repo basename and only get a
 * numeric suffix on collision.
 *
 * The generated isolated name is still only a candidate; the Rust backend's
 * `create_unique_worktree` re-suffixes on its own if it collides with an
 * existing branch or worktree.
 */
export function suggestSessionName(
  repoPath: string,
  existing: Session[],
  kind: SessionKind = "regular",
  isolated: boolean = false,
): string {
  const taken = new Set(existing.map((s) => s.name));
  if (isolated) {
    const base = `${basename(repoPath)}-worktree`;
    let candidate = `${base}-${randomWorktreeSuffix()}`;
    for (let attempts = 0; attempts < 100; attempts++) {
      if (!taken.has(candidate)) return candidate;
      candidate = `${base}-${randomWorktreeSuffix()}`;
    }
    let n = 2;
    while (taken.has(`${candidate}-${n}`)) n++;
    return `${candidate}-${n}`;
  }
  const base =
    kind === "control"
      ? `control-${basename(repoPath)}`
      : basename(repoPath);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

export function suggestLocalSessionName(existing: Session[]): string {
  const taken = new Set(existing.map((s) => s.name));
  const base = "terminal";
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

function randomWorktreeSuffix(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }

  const bytes = new Uint8Array(6);
  if (webCrypto) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
