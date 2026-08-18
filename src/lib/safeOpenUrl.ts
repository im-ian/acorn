import { api } from "./api";

const WEB_URL_PREFIX_RE = /^https?:\/\//i;
const MAILTO_PREFIX_RE = /^mailto:/i;
const MAX_OPEN_URL_BYTES = 8 * 1024;
const SAFE_MAILTO_FIELDS = new Set(["bcc", "body", "cc", "subject"]);

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * URLs handed to the OS opener originate in untrusted Markdown and API data.
 * Keep this check stricter than WHATWG parsing: that parser normalizes tabs,
 * newlines, and backslashes in ways that can make the clicked target differ
 * from the source text a user saw.
 */
export function isSafeOpenUrl(value: string): boolean {
  if (
    !value ||
    utf8Length(value) > MAX_OPEN_URL_BYTES ||
    /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    if (WEB_URL_PREFIX_RE.test(value)) {
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname.length > 0 &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    }
    if (
      !MAILTO_PREFIX_RE.test(value) ||
      url.protocol !== "mailto:" ||
      url.pathname.length === 0 ||
      url.hash.length > 0
    ) {
      return false;
    }
    return [...url.searchParams.keys()].every((key) =>
      SAFE_MAILTO_FIELDS.has(key.toLowerCase()),
    );
  } catch {
    return false;
  }
}

/**
 * The OS opener is a privileged boundary. The Rust command independently
 * applies the same policy before opening, so a compromised renderer cannot
 * bypass this helper through a broad plugin permission.
 */
export async function openSafeUrl(value: string): Promise<boolean> {
  if (!isSafeOpenUrl(value)) {
    return false;
  }
  return api.openExternalUrl(value);
}
