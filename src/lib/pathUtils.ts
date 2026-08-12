export type PathFlavor = "posix" | "windows";

function explicitPathFlavor(path: string): PathFlavor | null {
  if (
    /^[a-zA-Z]:/u.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//")
  ) {
    return "windows";
  }
  if (path.startsWith("/")) return "posix";
  return null;
}

/**
 * Infer how separators in a path should be interpreted. Absolute roots are
 * authoritative; an unanchored relative path containing a backslash keeps the
 * Windows-compatible behavior used by terminal output and Git paths.
 */
export function inferPathFlavor(path: string): PathFlavor {
  return explicitPathFlavor(path) ?? (path.includes("\\") ? "windows" : "posix");
}

function anchoredPathFlavor(anchor: string, other?: string): PathFlavor {
  return (
    explicitPathFlavor(anchor) ??
    (other === undefined ? null : explicitPathFlavor(other)) ??
    (anchor.includes("\\") || other?.includes("\\") ? "windows" : "posix")
  );
}

function comparisonPath(path: string, flavor: PathFlavor): string {
  const normalized = normalizePath(path, flavor);
  return flavor === "windows"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function isDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:[\\/]+$/u.test(path);
}

function isUncShareRoot(path: string, flavor: PathFlavor): boolean {
  if (flavor !== "windows") return false;
  const normalized = normalizePath(path, flavor);
  if (!normalized.startsWith("//")) return false;
  return normalized.slice(2).split("/").filter(Boolean).length <= 2;
}

function preferredSeparator(path: string, flavor: PathFlavor): "/" | "\\" {
  if (flavor === "posix") return "/";
  if (/^[a-zA-Z]:\\/u.test(path) || path.startsWith("\\\\")) {
    return "\\";
  }
  if (path.includes("\\") && !path.includes("/")) return "\\";
  return "/";
}

export function normalizePath(
  path: string,
  flavor: PathFlavor = inferPathFlavor(path),
): string {
  if (path.length === 0) return path;

  if (flavor === "posix") {
    const normalized = path.replace(/\/+/gu, "/");
    if (/^\/+$/u.test(normalized)) return "/";
    return normalized.replace(/\/+$/u, "");
  }

  const unc = /^[\\/]{2}[^\\/]/u.test(path);
  let normalized = path.replace(/[\\/]+/gu, "/");
  if (unc && !normalized.startsWith("//")) normalized = `/${normalized}`;

  if (/^\/+$/u.test(normalized)) return "/";
  if (/^[a-zA-Z]:\/+$/u.test(normalized)) {
    return `${normalized.slice(0, 2)}/`;
  }
  return normalized.replace(/\/+$/u, "");
}

/**
 * Remove trailing separators without changing the path's native separator
 * style. Filesystem roots remain usable rather than collapsing to an empty
 * string or a drive-relative path.
 */
export function trimTrailingPathSeparators(
  path: string,
  flavor: PathFlavor = inferPathFlavor(path),
): string {
  if (path.length === 0) return path;
  if (flavor === "posix") {
    return /^\/+$/u.test(path) ? path : path.replace(/\/+$/u, "");
  }
  if (/^[\\/]+$/u.test(path) || isDriveRoot(path)) return path;
  return path.replace(/[\\/]+$/u, "");
}

export function basename(
  path: string,
  flavor: PathFlavor = inferPathFlavor(path),
): string {
  const trimmed = trimTrailingPathSeparators(path, flavor);
  const parts = trimmed
    .split(flavor === "windows" ? /[\\/]/u : /\//u)
    .filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

export function parentPath(
  path: string,
  flavor: PathFlavor = inferPathFlavor(path),
): string {
  const trimmed = trimTrailingPathSeparators(path, flavor);
  const isRoot =
    flavor === "windows" ? /^[\\/]+$/u.test(trimmed) : /^\/+$/u.test(trimmed);
  if (
    trimmed.length === 0 ||
    isRoot ||
    (flavor === "windows" && isDriveRoot(trimmed)) ||
    isUncShareRoot(trimmed, flavor)
  ) {
    return trimmed;
  }

  const slash = trimmed.lastIndexOf("/");
  const backslash = flavor === "windows" ? trimmed.lastIndexOf("\\") : -1;
  const index = Math.max(slash, backslash);
  if (index < 0) return ".";

  const separator = trimmed[index];
  const parent = trimmed.slice(0, index);
  if (parent.length === 0) return separator;
  if (flavor === "windows" && /^[a-zA-Z]:$/u.test(parent)) {
    return `${parent}${separator}`;
  }
  return parent;
}

export function joinPath(base: string, child: string): string {
  const flavor = inferPathFlavor(base);
  const separator = preferredSeparator(base, flavor);
  const relative =
    flavor === "windows"
      ? child.replace(/^[\\/]+/u, "").replace(/[\\/]+/gu, separator)
      : child.replace(/^\/+/u, "").replace(/\/+/gu, separator);
  const trimmedBase = trimTrailingPathSeparators(base, flavor);
  const endsWithSeparator =
    flavor === "windows"
      ? trimmedBase.endsWith("/") || trimmedBase.endsWith("\\")
      : trimmedBase.endsWith("/");
  if (endsWithSeparator) return `${trimmedBase}${relative}`;
  return `${trimmedBase}${separator}${relative}`;
}

export function pathsEqual(a: string, b: string): boolean {
  const flavor = anchoredPathFlavor(a, b);
  return comparisonPath(a, flavor) === comparisonPath(b, flavor);
}

export function isPathInsideOrEqual(path: string, rootPath: string): boolean {
  const flavor = anchoredPathFlavor(rootPath, path);
  const pathKey = comparisonPath(path, flavor);
  const rootKey = comparisonPath(rootPath, flavor);
  if (pathKey === rootKey) return true;
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return pathKey.startsWith(prefix);
}

export function relativePath(rootPath: string, path: string): string {
  const flavor = anchoredPathFlavor(rootPath, path);
  const root = normalizePath(rootPath, flavor);
  const normalized = normalizePath(path, flavor);
  if (comparisonPath(normalized, flavor) === comparisonPath(root, flavor)) {
    return basename(path, flavor);
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const rootKey = comparisonPath(root, flavor);
  const prefixKey = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return comparisonPath(normalized, flavor).startsWith(prefixKey)
    ? normalized.slice(prefix.length)
    : path;
}

export function pathsIntersect(a: string, b: string): boolean {
  return isPathInsideOrEqual(a, b) || isPathInsideOrEqual(b, a);
}

export function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/u.test(path) ||
    /^[\\/]{2}[^\\/]/u.test(path)
  );
}
