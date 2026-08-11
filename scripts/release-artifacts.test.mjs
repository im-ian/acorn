import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectPublishedArtifacts,
  stageBuildArtifacts,
  stageWindowsBuildArtifacts,
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
    expect(() =>
      stageBuildArtifacts(missing, join(missing, "out"), "aarch64"),
    ).toThrow(/exactly one DMG/);

    const duplicate = temporaryDirectory();
    write(join(duplicate, "dmg", "one.dmg"));
    write(join(duplicate, "dmg", "two.dmg"));
    write(join(duplicate, "macos", "Acorn.app.tar.gz"));
    write(join(duplicate, "macos", "Acorn.app.tar.gz.sig"));
    expect(() =>
      stageBuildArtifacts(duplicate, join(duplicate, "out"), "aarch64"),
    ).toThrow(/exactly one DMG/);

    const mismatched = temporaryDirectory();
    write(join(mismatched, "dmg", "one.dmg"));
    write(join(mismatched, "macos", "Acorn.app.tar.gz"));
    write(join(mismatched, "macos", "Other.app.tar.gz.sig"));
    expect(() =>
      stageBuildArtifacts(mismatched, join(mismatched, "out"), "aarch64"),
    ).toThrow(/does not match/);
  });
});

describe("stageWindowsBuildArtifacts", () => {
  it("stages exactly one matched x64 NSIS updater pair without renaming it", () => {
    const root = temporaryDirectory();
    const bundle = join(root, "bundle");
    const output = join(root, "staged");
    write(join(bundle, "nsis", "Acorn_1.32.0_x64-setup.exe"), "installer");
    write(join(bundle, "nsis", "Acorn_1.32.0_x64-setup.exe.sig"), "signature");

    const staged = stageWindowsBuildArtifacts(bundle, output, "x86_64");

    expect(basename(staged.installer)).toBe("Acorn_1.32.0_x64-setup.exe");
    expect(basename(staged.signature)).toBe("Acorn_1.32.0_x64-setup.exe.sig");
  });

  it("rejects missing, duplicate, cross-paired, and empty NSIS outputs", () => {
    const missing = temporaryDirectory();
    mkdirSync(join(missing, "nsis"), { recursive: true });
    expect(() =>
      stageWindowsBuildArtifacts(missing, join(missing, "out"), "x86_64"),
    ).toThrow(/exactly one NSIS installer/);

    const duplicate = temporaryDirectory();
    for (const name of ["Acorn_1.0.0_x64", "Acorn_1.0.1_x64"]) {
      write(join(duplicate, "nsis", `${name}-setup.exe`));
    }
    write(join(duplicate, "nsis", "Acorn_1.0.0_x64-setup.exe.sig"));
    expect(() =>
      stageWindowsBuildArtifacts(duplicate, join(duplicate, "out"), "x86_64"),
    ).toThrow(/exactly one NSIS installer/);

    const mismatched = temporaryDirectory();
    write(join(mismatched, "nsis", "Acorn_1.0.0_x64-setup.exe"));
    write(join(mismatched, "nsis", "Other_1.0.0_x64-setup.exe.sig"));
    expect(() =>
      stageWindowsBuildArtifacts(mismatched, join(mismatched, "out"), "x86_64"),
    ).toThrow(/does not match/);

    const empty = temporaryDirectory();
    write(join(empty, "nsis", "Acorn_1.0.0_x64-setup.exe"), "");
    write(join(empty, "nsis", "Acorn_1.0.0_x64-setup.exe.sig"));
    expect(() =>
      stageWindowsBuildArtifacts(empty, join(empty, "out"), "x86_64"),
    ).toThrow(/empty or invalid/);
  });

  it("rejects an installer that does not match the declared architecture", () => {
    const root = temporaryDirectory();
    write(join(root, "nsis", "Acorn_1.32.0_aarch64-setup.exe"));
    write(join(root, "nsis", "Acorn_1.32.0_aarch64-setup.exe.sig"));

    expect(() =>
      stageWindowsBuildArtifacts(root, join(root, "out"), "x86_64"),
    ).toThrow(/architecture does not match/);
  });
});

describe("inspectPublishedArtifacts", () => {
  function writeCompleteArtifactSet(directory) {
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(directory, `Acorn_1.0.0_${arch}.dmg`));
      write(join(directory, `Acorn_${arch}.app.tar.gz`));
      write(join(directory, `Acorn_${arch}.app.tar.gz.sig`));
    }
    write(join(directory, "Acorn_1.0.0_x64-setup.exe"));
    write(join(directory, "Acorn_1.0.0_x64-setup.exe.sig"));
  }

  it("accepts complete macOS and Windows release artifacts", () => {
    const directory = temporaryDirectory();
    writeCompleteArtifactSet(directory);

    const artifacts = inspectPublishedArtifacts(directory);

    expect(basename(artifacts.armTar)).toContain("aarch64");
    expect(basename(artifacts.x64Tar)).toContain("x86_64");
    expect(basename(artifacts.windowsX64Installer)).toBe(
      "Acorn_1.0.0_x64-setup.exe",
    );
    expect(basename(artifacts.windowsX64Signature)).toBe(
      "Acorn_1.0.0_x64-setup.exe.sig",
    );
  });

  it("rejects a missing architecture or cross-paired signature", () => {
    const missing = temporaryDirectory();
    write(join(missing, "Acorn_1.0.0_aarch64.dmg"));
    write(join(missing, "Acorn_aarch64.app.tar.gz"));
    write(join(missing, "Acorn_aarch64.app.tar.gz.sig"));
    expect(() => inspectPublishedArtifacts(missing)).toThrow(
      /expected two DMGs/,
    );

    const mismatched = temporaryDirectory();
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(mismatched, `Acorn_1.0.0_${arch}.dmg`));
      write(join(mismatched, `Acorn_${arch}.app.tar.gz`));
    }
    write(join(mismatched, "Acorn_aarch64.app.tar.gz.sig"));
    write(join(mismatched, "Wrong_x86_64.app.tar.gz.sig"));
    write(join(mismatched, "Acorn_1.0.0_x64-setup.exe"));
    write(join(mismatched, "Acorn_1.0.0_x64-setup.exe.sig"));
    expect(() => inspectPublishedArtifacts(mismatched)).toThrow(
      /incomplete or cross-paired/,
    );
  });

  it("uses the terminal suffix when prerelease versions contain architecture tokens", () => {
    const directory = temporaryDirectory();
    write(join(directory, "Acorn_2.0.0-x64_aarch64.dmg"));
    write(join(directory, "Acorn_2.0.0-aarch64_x86_64.dmg"));
    for (const arch of ["aarch64", "x86_64"]) {
      write(join(directory, `Acorn_${arch}.app.tar.gz`));
      write(join(directory, `Acorn_${arch}.app.tar.gz.sig`));
    }
    write(join(directory, "Acorn_2.0.0-aarch64_x64-setup.exe"));
    write(join(directory, "Acorn_2.0.0-aarch64_x64-setup.exe.sig"));

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
    write(join(unclassified, "Acorn_1.0.0_x64-setup.exe"));
    write(join(unclassified, "Acorn_1.0.0_x64-setup.exe.sig"));

    expect(() => inspectPublishedArtifacts(unclassified)).toThrow(
      /architecture suffix/,
    );
  });

  it("rejects cross-paired, empty, and unexpected Windows artifacts", () => {
    const crossPaired = temporaryDirectory();
    writeCompleteArtifactSet(crossPaired);
    rmSync(join(crossPaired, "Acorn_1.0.0_x64-setup.exe.sig"));
    write(join(crossPaired, "Other_1.0.0_x64-setup.exe.sig"));
    expect(() => inspectPublishedArtifacts(crossPaired)).toThrow(
      /NSIS installer\/signature pair/,
    );

    const empty = temporaryDirectory();
    writeCompleteArtifactSet(empty);
    write(join(empty, "Acorn_1.0.0_x64-setup.exe.sig"), "");
    expect(() => inspectPublishedArtifacts(empty)).toThrow(/empty or invalid/);

    const unexpected = temporaryDirectory();
    writeCompleteArtifactSet(unexpected);
    write(join(unexpected, "notes.txt"));
    expect(() => inspectPublishedArtifacts(unexpected)).toThrow(
      /unexpected file/,
    );
  });
});
