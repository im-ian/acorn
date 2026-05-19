import { cn } from "../lib/cn";

/**
 * Inline GitHub avatar. Uses an API-provided avatar URL when one is available,
 * and falls back to the public `github.com/{login}.png` endpoint so no API
 * token is needed for simple callers. Renders nothing when `login` is null,
 * empty, or doesn't look like a GitHub handle (e.g. a git author name with
 * spaces), so callers can pass nullable values without guarding.
 */
export function AuthorAvatar({
  login,
  avatarUrl,
  size = 24,
  className,
}: {
  login: string | null | undefined;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}) {
  if (!login) return null;
  const slug = login.replace(/\[bot\]$/, "");
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(slug)) return null;
  const pixelSize = Math.max(40, size * 2);
  const src = avatarUrl
    ? withAvatarSize(avatarUrl, pixelSize)
    : `https://github.com/${encodeURIComponent(slug)}.png?size=${pixelSize}`;
  return (
    <img
      src={src}
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

function withAvatarSize(src: string, size: number): string {
  try {
    const url = new URL(src);
    url.searchParams.set("s", String(size));
    return url.toString();
  } catch {
    return src;
  }
}
