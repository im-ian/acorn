import { cn } from "../lib/cn";

/**
 * Inline GitHub avatar. Uses the public `github.com/{login}.png` endpoint
 * so no API token is needed and `[bot]` accounts still resolve once the
 * suffix is stripped. Renders nothing when `login` is null, empty, or
 * doesn't look like a GitHub handle (e.g. a git author name with spaces),
 * so callers can pass nullable values without guarding.
 */
export function AuthorAvatar({
  login,
  size = 24,
  className,
}: {
  login: string | null | undefined;
  size?: number;
  className?: string;
}) {
  if (!login) return null;
  const slug = login.replace(/\[bot\]$/, "");
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(slug)) return null;
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
