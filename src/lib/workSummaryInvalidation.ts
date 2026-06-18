import type { FsChangePayload } from "./api";
import { pathsIntersect } from "./pathUtils";

export function fsChangeTouchesRoot(
  payload: FsChangePayload,
  rootPath: string,
): boolean {
  if (payload.overflow && payload.refresh) {
    return pathsIntersect(payload.refresh.path, rootPath);
  }
  if (payload.root && pathsIntersect(payload.root, rootPath)) {
    return true;
  }
  return payload.paths.some((path) => pathsIntersect(path, rootPath));
}
