export { joinPath } from "./pathUtils";

export function fileUrlToPath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/^\/[a-zA-Z]:\//u.test(path)) {
    path = path.slice(1);
  }
  if (url.hostname && url.hostname !== "localhost") {
    return `//${url.hostname}${path}`;
  }
  return path;
}
