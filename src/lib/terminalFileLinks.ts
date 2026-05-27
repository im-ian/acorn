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
}

export interface TerminalFileLinkProviderOptions {
  activate: (event: MouseEvent, reference: TerminalFileReference) => void;
  hover?: (
    event: MouseEvent,
    reference: TerminalFileReference,
    link: ILink,
  ) => void;
  leave?: (event: MouseEvent, reference: TerminalFileReference) => void;
}

const FILE_REF_RE =
  /(^|[\s([{"'`<])((?:\.{1,2}\/|\/)?(?:(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+|[A-Za-z0-9._@+-]*\.[A-Za-z0-9._@+-]+)):(?:(\d{1,7})(?::(\d{1,5}))?)?(?=$|[\s)\]}>,.;!?:])/g;
const FILE_PATH_RE =
  /(^|[\s([{"'`<])((?:\.{1,2}\/|\/)?(?:(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*\.[A-Za-z][A-Za-z0-9_@+-]+|[A-Za-z0-9._@+-]*\.[A-Za-z][A-Za-z0-9_@+-]+))(?=$|[\s)\]}>,.;!?])/g;

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
      callback(
        references.map((reference) => {
          const startColumn = stringIndexToBufferColumn(
            line,
            reference.startIndex,
          );
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
        }),
      );
    },
  };
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
): string {
  if (referencePath.startsWith("/")) {
    return normalizePosixPath(referencePath);
  }
  return normalizePosixPath(`${cwd.replace(/\/+$/u, "")}/${referencePath}`);
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
