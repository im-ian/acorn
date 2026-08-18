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
const MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024;
const RELEASE_REQUEST_TIMEOUT_MS = 15_000;

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

function parseReleasePayload(value: unknown): ReleaseNotes {
  if (!value || typeof value !== "object") {
    throw new Error("GitHub release response is not an object");
  }
  const release = value as Record<string, unknown>;
  const tag = release.tag_name;
  const body = release.body;
  const htmlUrl = release.html_url;
  const publishedAt = release.published_at;
  if (
    typeof tag !== "string" ||
    tag.length === 0 ||
    tag.length > 128 ||
    (body !== null && typeof body !== "string") ||
    typeof htmlUrl !== "string" ||
    typeof publishedAt !== "string" ||
    publishedAt.length > 64 ||
    !Number.isFinite(Date.parse(publishedAt))
  ) {
    throw new Error("GitHub release response has invalid fields");
  }
  const parsedUrl = new URL(htmlUrl);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    !parsedUrl.pathname.startsWith(`/${RELEASE_OWNER}/${RELEASE_REPO}/releases/tag/`)
  ) {
    throw new Error("GitHub release response has an invalid release URL");
  }
  return {
    version: tag.replace(/^v/, ""),
    body: body ?? "",
    htmlUrl: parsedUrl.toString(),
    publishedAt,
  };
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RELEASE_RESPONSE_BYTES) {
      throw new Error("GitHub release response is too large");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RELEASE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("GitHub release response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function withReleaseResponse<T>(
  url: string,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    RELEASE_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    return await consume(response);
  } finally {
    window.clearTimeout(timeout);
  }
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
  return withReleaseResponse(url, async (response) => {
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: ${response.status}`);
    }
    return parseReleasePayload(
      JSON.parse(await readBoundedResponseText(response)),
    );
  });
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
  return withReleaseResponse(url, async (response) => {
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: ${response.status}`);
    }
    return parseReleasePayload(
      JSON.parse(await readBoundedResponseText(response)),
    );
  });
}
