/** Compact age: just now, 10m, 1h, 1d, 1y. `justNow` is the localized label. */
export function taskAgeLabel(iso: string, nowMs: number, justNow: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (diffSec < 60) return justNow;
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diffSec / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(diffSec / 86400);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

export function taskAbsoluteTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  return new Date(then).toLocaleString();
}
