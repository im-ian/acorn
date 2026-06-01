import type {
  IBufferLine,
  ILink,
  ILinkProvider,
  Terminal as XTerm,
} from "@xterm/xterm";

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

const FILE_REF_RE =
  /(^|[\s([{"'`<])((?:~\/|\.{1,2}\/|\/)?(?:(?:[\p{L}\p{N}._@+-]+\/)+[\p{L}\p{N}._@+-]+|[\p{L}\p{N}._@+-]*\.[\p{L}\p{N}._@+-]+)):(?:(\d{1,7})(?::(\d{1,5}))?)?(?=$|[\s)\]}>,;!?:]|[.](?=$|[\s)\]}>,;!?:]))/gu;
const FILE_PATH_RE =
  /(^|[\s([{"'`<])((?:~\/|\.{1,2}\/|\/)?(?:(?:[\p{L}\p{N}._@+-]+\/)+[\p{L}\p{N}._@+-]*\.[\p{L}][\p{L}\p{N}_@+-]+|[\p{L}\p{N}._@+-]*\.[\p{L}][\p{L}\p{N}_@+-]+))(?=$|[\s)\]}>,;!?]|[.](?=$|[\s)\]}>,;!?]))/gu;

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
  collectTerminalFileReferences(text, FILE_REF_RE, references, true);
  collectTerminalFileReferences(text, FILE_PATH_RE, references, false);
  return references.sort((a, b) => a.startIndex - b.startIndex);
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
    references.push({
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      text: referenceText,
      startIndex: match.index + prefix.length,
    });
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
  if (referencePath.startsWith("/")) {
    return [normalizePosixPath(referencePath)];
  }
  if (referencePath.startsWith("~/")) {
    const { home } = options;
    if (!home) return [referencePath];
    return [
      normalizePosixPath(
        `${home.replace(/\/+$/u, "")}/${referencePath.slice(2)}`,
      ),
    ];
  }
  const candidates = [cwd, ...(options.basePaths ?? [])].flatMap((base) => {
    const basePath = base.replace(/\/+$/u, "");
    return [
      normalizePosixPath(`${basePath}/${referencePath}`),
      ...resolveAncestorPrefixedPathCandidates(basePath, referencePath),
    ];
  });
  return Array.from(new Set(candidates));
}

function resolveAncestorPrefixedPathCandidates(
  base: string,
  referencePath: string,
): string[] {
  if (referencePath.startsWith("./") || referencePath.startsWith("../")) {
    return [];
  }
  const normalizedBase = normalizePosixPath(base);
  const absolute = normalizedBase.startsWith("/");
  const baseParts = normalizedBase.split("/").filter(Boolean);
  const referenceParts = referencePath.split("/").filter(Boolean);
  const maxMatchLength = Math.min(baseParts.length, referenceParts.length - 1);
  const candidates: string[] = [];
  for (let matchLength = maxMatchLength; matchLength >= 1; matchLength -= 1) {
    const baseSuffix = baseParts.slice(baseParts.length - matchLength);
    const referencePrefix = referenceParts.slice(0, matchLength);
    if (!samePathParts(baseSuffix, referencePrefix)) continue;
    const candidateParts = [
      ...baseParts.slice(0, baseParts.length - matchLength),
      ...referenceParts,
    ];
    const candidate = candidateParts.join("/");
    candidates.push(normalizePosixPath(absolute ? `/${candidate}` : candidate));
  }
  return candidates;
}

function samePathParts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (absolute) return `/${normalized}`;
  return normalized || ".";
}
