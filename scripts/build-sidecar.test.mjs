import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeBuildPlan,
  parseBuildArguments,
  parseRustcHost,
  resolveBuildPlan,
} from "../src-tauri/scripts/build-sidecar.mjs";

const tauriDirectory = resolve("/workspace/src-tauri");
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "acorn-sidecars-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path, contents = "binary") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseRustcHost", () => {
  it("parses rustc output with Windows line endings", () => {
    expect(
      parseRustcHost(
        "rustc 1.90.0\r\nbinary: rustc\r\nhost: x86_64-pc-windows-msvc\r\n",
      ),
    ).toBe("x86_64-pc-windows-msvc");
  });

  it("rejects output without a host triple", () => {
    expect(() => parseRustcHost("rustc 1.90.0\n")).toThrow(/host triple/);
  });
});

describe("parseBuildArguments", () => {
  it("uses portable flags while retaining the existing env fallback", () => {
    expect(
      parseBuildArguments(["--profile", "release-ci", "--force-target"], {
        TAURI_SIDECAR_PROFILE: "debug",
      }),
    ).toEqual({ profile: "release-ci", forceTarget: true });
    expect(
      parseBuildArguments([], {
        TAURI_SIDECAR_PROFILE: "debug",
        TAURI_SIDECAR_FORCE_TARGET: "1",
      }),
    ).toEqual({ profile: "debug", forceTarget: true });
  });

  it("rejects unknown flags and unsafe profile names", () => {
    expect(() => parseBuildArguments(["--wat"], {})).toThrow(/unknown/);
    expect(() => parseBuildArguments(["--profile", "../release"], {})).toThrow(
      /invalid Cargo profile/,
    );
    expect(() => parseBuildArguments(["--profile", "bench"], {})).toThrow(
      /unsupported Cargo profile/,
    );
  });
});

describe("resolveBuildPlan", () => {
  it("uses the native debug directory without an explicit target", () => {
    const plan = resolveBuildPlan({
      environment: {},
      hostTriple: "aarch64-apple-darwin",
      profile: "debug",
      tauriDirectory,
      targetTriple: "aarch64-apple-darwin",
    });

    expect(plan.useExplicitTarget).toBe(false);
    expect(plan.artifactDirectory).toBe(
      join(tauriDirectory, "target", "debug"),
    );
    expect(plan.cargoArguments).not.toContain("--target");
    expect(plan.cargoArguments).not.toContain("--profile");
    expect(basename(plan.sidecars[0].destination)).toBe(
      "acorn-ipc-aarch64-apple-darwin",
    );
  });

  it("stages Windows executables from an explicit release-ci target", () => {
    const plan = resolveBuildPlan({
      environment: {},
      forceTarget: true,
      hostTriple: "x86_64-pc-windows-msvc",
      profile: "release-ci",
      tauriDirectory,
      targetTriple: "x86_64-pc-windows-msvc",
    });

    expect(plan.useExplicitTarget).toBe(true);
    expect(plan.artifactDirectory).toBe(
      join(tauriDirectory, "target", "x86_64-pc-windows-msvc", "release-ci"),
    );
    expect(plan.cargoArguments).toContain("--target");
    expect(plan.cargoArguments).toContain("--profile");
    expect(plan.sidecars.map(({ source }) => basename(source))).toEqual([
      "acorn-ipc.exe",
      "acornd.exe",
    ]);
    expect(
      plan.sidecars.map(({ destination }) => basename(destination)),
    ).toEqual([
      "acorn-ipc-x86_64-pc-windows-msvc.exe",
      "acornd-x86_64-pc-windows-msvc.exe",
    ]);
  });

  it("honors Cargo target configuration and a custom target directory", () => {
    const plan = resolveBuildPlan({
      environment: {
        CARGO_BUILD_TARGET: "x86_64-apple-darwin",
        CARGO_TARGET_DIR: "../shared-target",
      },
      hostTriple: "x86_64-apple-darwin",
      profile: "release",
      tauriDirectory,
      targetTriple: "x86_64-apple-darwin",
    });

    expect(plan.useExplicitTarget).toBe(true);
    expect(plan.artifactDirectory).toBe(
      resolve(
        tauriDirectory,
        "../shared-target",
        "x86_64-apple-darwin",
        "release",
      ),
    );
    expect(plan.cargoArguments.at(-1)).toBe("--release");
  });

  it("rejects target triples that could escape the staging directory", () => {
    expect(() =>
      resolveBuildPlan({
        environment: {},
        hostTriple: "aarch64-apple-darwin",
        tauriDirectory,
        targetTriple: "../windows",
      }),
    ).toThrow(/invalid Rust target triple/);
  });
});

describe("executeBuildPlan", () => {
  function planFor(directory) {
    return resolveBuildPlan({
      environment: {},
      hostTriple: "x86_64-pc-windows-msvc",
      profile: "release-ci",
      tauriDirectory: directory,
      targetTriple: "x86_64-pc-windows-msvc",
      forceTarget: true,
    });
  }

  it("stages non-empty Cargo output over the externalBin placeholders", () => {
    const plan = planFor(temporaryDirectory());

    executeBuildPlan(plan, {
      environment: {},
      execute: () => {
        for (const sidecar of plan.sidecars) write(sidecar.source);
      },
    });

    for (const sidecar of plan.sidecars) {
      expect(readFileSync(sidecar.destination, "utf8")).toBe("binary");
    }
  });

  it("propagates Cargo failures", () => {
    const plan = planFor(temporaryDirectory());
    expect(() =>
      executeBuildPlan(plan, {
        environment: {},
        execute: () => {
          throw new Error("cargo failed");
        },
      }),
    ).toThrow(/cargo failed/);
  });

  it("rejects missing and zero-byte Cargo outputs", () => {
    const missingPlan = planFor(temporaryDirectory());
    expect(() =>
      executeBuildPlan(missingPlan, { environment: {}, execute: () => {} }),
    ).toThrow(/expected built binary/);

    const emptyPlan = planFor(temporaryDirectory());
    expect(() =>
      executeBuildPlan(emptyPlan, {
        environment: {},
        execute: () => {
          for (const sidecar of emptyPlan.sidecars) write(sidecar.source, "");
        },
      }),
    ).toThrow(/empty or invalid/);
  });
});
