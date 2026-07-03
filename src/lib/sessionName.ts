import type { Session, SessionKind } from "./types";
import { WORKTREE_CITY_SLUGS } from "./worktreeCitySlugs";

const DEFAULT_SESSION_NAME = "new session";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Pick a session name that doesn't collide with any name in `existing`.
 *
 * Isolated sessions follow a `{repo}-worktree-{city}` convention because
 * each one maps to a linked git worktree at `.acorn/worktrees/<name>/`.
 * Control sessions get a `control-` prefix so they sort into their own
 * namespace. Regular sessions use a stable placeholder tab name and get a
 * numeric suffix starting at `-1` on collision.
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
    let candidate = `${base}-${randomWorktreeSlug()}`;
    for (let attempts = 0; attempts < 100; attempts++) {
      if (!taken.has(candidate)) return candidate;
      candidate = `${base}-${randomWorktreeSlug()}`;
    }
    let n = 2;
    while (taken.has(`${candidate}-${n}`)) n++;
    return `${candidate}-${n}`;
  }
  if (kind !== "control") {
    return suggestDefaultSessionName(existing);
  }
  const base = `control-${basename(repoPath)}`;
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

export function suggestDefaultSessionName(existing: Session[]): string {
  return suggestNumberedName(DEFAULT_SESSION_NAME, existing);
}

export function suggestLocalSessionName(existing: Session[]): string {
  return suggestDefaultSessionName(existing);
}

function suggestNumberedName(base: string, existing: Session[]): string {
  const taken = new Set(existing.map((s) => s.name));
  let candidate = base;
  let n = 1;
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

function randomWorktreeSlug(): string {
  const seed = randomUint32();
  const city =
    WORKTREE_CITY_SLUGS[seed % WORKTREE_CITY_SLUGS.length] ??
    WORKTREE_CITY_SLUGS[0];
  return city;
}

function randomUint32(): number {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    const seed = Number.parseInt(
      webCrypto.randomUUID().replace(/-/g, "").slice(0, 8),
      16,
    );
    if (Number.isFinite(seed)) return seed;
  }

  const bytes = new Uint32Array(1);
  if (webCrypto) {
    webCrypto.getRandomValues(bytes);
    return bytes[0] ?? 0;
  } else {
    return Math.floor(Math.random() * 0xffffffff);
  }
}
