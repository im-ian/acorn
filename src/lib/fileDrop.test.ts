import { describe, expect, it } from "vitest";
import {
  extractNativeFileDropPaths,
  hasNativeFileDropData,
} from "./fileDrop";

interface FakeTransfer {
  types?: string[];
  items?: Array<{ kind: string }>;
  files?: Array<{ path?: string }>;
  data?: Record<string, string>;
}

function transfer({
  types = [],
  items = [],
  files = [],
  data = {},
}: FakeTransfer) {
  return {
    types,
    items,
    files,
    getData(type: string) {
      return data[type] ?? "";
    },
  };
}

describe("hasNativeFileDropData", () => {
  it("detects OS file drags by standard Files type", () => {
    expect(hasNativeFileDropData(transfer({ types: ["Files"] }))).toBe(true);
  });

  it("detects WebKit file URL pasteboard drags", () => {
    expect(hasNativeFileDropData(transfer({ types: ["public.file-url"] }))).toBe(
      true,
    );
  });

  it("detects browser DataTransfer file lists", () => {
    expect(
      hasNativeFileDropData(transfer({ files: [{ path: undefined }] })),
    ).toBe(true);
  });

  it("ignores Acorn-owned text drags without native file markers", () => {
    expect(
      hasNativeFileDropData(
        transfer({ types: ["text/plain", "text/uri-list"] }),
      ),
    ).toBe(false);
  });
});

describe("extractNativeFileDropPaths", () => {
  it("decodes file URLs from text/uri-list", () => {
    expect(
      extractNativeFileDropPaths(
        transfer({
          types: ["Files", "text/uri-list"],
          data: {
            "text/uri-list":
              "# comment\r\nfile:///Users/me/Desktop/PR%20notes.md\r\nhttps://example.com",
          },
        }),
      ),
    ).toEqual(["/Users/me/Desktop/PR notes.md"]);
  });

  it("uses public.file-url when WebKit exposes that pasteboard type", () => {
    expect(
      extractNativeFileDropPaths(
        transfer({
          types: ["public.file-url"],
          data: {
            "public.file-url": "file:///Users/me/Desktop/screenshot.png",
          },
        }),
      ),
    ).toEqual(["/Users/me/Desktop/screenshot.png"]);
  });

  it("uses non-standard File.path values when a webview provides them", () => {
    expect(
      extractNativeFileDropPaths(
        transfer({
          types: ["Files"],
          files: [{ path: "/Users/me/Desktop/raw.log" }],
        }),
      ),
    ).toEqual(["/Users/me/Desktop/raw.log"]);
  });

  it("keeps Windows drive paths from file URLs usable", () => {
    expect(
      extractNativeFileDropPaths(
        transfer({
          types: ["Files"],
          data: { "text/uri-list": "file:///C:/Users/me/Desktop/a.txt" },
        }),
      ),
    ).toEqual(["C:/Users/me/Desktop/a.txt"]);
  });

  it("does not extract paths from text-only drags", () => {
    expect(
      extractNativeFileDropPaths(
        transfer({
          types: ["text/plain"],
          data: { "text/plain": "/Users/me/Desktop/a.txt" },
        }),
      ),
    ).toEqual([]);
  });
});
