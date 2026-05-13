import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AuthorAvatar } from "./AuthorAvatar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { cn } from "../lib/cn";

/**
 * GitHub login regex. `[bot]` suffix is stripped before this check.
 * Anything with whitespace, slashes, or other shell-y characters falls
 * through — keeps us from sending `firstname lastname.png` to github.com
 * when only a git author name (no resolved login) is available.
 */
function isLikelyLogin(value: string | null | undefined): value is string {
  if (!value) return false;
  const slug = value.replace(/\[bot\]$/, "");
  return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(slug);
}

/**
 * Extract a GitHub login from a git author email. GitHub's noreply
 * addresses come in two flavors:
 *   - `{id}+{login}@users.noreply.github.com` (current)
 *   - `{login}@users.noreply.github.com` (legacy / pre-2017 opt-in)
 * Returns null for any other domain — local git commits authored
 * without a GitHub noreply address have no resolvable login.
 */
export function loginFromEmail(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const m = email.match(
    /^(?:\d+\+)?([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})@users\.noreply\.github\.com$/i,
  );
  return m?.[1] ?? null;
}

/**
 * Build a ContextMenuItem array for "Open GitHub profile". Empty when
 * `login` doesn't look like a real handle, so callers can spread it into
 * larger menus without checking first.
 */
export function buildProfileMenuItems(
  login: string | null | undefined,
): ContextMenuItem[] {
  if (!isLikelyLogin(login)) return [];
  const slug = login.replace(/\[bot\]$/, "");
  return [
    {
      label: "Open GitHub profile",
      icon: <ExternalLink size={12} />,
      onClick: () => void openUrl(`https://github.com/${slug}`),
    },
  ];
}

/**
 * Avatar + login pair with a right-click context menu offering "Open
 * GitHub profile". When `login` isn't a resolvable GitHub handle, only
 * `fallbackName` text renders (no avatar, no menu).
 */
export function AuthorTag({
  login,
  fallbackName,
  size = 24,
  nameClass,
  avatarOnly = false,
}: {
  login: string | null | undefined;
  /** Plain-text name shown when `login` isn't a resolvable GitHub handle. */
  fallbackName?: string;
  size?: number;
  nameClass?: string;
  /** When true, render only the avatar (no inline username text). */
  avatarOnly?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasLogin = isLikelyLogin(login);
  const items = buildProfileMenuItems(login);

  if (!hasLogin) {
    if (!fallbackName) return null;
    return (
      <span className={cn("font-mono text-fg", nameClass)}>{fallbackName}</span>
    );
  }

  return (
    <>
      <span
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className="inline-flex shrink-0 items-center gap-1.5 align-middle"
      >
        <AuthorAvatar login={login} size={size} />
        {avatarOnly ? null : (
          <span className={cn("font-mono text-fg", nameClass)}>{login}</span>
        )}
      </span>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
      />
    </>
  );
}
