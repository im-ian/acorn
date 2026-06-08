/**
 * Upper bound on simultaneously-mounted terminal sessions. Each mounted
 * terminal keeps a full xterm instance plus its scrollback buffer resident in
 * memory; without a cap, every session a user has ever viewed stays alive for
 * the app's lifetime. Visible terminals are always exempt, so the effective cap
 * is `max(MAX_MOUNTED_TERMINALS, visibleCount)`.
 */
export const MAX_MOUNTED_TERMINALS = 12;

export interface EvictionPlanInput {
  /** Session ids currently mounted. */
  mounted: readonly string[];
  /** Session ids visible right now — never evicted. */
  visible: ReadonlySet<string>;
  /** Mounted ids in least-recently-visible → most-recently-visible order. */
  recency: readonly string[];
  /**
   * Ids whose shell is daemon-backed and alive. Only these can be evicted: an
   * in-process shell has no re-attach replay, so detaching it would strand the
   * user on a blank terminal.
   */
  daemonAlive: ReadonlySet<string>;
  /** Effective cap (already widened to cover the visible set). */
  max: number;
}

/**
 * Choose which mounted terminals to evict (detach) to get back under `max`.
 *
 * Eligibility is deliberately conservative: visible terminals stay, and only
 * daemon-alive sessions are eligible because in-process shells cannot be
 * re-attached after a detach. Victims are picked least-recently-visible first.
 * The result may be shorter than the overflow when too few sessions are
 * evictable — staying over the cap is preferable to killing a live shell.
 */
export function selectTerminalsToEvict(input: EvictionPlanInput): string[] {
  const { mounted, visible, recency, daemonAlive, max } = input;
  const overflow = mounted.length - max;
  if (overflow <= 0) return [];

  const mountedSet = new Set(mounted);
  const victims: string[] = [];
  for (const id of recency) {
    if (victims.length >= overflow) break;
    if (!mountedSet.has(id)) continue;
    if (visible.has(id)) continue;
    if (!daemonAlive.has(id)) continue;
    victims.push(id);
  }
  return victims;
}
