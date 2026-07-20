import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertReleaseIsNewer,
  assertMatchingReleaseVersions,
  compareReleaseTags,
  readRepositoryVersions,
  releaseVersionFromTag,
} from "./validate-release-version.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("releaseVersionFromTag", () => {
  it("accepts stable and prerelease semantic versions", () => {
    expect(releaseVersionFromTag("v1.25.0")).toBe("1.25.0");
    expect(releaseVersionFromTag("v2.0.0-beta.1")).toBe("2.0.0-beta.1");
    expect(releaseVersionFromTag("v2.0.0-0.01alpha")).toBe(
      "2.0.0-0.01alpha",
    );
  });

  it("rejects malformed, newline-bearing, and zero-padded tags", () => {
    for (const tag of [
      "1.25.0",
      "v1.25",
      "v01.25.0",
      "v1.25.0-01",
      "v1.25.0\nextra",
    ]) {
      expect(releaseVersionFromTag(tag)).toBeNull();
    }
  });
});

describe("assertMatchingReleaseVersions", () => {
  it("requires every shipped manifest to match the tag", () => {
    expect(
      assertMatchingReleaseVersions("v1.25.0", {
        "package.json": "1.25.0",
        "tauri.conf.json": "1.25.0",
        "Cargo.toml": "1.25.0",
      }),
    ).toBe("1.25.0");

    for (const source of ["package.json", "tauri.conf.json", "Cargo.toml"]) {
      const versions = {
        "package.json": "1.25.0",
        "tauri.conf.json": "1.25.0",
        "Cargo.toml": "1.25.0",
        [source]: "1.24.9",
      };
      expect(() => assertMatchingReleaseVersions("v1.25.0", versions)).toThrow(
        source,
      );
    }
  });
});

describe("release ordering", () => {
  it("uses semantic-version precedence", () => {
    expect(compareReleaseTags("v2.0.0", "v1.99.99")).toBe(1);
    expect(compareReleaseTags("v2.0.0", "v2.0.0")).toBe(0);
    expect(compareReleaseTags("v2.0.0-beta.2", "v2.0.0-beta.10")).toBe(-1);
    expect(compareReleaseTags("v2.0.0-alpha-a", "v2.0.0-alpha-b")).toBe(-1);
    expect(compareReleaseTags("v2.0.0", "v2.0.0-rc.1")).toBe(1);
  });

  it("rejects stable latest-pointer rollback or replay", () => {
    expect(() => assertReleaseIsNewer("v1.24.9", "v1.25.0")).toThrow(
      /not newer/,
    );
    expect(() => assertReleaseIsNewer("v1.25.0", "v1.25.0")).toThrow(
      /not newer/,
    );
    expect(() => assertReleaseIsNewer("v1.25.1", "v1.25.0")).not.toThrow();
  });
});

describe("readRepositoryVersions", () => {
  it("reads the package section rather than similarly named TOML sections", () => {
    const root = mkdtempSync(join(tmpdir(), "acorn-release-version-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "src-tauri"));
    writeFileSync(join(root, "package.json"), '{"version":"2.0.0"}');
    writeFileSync(join(root, "src-tauri/tauri.conf.json"), '{"version":"2.0.0"}');
    writeFileSync(
      join(root, "src-tauri/Cargo.toml"),
      '[workspace.dependencies]\nversion = "999.0.0"\n\n[package]\nname = "acorn"\nversion = "2.0.0"\n\n[lib]\n',
    );

    expect(readRepositoryVersions(root)).toEqual({
      "package.json": "2.0.0",
      "src-tauri/tauri.conf.json": "2.0.0",
      "src-tauri/Cargo.toml": "2.0.0",
    });
  });
});
