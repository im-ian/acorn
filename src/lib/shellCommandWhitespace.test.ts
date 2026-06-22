import { describe, expect, it } from "vitest";
import { normalizeShellCommandWhitespace } from "./shellCommandWhitespace";

describe("normalizeShellCommandWhitespace", () => {
  it("converts no-break spaces that make shells treat commands as one word", () => {
    expect(normalizeShellCommandWhitespace("pnpm\u00a0run\u202fdev")).toBe(
      "pnpm run dev",
    );
  });

  it("converts visible horizontal Unicode spaces without trimming or collapsing", () => {
    expect(normalizeShellCommandWhitespace("git\u2003status\u3000--short")).toBe(
      "git status --short",
    );
    expect(normalizeShellCommandWhitespace("cmd\u00a0\u00a0arg")).toBe(
      "cmd  arg",
    );
  });

  it("preserves tabs and line breaks", () => {
    expect(normalizeShellCommandWhitespace("printf\tok\nnext\r\n")).toBe(
      "printf\tok\nnext\r\n",
    );
  });
});
