interface DataTransferItemLike {
  kind: string;
}

interface FileLike {
  name?: unknown;
  path?: unknown;
}

interface FileDropDataTransferLike {
  types?: ArrayLike<string> | Iterable<string>;
  items?: ArrayLike<DataTransferItemLike> | null;
  files?: ArrayLike<FileLike> | null;
  getData(type: string): string;
}

const NATIVE_FILE_TYPES = new Set(["Files", "public.file-url"]);
const FILE_URL_DATA_TYPES = ["text/uri-list", "public.file-url", "URL"];
const FILE_URL_TRANSFER_TYPES = new Set(FILE_URL_DATA_TYPES);

function arrayFromList<T>(
  value: ArrayLike<T> | Iterable<T> | null | undefined,
): T[] {
  if (!value) return [];
  return Array.from(value);
}

function getTransferTypes(dataTransfer: FileDropDataTransferLike): string[] {
  return arrayFromList(dataTransfer.types).filter(
    (type): type is string => typeof type === "string",
  );
}

function getTransferData(
  dataTransfer: FileDropDataTransferLike,
  type: string,
): string {
  try {
    return dataTransfer.getData(type);
  } catch {
    return "";
  }
}

function fileUrlToPath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;

  let path = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:\//u.test(path)) {
    path = path.slice(1);
  }
  if (url.hostname && url.hostname !== "localhost") {
    return `//${url.hostname}${path}`;
  }
  return path;
}

function collectUriListPaths(value: string, paths: string[]): void {
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const path = fileUrlToPath(line);
    if (path) paths.push(path);
  }
}

function collectPlainTextPaths(value: string, paths: string[]): void {
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("file:")) {
      const path = fileUrlToPath(line);
      if (path) paths.push(path);
      continue;
    }
    if (line.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(line)) {
      paths.push(line);
    }
  }
}

function uniqueNonEmpty(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function hasNativeFileDropData(
  dataTransfer: FileDropDataTransferLike | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  if (arrayFromList(dataTransfer.files).length > 0) return true;
  if (
    getTransferTypes(dataTransfer).some((type) => NATIVE_FILE_TYPES.has(type))
  ) {
    return true;
  }
  if (
    getTransferTypes(dataTransfer).some((type) =>
      FILE_URL_TRANSFER_TYPES.has(type),
    )
  ) {
    return true;
  }
  return arrayFromList(dataTransfer.items).some((item) => item.kind === "file");
}

export function extractNativeFileDropPaths(
  dataTransfer: FileDropDataTransferLike | null | undefined,
): string[] {
  if (!dataTransfer || !hasNativeFileDropData(dataTransfer)) return [];

  const paths: string[] = [];
  for (const file of arrayFromList(dataTransfer.files)) {
    if (typeof file.path === "string" && file.path.length > 0) {
      paths.push(file.path);
    }
  }

  for (const type of FILE_URL_DATA_TYPES) {
    collectUriListPaths(getTransferData(dataTransfer, type), paths);
  }
  collectPlainTextPaths(getTransferData(dataTransfer, "text/plain"), paths);

  return uniqueNonEmpty(paths);
}
