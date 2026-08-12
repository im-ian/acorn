import type {
  IBufferLine,
  ILink,
  ILinkProvider,
  Terminal as XTerm,
} from "@xterm/xterm";
import {
  inferPathFlavor,
  isAbsolutePath,
  normalizePath,
  pathsEqual,
  type PathFlavor,
} from "./pathUtils";

export interface TerminalFileReference {
  path: string;
  line?: number;
  column?: number;
  text: string;
  startIndex: number;
  absolutePath?: string;
}

export interface TerminalFileLinkProviderOptions {
  activate: (event: MouseEvent, reference: TerminalFileReference) => void;
  resolveReferences?: (
    references: TerminalFileReference[],
  ) => TerminalFileReference[] | Promise<TerminalFileReference[]>;
  hover?: (
    event: MouseEvent,
    reference: TerminalFileReference,
    link: ILink,
  ) => void;
  leave?: (event: MouseEvent, reference: TerminalFileReference) => void;
}

const LINK_PREFIX_RE = String.raw`(^|[\s([{"'\x60<])`;
const PATH_SEPARATOR_RE = String.raw`[\\/]`;
const OPTIONAL_PATH_ROOT_RE = String.raw`(?:(?:[A-Za-z]:|~|\.{1,2})${PATH_SEPARATOR_RE}|${PATH_SEPARATOR_RE}{1,2})?`;
// Next.js route groups need parentheses in directory segments, but the final
// file segment excludes them so code like `unwrap().reset_at` is not linked.
const DIRECTORY_SEGMENT_RE = String.raw`[\p{L}\p{N}._@+\[\]()-]+`;
const FILE_SEGMENT_RE = String.raw`[\p{L}\p{N}._@+\[\]-]+`;
const FILE_STEM_RE = String.raw`[\p{L}\p{N}._@+\[\]-]*`;
const FILE_REF_PATH_RE = String.raw`${OPTIONAL_PATH_ROOT_RE}(?:(?:${DIRECTORY_SEGMENT_RE}${PATH_SEPARATOR_RE})+${FILE_SEGMENT_RE}|${FILE_STEM_RE}\.${FILE_SEGMENT_RE})`;
const FILE_EXTENSION_RE = String.raw`[\p{L}][\p{L}\p{N}_@+\[\]-]+`;
const FILE_PATH_REQUIRING_EXTENSION_RE = String.raw`${OPTIONAL_PATH_ROOT_RE}(?:(?:${DIRECTORY_SEGMENT_RE}${PATH_SEPARATOR_RE})+${FILE_STEM_RE}\.${FILE_EXTENSION_RE}|${FILE_STEM_RE}\.${FILE_EXTENSION_RE})`;
const FILE_REF_LOCATION_RE = String.raw`:(?:(\d{1,7})(?:-\d{1,7})?(?::(\d{1,5}))?)?`;
const FILE_REF_TRAILER_RE = String.raw`(?=$|[\s)\]}>,;!?:]|[.](?=$|[\s)\]}>,;!?:]))`;
const FILE_PATH_TRAILER_RE = String.raw`(?=$|[\s)\]}>,;!?]|[.](?=$|[\s)\]}>,;!?]))`;
const QUOTED_LINK_PREFIX_RE = String.raw`(^|[\s([{<])`;
const QUOTED_WINDOWS_ROOT_RE = String.raw`(?:[A-Za-z]:${PATH_SEPARATOR_RE}|${PATH_SEPARATOR_RE}{2})`;
const QUOTED_WINDOWS_PATH_RE = String.raw`${QUOTED_WINDOWS_ROOT_RE}[^"\r\n]*?\.${FILE_EXTENSION_RE}`;
const QUOTED_WINDOWS_FILE_REF_RE = new RegExp(
  `${QUOTED_LINK_PREFIX_RE}"((${QUOTED_WINDOWS_PATH_RE})(?:${FILE_REF_LOCATION_RE})?)"`,
  "gu",
);
const FILE_REF_RE = new RegExp(
  `${LINK_PREFIX_RE}(${FILE_REF_PATH_RE})${FILE_REF_LOCATION_RE}${FILE_REF_TRAILER_RE}`,
  "gu",
);
const FILE_PATH_RE = new RegExp(
  `${LINK_PREFIX_RE}(${FILE_PATH_REQUIRING_EXTENSION_RE})${FILE_PATH_TRAILER_RE}`,
  "gu",
);

export function createTerminalFileLinkProvider(
  terminal: XTerm,
  options: TerminalFileLinkProviderOptions,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const references = findTerminalFileReferences(text);
      if (references.length === 0) {
        callback(undefined);
        return;
      }
      const provide = (resolvedReferences: TerminalFileReference[]) => {
        if (resolvedReferences.length === 0) {
          callback(undefined);
          return;
        }
        callback(
          resolvedReferences.map((reference) =>
            createTerminalFileLink(
              line,
              bufferLineNumber,
              reference,
              options,
            ),
          ),
        );
      };
      if (!options.resolveReferences) {
        provide(references);
        return;
      }
      void Promise.resolve(options.resolveReferences(references))
        .then(provide)
        .catch(() => callback(undefined));
    },
  };
}

function createTerminalFileLink(
  line: IBufferLine,
  bufferLineNumber: number,
  reference: TerminalFileReference,
  options: TerminalFileLinkProviderOptions,
): ILink {
  const startColumn = stringIndexToBufferColumn(line, reference.startIndex);
  const endColumn = stringIndexToBufferColumn(
    line,
    reference.startIndex + reference.text.length,
  );
  const link: ILink = {
    range: {
      start: {
        x: startColumn + 1,
        y: bufferLineNumber,
      },
      end: {
        x: endColumn,
        y: bufferLineNumber,
      },
    },
    text: reference.text,
    decorations: {
      pointerCursor: true,
      underline: false,
    },
    activate: (event) => options.activate(event, reference),
  };
  if (options.hover) {
    link.hover = (event) => options.hover?.(event, reference, link);
  }
  if (options.leave) {
    link.leave = (event) => options.leave?.(event, reference);
  }
  return link;
}

export function findTerminalFileReferences(
  text: string,
): TerminalFileReference[] {
  const references: TerminalFileReference[] = [];
  collectQuotedWindowsFileReferences(text, references);
  collectTerminalFileReferences(text, FILE_REF_RE, references, true);
  collectTerminalFileReferences(text, FILE_PATH_RE, references, false);
  return references.sort((a, b) => a.startIndex - b.startIndex);
}

function collectQuotedWindowsFileReferences(
  text: string,
  references: TerminalFileReference[],
): void {
  const regex = new RegExp(
    QUOTED_WINDOWS_FILE_REF_RE.source,
    QUOTED_WINDOWS_FILE_REF_RE.flags,
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const referenceText = match[2] ?? "";
    const path = match[3] ?? "";
    const lineText = match[4];
    const line = lineText ? Number(lineText) : undefined;
    const column = match[5] ? Number(match[5]) : undefined;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
      continue;
    }
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) {
      continue;
    }
    references.push({
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      text: referenceText,
      startIndex: match.index + prefix.length + 1,
    });
  }
}

function collectTerminalFileReferences(
  text: string,
  pattern: RegExp,
  references: TerminalFileReference[],
  includesLocation: boolean,
): void {
  const regex = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const path = match[2] ?? "";
    const referenceText = match[0].slice(prefix.length);
    const lineText = includesLocation ? match[3] : undefined;
    const line = lineText ? Number(lineText) : undefined;
    const column =
      includesLocation && match[4] ? Number(match[4]) : undefined;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
      continue;
    }
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) {
      continue;
    }
    const reference: TerminalFileReference = {
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      text: referenceText,
      startIndex: match.index + prefix.length,
    };
    const referenceEnd = reference.startIndex + reference.text.length;
    if (
      references.some((existing) => {
        const existingEnd = existing.startIndex + existing.text.length;
        return (
          reference.startIndex < existingEnd && existing.startIndex < referenceEnd
        );
      })
    ) {
      continue;
    }
    references.push(reference);
  }
}

function stringIndexToBufferColumn(
  bufferLine: IBufferLine,
  targetIndex: number,
): number {
  let stringIndex = 0;
  for (let column = 0; column < bufferLine.length; column += 1) {
    const cell = bufferLine.getCell(column);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue;
    if (targetIndex <= stringIndex) return column;
    const chars = cell.getChars();
    const nextStringIndex = stringIndex + (chars.length || 1);
    if (targetIndex < nextStringIndex) return column;
    if (targetIndex === nextStringIndex) return column + Math.max(width, 1);
    stringIndex = nextStringIndex;
  }
  return bufferLine.length;
}

export function resolveTerminalFilePath(
  cwd: string,
  referencePath: string,
  home?: string | null,
): string {
  return resolveTerminalFilePathCandidates(cwd, referencePath, {
    home,
  })[0];
}

export function resolveTerminalFilePathCandidates(
  cwd: string,
  referencePath: string,
  options: { home?: string | null; basePaths?: string[] } = {},
): string[] {
  if (isAbsolutePath(referencePath)) {
    return [
      normalizeTerminalPath(referencePath, inferPathFlavor(referencePath)),
    ];
  }
  if (/^~[\\/]/u.test(referencePath)) {
    const { home } = options;
    if (!home) return [referencePath];
    const flavor = inferPathFlavor(home);
    return [
      normalizeTerminalPath(
        `${normalizePath(home, flavor)}/${normalizePath(referencePath.slice(2), flavor)}`,
        flavor,
      ),
    ];
  }
  const candidates = [cwd, ...(options.basePaths ?? [])].flatMap((base) => {
    const flavor = inferPathFlavor(base);
    const normalizedReference = normalizePath(referencePath, flavor);
    const basePath = normalizeTerminalPath(base, flavor);
    return [
      normalizeTerminalPath(`${basePath}/${normalizedReference}`, flavor),
      ...resolveAncestorPrefixedPathCandidates(
        basePath,
        normalizedReference,
        flavor,
      ),
    ];
  });
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex((other) => pathsEqual(other, candidate)) === index,
  );
}

function resolveAncestorPrefixedPathCandidates(
  base: string,
  referencePath: string,
  flavor: PathFlavor,
): string[] {
  const explicitRelativePrefix =
    flavor === "windows" ? /^\.{1,2}[\\/]/u : /^\.{1,2}\//u;
  if (explicitRelativePrefix.test(referencePath)) {
    return [];
  }
  const parsedBase = parseTerminalPath(
    normalizeTerminalPath(base, flavor),
    flavor,
  );
  const baseParts = parsedBase.parts;
  const referenceParts = parseTerminalPath(referencePath, flavor).parts;
  const maxMatchLength = Math.min(baseParts.length, referenceParts.length - 1);
  const candidates: string[] = [];
  for (let matchLength = maxMatchLength; matchLength >= 1; matchLength -= 1) {
    const baseSuffix = baseParts.slice(baseParts.length - matchLength);
    const referencePrefix = referenceParts.slice(0, matchLength);
    if (
      !samePathParts(
        baseSuffix,
        referencePrefix,
        parsedBase.caseInsensitive,
      )
    ) {
      continue;
    }
    const candidateParts = [
      ...baseParts.slice(0, baseParts.length - matchLength),
      ...referenceParts,
    ];
    candidates.push(
      formatTerminalPath({ ...parsedBase, parts: candidateParts }),
    );
  }
  return candidates;
}

function samePathParts(
  a: string[],
  b: string[],
  caseInsensitive: boolean,
): boolean {
  return (
    a.length === b.length &&
    a.every((part, index) =>
      caseInsensitive
        ? part.toLocaleLowerCase("en-US") ===
          b[index].toLocaleLowerCase("en-US")
        : part === b[index],
    )
  );
}

interface ParsedTerminalPath {
  root: string;
  parts: string[];
  caseInsensitive: boolean;
}

function parseTerminalPath(
  path: string,
  flavor: PathFlavor,
): ParsedTerminalPath {
  const normalized = flavor === "windows" ? path.replace(/\\/gu, "/") : path;
  const drive =
    flavor === "windows" ? /^([a-zA-Z]:)\/(.*)$/u.exec(normalized) : null;
  if (drive) {
    return {
      root: `${drive[1]}/`,
      parts: drive[2].split("/").filter(Boolean),
      caseInsensitive: true,
    };
  }
  if (flavor === "windows" && normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    const shareParts = parts.slice(0, 2);
    return {
      root: `//${shareParts.join("/")}`,
      parts: parts.slice(shareParts.length),
      caseInsensitive: true,
    };
  }
  if (normalized.startsWith("/")) {
    return {
      root: "/",
      parts: normalized.slice(1).split("/").filter(Boolean),
      caseInsensitive: false,
    };
  }
  return {
    root: "",
    parts: normalized.split("/").filter(Boolean),
    caseInsensitive: flavor === "windows",
  };
}

function formatTerminalPath(path: ParsedTerminalPath): string {
  const suffix = path.parts.join("/");
  if (!path.root) return suffix || ".";
  if (path.root.endsWith("/")) return `${path.root}${suffix}`;
  return suffix ? `${path.root}/${suffix}` : path.root;
}

function normalizeTerminalPath(
  path: string,
  flavor: PathFlavor = inferPathFlavor(path),
): string {
  const parsed = parseTerminalPath(path, flavor);
  const parts: string[] = [];
  for (const part of parsed.parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!parsed.root) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return formatTerminalPath({ ...parsed, parts });
}
