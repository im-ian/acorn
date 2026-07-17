import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectPublishedArtifacts,
  stageBuildArtifacts,
} from "./release-artifacts.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "acorn-release-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path, contents = "fixture") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stageBuildArtifacts", () => {
  it("stages exactly one matched updater pair with an architecture suffix", () => {
    const root = temporaryDirectory();
    const bundle = join(root, "bundle");
    const output = join(root, "staged");
    write(join(bundle, "dmg", "Acorn_1.0.0_aarch64.dmg"));
    write(join(bundle, "macos", "Acorn.app.tar.gz"), "tar");
    write(join(bundle, "macos", "Acorn.app.tar.gz.sig"), "sig");

    const staged = stageBuildArtifacts(bundle, output, "aarch64");

    expect(basename(staged.tar)).toBe("Acorn_aarch64.app.tar.gz");
    expect(basename(staged.signature)).toBe("Acorn_aarch64.app.tar.gz.sig");
  });

  it("rejects missing, duplicate, and mismatched build outputs", () => {
    const missing = temporaryDirectory();
    mkdirSync(join(missing, "dmg"), { recursive: true });
    mkdirSync(join(missing, "macos"), { recursive: true });
    expect(() => stageBuildArtifacts(missing, join(missing, "out"), "aarch64"))
      .toThrow(/exactly one DMG/);

    const duplicate = temporaryDirectory();
    write(join(duplicate, "dmg", "one.dmg"));
    write(join(duplicate, "dmg", "two.dmg"));
    write(join(duplicate, "macos", "Acorn.app.tar.gz"));
    write(join(duplicate, "macos", "Acorn.app.tar.gz.sig"));
    expect(() => stageBuildArtifacts(duplicate, join(duplicate, "out"), "aarch64"))
      .toThrow(/exactly one DMG/);

    const mismatched = temporaryDirectory();
    write(join(mismatched, "dmg", "one.dmg"));
    write(join(mismatched, "macos", "Acorn.app.tar.gz"));
    write(join(mismatched, "macos", "Other.app.tar.gz.sig"));
    expect(() =>
      stageBuildArtifacts(mismatched, join(mismatched, "out"), "aarch64"),
    ).toThrow(/does not match/);
  });
});

describe("inspectPublishedArtifacts", () => {
  it("accepts one complete artifact set for each macOS architecture", () => {
    const directory = temporaryDirectory();
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(directory, `Acorn_1.0.0_${arch}.dmg`));
      write(join(directory, `Acorn_${arch}.app.tar.gz`));
      write(join(directory, `Acorn_${arch}.app.tar.gz.sig`));
    }

    const artifacts = inspectPublishedArtifacts(directory);

    expect(basename(artifacts.armTar)).toContain("aarch64");
    expect(basename(artifacts.x64Tar)).toContain("x86_64");
  });

  it("rejects a missing architecture or cross-paired signature", () => {
    const missing = temporaryDirectory();
    write(join(missing, "Acorn_1.0.0_aarch64.dmg"));
    write(join(missing, "Acorn_aarch64.app.tar.gz"));
    write(join(missing, "Acorn_aarch64.app.tar.gz.sig"));
    expect(() => inspectPublishedArtifacts(missing)).toThrow(/expected two/);

    const mismatched = temporaryDirectory();
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(mismatched, `Acorn_1.0.0_${arch}.dmg`));
      write(join(mismatched, `Acorn_${arch}.app.tar.gz`));
    }
    write(join(mismatched, "Acorn_aarch64.app.tar.gz.sig"));
    write(join(mismatched, "Wrong_x86_64.app.tar.gz.sig"));
    expect(() => inspectPublishedArtifacts(mismatched)).toThrow(/incomplete or cross-paired/);
  });

  it("uses the terminal suffix when prerelease versions contain architecture tokens", () => {
    const directory = temporaryDirectory();
    write(join(directory, "Acorn_2.0.0-x64_aarch64.dmg"));
    write(join(directory, "Acorn_2.0.0-aarch64_x86_64.dmg"));
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(directory, `Acorn_${arch}.app.tar.gz`));
      write(join(directory, `Acorn_${arch}.app.tar.gz.sig`));
    }

    expect(() => inspectPublishedArtifacts(directory)).not.toThrow();
  });

  it("rejects unclassified architecture filenames", () => {
    const unclassified = temporaryDirectory();
    write(join(unclassified, "Acorn_2.0.0_aarch64.dmg"));
    write(join(unclassified, "Acorn_2.0.0_unknown.dmg"));
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(unclassified, `Acorn_${arch}.app.tar.gz`));
      write(join(unclassified, `Acorn_${arch}.app.tar.gz.sig`));
    }

    expect(() => inspectPublishedArtifacts(unclassified)).toThrow(
      /architecture suffix/,
    );
  });
});
