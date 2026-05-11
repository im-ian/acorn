/**
 * GitHub Releases fetcher for the in-app "What's new" surface.
 *
 * The Tauri updater only ships notes for the *next* version (the one
 * waiting to install). To surface notes for the version the user is
 * already running — even when no update is pending — we query the
 * public GitHub Releases API directly. Unauthenticated requests get
 * 60/hour per IP, which is more than enough for occasional clicks from
 * the About tab.
 */

const RELEASE_OWNER = "im-ian";
const RELEASE_REPO = "acorn";

export interface ReleaseNotes {
  /** Tag stripped of leading "v" — matches `tauri --version` output. */
  version: string;
  /** Raw markdown body of the release (may be empty). */
  body: string;
  /** Public URL of the release on GitHub. */
  htmlUrl: string;
  /** ISO timestamp the release was published. */
  publishedAt: string;
}

interface GithubReleasePayload {
  tag_name: string;
  body: string | null;
  html_url: string;
  published_at: string;
}

/**
 * Fetch release notes for a specific version. Returns `null` when GitHub
 * has no release for that tag (404) so the caller can render an
 * "unpublished" message instead of an error. Network / 5xx / parse
 * failures throw — the UI surfaces them inline.
 */
export async function fetchReleaseNotes(
  version: string,
): Promise<ReleaseNotes | null> {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub releases request failed: ${res.status}`);
  }
  const json = (await res.json()) as GithubReleasePayload;
  return {
    version: json.tag_name.replace(/^v/, ""),
    body: json.body ?? "",
    htmlUrl: json.html_url,
    publishedAt: json.published_at,
  };
}

/**
 * Fetch the most recently published release. Used as a fallback when the
 * currently installed version doesn't have a corresponding public
 * release on GitHub (private hotfix tags, locally bumped dev builds,
 * pre-release versions, etc.). Throws on any non-200 — there is no
 * meaningful "no releases exist" UX, so the caller surfaces the error.
 */
export async function fetchLatestReleaseNotes(): Promise<ReleaseNotes> {
  const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub releases request failed: ${res.status}`);
  }
  const json = (await res.json()) as GithubReleasePayload;
  return {
    version: json.tag_name.replace(/^v/, ""),
    body: json.body ?? "",
    htmlUrl: json.html_url,
    publishedAt: json.published_at,
  };
}
