import { describe, expect, it } from "vitest";
import { fileUrlToPath, joinPath } from "./paths";

describe("joinPath", () => {
  it("joins base and relative with a single separator", () => {
    expect(joinPath("/Users/me/repo", "src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("does not double up the separator when base ends with /", () => {
    expect(joinPath("/Users/me/repo/", "src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("strips leading slashes from the relative path", () => {
    expect(joinPath("/Users/me/repo", "/src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("strips multiple leading slashes from the relative path", () => {
    expect(joinPath("/Users/me/repo", "///src/x.ts")).toBe(
      "/Users/me/repo/src/x.ts",
    );
  });

  it("handles empty relative", () => {
    expect(joinPath("/Users/me/repo", "")).toBe("/Users/me/repo/");
  });
});

describe("fileUrlToPath", () => {
  it("decodes local file URLs", () => {
    expect(
      fileUrlToPath(
        "file:///Users/me/generated/preview%20image-%EC%9E%90%EB%A6%AC.png",
      ),
    ).toBe("/Users/me/generated/preview image-자리.png");
  });

  it("accepts localhost and case-insensitive file schemes", () => {
    expect(fileUrlToPath("FILE://LOCALHOST/Users/me/report.txt")).toBe(
      "/Users/me/report.txt",
    );
  });

  it("keeps Windows drive paths usable", () => {
    expect(fileUrlToPath("file:///C:/Users/me/Desktop/a.txt")).toBe(
      "C:/Users/me/Desktop/a.txt",
    );
  });

  it("maps non-local hosts to UNC paths", () => {
    expect(fileUrlToPath("file://server/share/report.pdf")).toBe(
      "//server/share/report.pdf",
    );
  });

  it("rejects non-file and malformed URLs", () => {
    expect(fileUrlToPath("https://example.test/file.png")).toBeNull();
    expect(fileUrlToPath("file:///tmp/bad%escape.png")).toBeNull();
  });
});
