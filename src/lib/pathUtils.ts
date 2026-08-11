function usesWindowsCaseSemantics(path: string): boolean {
  return /^[a-zA-Z]:/u.test(path) || path.startsWith("//");
}

function comparisonPath(path: string): string {
  const normalized = normalizePath(path);
  return usesWindowsCaseSemantics(normalized)
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function isDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:[\\/]+$/u.test(path);
}

function isUncShareRoot(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("//")) return false;
  return normalized.slice(2).split("/").filter(Boolean).length <= 2;
}

function preferredSeparator(path: string): "/" | "\\" {
  if (/^[a-zA-Z]:\\/u.test(path) || path.startsWith("\\\\")) {
    return "\\";
  }
  if (path.includes("\\") && !path.includes("/")) return "\\";
  return "/";
}

export function normalizePath(path: string): string {
  if (path.length === 0) return path;

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
export function trimTrailingPathSeparators(path: string): string {
  if (path.length === 0 || /^[\\/]+$/u.test(path) || isDriveRoot(path)) {
    return path;
  }
  return path.replace(/[\\/]+$/u, "");
}

export function basename(path: string): string {
  const trimmed = trimTrailingPathSeparators(path);
  const parts = trimmed.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

export function parentPath(path: string): string {
  const trimmed = trimTrailingPathSeparators(path);
  if (
    trimmed.length === 0 ||
    /^[\\/]+$/u.test(trimmed) ||
    isDriveRoot(trimmed) ||
    isUncShareRoot(trimmed)
  ) {
    return trimmed;
  }

  const slash = trimmed.lastIndexOf("/");
  const backslash = trimmed.lastIndexOf("\\");
  const index = Math.max(slash, backslash);
  if (index < 0) return ".";

  const separator = trimmed[index];
  const parent = trimmed.slice(0, index);
  if (parent.length === 0) return separator;
  if (/^[a-zA-Z]:$/u.test(parent)) return `${parent}${separator}`;
  return parent;
}

export function joinPath(base: string, child: string): string {
  const separator = preferredSeparator(base);
  const relative = child
    .replace(/^[\\/]+/u, "")
    .replace(/[\\/]+/gu, separator);
  const trimmedBase = trimTrailingPathSeparators(base);
  if (trimmedBase.endsWith("/") || trimmedBase.endsWith("\\")) {
    return `${trimmedBase}${relative}`;
  }
  return `${trimmedBase}${separator}${relative}`;
}

export function pathsEqual(a: string, b: string): boolean {
  return comparisonPath(a) === comparisonPath(b);
}

export function isPathInsideOrEqual(path: string, rootPath: string): boolean {
  const pathKey = comparisonPath(path);
  const rootKey = comparisonPath(rootPath);
  if (pathKey === rootKey) return true;
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return pathKey.startsWith(prefix);
}

export function relativePath(rootPath: string, path: string): string {
  const root = normalizePath(rootPath);
  const normalized = normalizePath(path);
  if (pathsEqual(normalized, root)) return basename(path);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const rootKey = comparisonPath(root);
  const prefixKey = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return comparisonPath(normalized).startsWith(prefixKey)
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
