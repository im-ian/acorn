import type {
  ILink,
  ILinkProvider,
  Terminal as XTerm,
} from "@xterm/xterm";

export interface TerminalWebLinkProviderOptions {
  activate: (event: MouseEvent, uri: string) => void;
  hover?: (event: MouseEvent, uri: string, link: ILink) => void;
  leave?: (event: MouseEvent, uri: string) => void;
  urlRegex?: RegExp;
}

const STRICT_URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

export function createTerminalWebLinkProvider(
  terminal: XTerm,
  options: TerminalWebLinkProviderOptions,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const links = computeWebLinks(
        bufferLineNumber,
        options.urlRegex ?? STRICT_URL_RE,
        terminal,
        options,
      );
      callback(links.length === 0 ? undefined : links);
    },
  };
}

function computeWebLinks(
  bufferLineNumber: number,
  pattern: RegExp,
  terminal: XTerm,
  options: TerminalWebLinkProviderOptions,
): ILink[] {
  const flags = new Set(pattern.flags.split(""));
  flags.add("g");
  const regex = new RegExp(pattern.source, [...flags].join(""));
  const [lines, startLineIndex] = getWindowedLineStrings(
    bufferLineNumber - 1,
    terminal,
  );
  const line = lines.join("");
  const links: ILink[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    const text = match[0];
    if (!isUrl(text)) continue;

    const [startY, startX] = mapStringIndex(
      terminal,
      startLineIndex,
      0,
      match.index,
    );
    const [endY, endX] = mapStringIndex(
      terminal,
      startY,
      startX,
      text.length,
    );
    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
      continue;
    }

    const link: ILink = {
      range: {
        start: { x: startX + 1, y: startY + 1 },
        end: { x: endX, y: endY + 1 },
      },
      text,
      decorations: {
        pointerCursor: true,
        underline: false,
      },
      activate: (event) => options.activate(event, text),
    };
    if (options.hover) {
      link.hover = (event) => options.hover?.(event, text, link);
    }
    if (options.leave) {
      link.leave = (event) => options.leave?.(event, text);
    }
    links.push(link);
  }

  return links;
}

function getWindowedLineStrings(
  lineIndex: number,
  terminal: XTerm,
): [string[], number] {
  let line = terminal.buffer.active.getLine(lineIndex);
  let topIndex = lineIndex;
  let bottomIndex = lineIndex;
  let length = 0;
  const lines: string[] = [];

  if (!line) return [lines, topIndex];

  const current = line.translateToString(true);
  if (line.isWrapped && current[0] !== " ") {
    while (
      (line = terminal.buffer.active.getLine(--topIndex)) &&
      length < 2048
    ) {
      const content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.includes(" ")) break;
    }
    lines.reverse();
  }

  lines.push(current);
  length = 0;
  while (
    (line = terminal.buffer.active.getLine(++bottomIndex)) &&
    line.isWrapped &&
    length < 2048
  ) {
    const content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.includes(" ")) break;
  }

  return [lines, topIndex];
}

function mapStringIndex(
  terminal: XTerm,
  y: number,
  startX: number,
  length: number,
): [number, number] {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let x = startX;

  while (length) {
    const line = buffer.getLine(y);
    if (!line) return [-1, -1];
    for (let currentX = x; currentX < line.length; currentX += 1) {
      line.getCell(currentX, cell);
      const chars = cell.getChars();
      if (cell.getWidth()) {
        length -= chars.length || 1;
        if (currentX === line.length - 1 && chars === "") {
          const nextLine = buffer.getLine(y + 1);
          if (nextLine?.isWrapped) {
            nextLine.getCell(0, cell);
            if (cell.getWidth() === 2) length += 1;
          }
        }
      }
      if (length === 0) return [y, currentX + 1];
      if (length < 0) return [y, currentX];
    }
    y += 1;
    x = 0;
  }

  return [y, x];
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return value.toLowerCase().startsWith(parsedBase.toLowerCase());
  } catch {
    return false;
  }
}
