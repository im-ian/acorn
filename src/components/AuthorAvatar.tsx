import { cn } from "../lib/cn";

/**
 * Inline GitHub avatar. Uses the public `github.com/{login}.png` endpoint
 * so no API token is needed and `[bot]` accounts still resolve once the
 * suffix is stripped. Falls back invisibly via `alt=""` on load failure
 * so the surrounding list / timeline stays clean.
 */
export function AuthorAvatar({
  login,
  size = 24,
  className,
}: {
  login: string;
  size?: number;
  className?: string;
}) {
  const slug = login.replace(/\[bot\]$/, "");
  if (!slug) return null;
  const pixelSize = Math.max(40, size * 2);
  return (
    <img
      src={`https://github.com/${encodeURIComponent(slug)}.png?size=${pixelSize}`}
      alt=""
      title={login}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
      className={cn(
        "shrink-0 rounded-full bg-bg-elevated align-middle",
        className,
      )}
    />
  );
}
