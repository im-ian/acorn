import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_LANGUAGE_LOADERS,
  HIGHLIGHT_THEME_LOADERS,
} from "./highlightRegistry";

const SUPPORTED_LANGUAGES = [
  "bash",
  "c",
  "cmake",
  "cpp",
  "csharp",
  "css",
  "dart",
  "docker",
  "fish",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "jsonc",
  "jsx",
  "kotlin",
  "less",
  "lua",
  "make",
  "markdown",
  "mdx",
  "php",
  "proto",
  "python",
  "ruby",
  "rust",
  "scala",
  "scss",
  "sql",
  "svelte",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
] as const;

describe("highlight registry", () => {
  it("bundles loaders only for languages Acorn can select", () => {
    expect(Object.keys(HIGHLIGHT_LANGUAGE_LOADERS).sort()).toEqual(
      [...SUPPORTED_LANGUAGES].sort(),
    );
  });

  it("bundles only the two themes exposed by the app", () => {
    expect(Object.keys(HIGHLIGHT_THEME_LOADERS).sort()).toEqual([
      "github-dark",
      "github-light-high-contrast",
    ]);
  });

  it("resolves representative language and theme registrations", async () => {
    const [typescript, darkTheme] = await Promise.all([
      HIGHLIGHT_LANGUAGE_LOADERS.typescript(),
      HIGHLIGHT_THEME_LOADERS["github-dark"](),
    ]);

    expect(typescript.default.some((language) => language.name === "typescript")).toBe(
      true,
    );
    expect(darkTheme.default.name).toBe("github-dark");
  });
});
