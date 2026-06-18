export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function relativePath(rootPath: string, path: string): string {
  const root = normalizePath(rootPath);
  const normalized = normalizePath(path);
  if (normalized === root) return basename(path);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : path;
}

export function pathsIntersect(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return (
    left === right ||
    normalizedPathInside(left, right) ||
    normalizedPathInside(right, left)
  );
}

function normalizedPathInside(path: string, root: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}
