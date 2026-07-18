import { useState, type ComponentPropsWithoutRef } from "react";
import { defaultUrlTransform } from "react-markdown";
import { useTranslation } from "../../lib/useTranslation";

export type ImageSourceKind = "local" | "remote" | "unsafe";

export const MAX_DATA_IMAGE_SOURCE_BYTES = 2 * 1024 * 1024;

const SAFE_DATA_IMAGE_RE =
  /^data:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon|vnd\.microsoft\.icon)(?:[;,]|$)/i;

function parseImageUrl(value: string): URL | null {
  try {
    const base =
      typeof document === "undefined" ? "http://localhost/" : document.baseURI;
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function imageSourceKind(value: string): ImageSourceKind {
  const source = value.trim();
  if (!source) return "unsafe";
  // WHATWG URL parsing removes ASCII tab/newline characters even when they
  // split a scheme. Reject internal controls before classification so an
  // obfuscated remote or data URL cannot be mistaken for a relative path.
  if (/[\u0000-\u001f\u007f]/.test(source)) return "unsafe";

  if (/^data:/i.test(source)) {
    return source.length <= MAX_DATA_IMAGE_SOURCE_BYTES &&
      SAFE_DATA_IMAGE_RE.test(source) &&
      new TextEncoder().encode(source).byteLength <= MAX_DATA_IMAGE_SOURCE_BYTES
      ? "local"
      : "unsafe";
  }

  const url = parseImageUrl(source);
  if (!url) return "unsafe";

  if (url.protocol === "blob:" || url.protocol === "asset:") {
    return "local";
  }

  if (typeof document !== "undefined") {
    try {
      const documentUrl = new URL(document.baseURI);
      if (
        url.protocol === documentUrl.protocol &&
        url.host === documentUrl.host
      ) {
        return "local";
      }
    } catch {
      // Continue to the explicit protocol allowlist below.
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "unsafe";
  }

  if (url.protocol === "http:" && url.host === "asset.localhost") {
    return "local";
  }
  if (typeof window !== "undefined" && url.origin === window.location.origin) {
    return "local";
  }

  return "remote";
}

export function markdownImageUrlTransform(
  value: string,
  key: string,
  node: { tagName?: string },
): string | undefined {
  if (key === "src" && node.tagName === "img") {
    return imageSourceKind(value) === "unsafe" ? "" : value;
  }
  return defaultUrlTransform(value);
}

type RemoteImageProps = ComponentPropsWithoutRef<"img">;

export function RemoteImage({
  src,
  // Each responsive candidate would need independent approval.
  srcSet: _srcSet,
  sizes: _sizes,
  alt = "",
  referrerPolicy,
  ...props
}: RemoteImageProps) {
  const t = useTranslation();
  const source = src?.trim() ?? "";
  const kind = imageSourceKind(source);
  const remoteHost = kind === "remote" ? parseImageUrl(source)?.host : null;
  // Approval is URL-specific so content updates cannot reuse it for a new URL.
  const [approvedRemoteSource, setApprovedRemoteSource] = useState<
    string | null
  >(null);

  if (kind === "unsafe") {
    return alt ? <span>{alt}</span> : null;
  }

  if (kind === "remote" && approvedRemoteSource !== source) {
    const loadLabel = t("remoteImage.load");
    const approvalLabel = `${loadLabel}: ${remoteHost ?? source}${alt ? ` — ${alt}` : ""}`;
    return (
      <button
        type="button"
        aria-label={approvalLabel}
        data-remote-image-placeholder
        onClick={() => setApprovedRemoteSource(source)}
        className="my-2 max-w-full rounded border border-border bg-bg-elevated px-3 py-2 text-left text-[11px] text-fg-muted transition hover:border-fg-subtle hover:text-fg"
      >
        {loadLabel}
        {remoteHost ? (
          <span className="ml-1 font-mono text-[10px]">({remoteHost})</span>
        ) : null}
        {alt ? <span className="mt-1 block truncate text-fg">{alt}</span> : null}
      </button>
    );
  }

  return (
    <img
      {...props}
      src={source}
      alt={alt}
      referrerPolicy={kind === "remote" ? "no-referrer" : referrerPolicy}
    />
  );
}
