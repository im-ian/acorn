#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultTauriDirectory = resolve(scriptDirectory, "..");

const sidecars = Object.freeze([
  { binary: "acorn-ipc", package: "acorn-ipc" },
  { binary: "acornd", package: "acorn" },
]);
const cargoProfiles = new Set(["debug", "release", "release-ci"]);

function requirePathComponent(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`invalid ${label} ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseRustcHost(versionOutput) {
  const host = /^host:\s*(\S+)\s*$/m.exec(versionOutput)?.[1];
  if (!host) {
    throw new Error("could not determine the Rust host triple");
  }
  return requirePathComponent(host, "Rust host triple");
}

export function parseBuildArguments(argv, environment = process.env) {
  let profile = environment.TAURI_SIDECAR_PROFILE || "release";
  let forceTarget = environment.TAURI_SIDECAR_FORCE_TARGET === "1";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      profile = argv[index + 1];
      if (!profile) throw new Error("--profile requires a value");
      index += 1;
    } else if (argument === "--force-target") {
      forceTarget = true;
    } else {
      throw new Error(
        `unknown build-sidecar argument ${JSON.stringify(argument)}`,
      );
    }
  }

  requirePathComponent(profile, "Cargo profile");
  if (!cargoProfiles.has(profile)) {
    throw new Error(
      `unsupported Cargo profile ${JSON.stringify(profile)}; expected debug, release, or release-ci`,
    );
  }
  return { profile, forceTarget };
}

export function resolveBuildPlan({
  environment = process.env,
  forceTarget = false,
  hostTriple,
  profile = "release",
  tauriDirectory = defaultTauriDirectory,
  targetTriple,
}) {
  const host = requirePathComponent(hostTriple, "Rust host triple");
  const target = requirePathComponent(targetTriple, "Rust target triple");
  const cargoProfile = requirePathComponent(profile, "Cargo profile");
  if (!cargoProfiles.has(cargoProfile)) {
    throw new Error(
      `unsupported Cargo profile ${JSON.stringify(cargoProfile)}; expected debug, release, or release-ci`,
    );
  }
  const configuredTarget = Boolean(environment.CARGO_BUILD_TARGET);
  const useExplicitTarget = forceTarget || configuredTarget || target !== host;
  const targetDirectoryValue = environment.CARGO_TARGET_DIR || "target";
  const targetDirectory = isAbsolute(targetDirectoryValue)
    ? targetDirectoryValue
    : resolve(tauriDirectory, targetDirectoryValue);
  const artifactDirectory = useExplicitTarget
    ? join(targetDirectory, target, cargoProfile)
    : join(targetDirectory, cargoProfile);
  const executableExtension = /(?:^|-)(?:windows)(?:-|$)/i.test(target)
    ? ".exe"
    : "";

  const cargoArguments = ["build", "--locked"];
  if (useExplicitTarget) cargoArguments.push("--target", target);
  for (const sidecar of sidecars) {
    cargoArguments.push("-p", sidecar.package, "--bin", sidecar.binary);
  }
  if (cargoProfile === "release") cargoArguments.push("--release");
  else if (cargoProfile !== "debug") {
    cargoArguments.push("--profile", cargoProfile);
  }

  return {
    artifactDirectory,
    cargoArguments,
    executableExtension,
    hostTriple: host,
    profile: cargoProfile,
    tauriDirectory,
    sidecars: sidecars.map(({ binary, package: packageName }) => ({
      binary,
      package: packageName,
      source: join(artifactDirectory, `${binary}${executableExtension}`),
      destination: join(
        tauriDirectory,
        "binaries",
        `${binary}-${target}${executableExtension}`,
      ),
    })),
    targetTriple: target,
    useExplicitTarget,
  };
}

export function executeBuildPlan(
  plan,
  { environment = process.env, execute = run } = {},
) {
  const destinationDirectory = join(plan.tauriDirectory, "binaries");
  mkdirSync(destinationDirectory, { recursive: true });

  // Tauri's build script checks externalBin paths while compiling the app.
  // Empty placeholders break that cycle; successful Cargo output replaces
  // every placeholder before Tauri can bundle it.
  for (const sidecar of plan.sidecars) {
    if (!existsSync(sidecar.destination)) {
      writeFileSync(sidecar.destination, "");
    }
  }

  console.log(
    `build-sidecar: cargo ${plan.cargoArguments.map((part) => JSON.stringify(part)).join(" ")}`,
  );
  execute("cargo", plan.cargoArguments, {
    cwd: plan.tauriDirectory,
    environment,
  });

  for (const sidecar of plan.sidecars) {
    if (!existsSync(sidecar.source)) {
      throw new Error(`expected built binary at ${sidecar.source}`);
    }
    const sourceStat = statSync(sidecar.source);
    if (!sourceStat.isFile() || sourceStat.size === 0) {
      throw new Error(`built binary is empty or invalid at ${sidecar.source}`);
    }
    copyFileSync(sidecar.source, sidecar.destination);
    if (plan.executableExtension !== ".exe") {
      chmodSync(sidecar.destination, 0o755);
    }
    console.log(`build-sidecar: staged ${sidecar.destination}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.environment,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}`,
    );
  }
  return result.stdout ?? "";
}

function main() {
  const environment = process.env;
  const { profile, forceTarget } = parseBuildArguments(
    process.argv.slice(2),
    environment,
  );
  const hostTriple = parseRustcHost(
    run("rustc", ["-vV"], {
      capture: true,
      cwd: defaultTauriDirectory,
      environment,
    }),
  );
  const targetTriple =
    environment.TAURI_ENV_TARGET_TRIPLE ||
    environment.CARGO_BUILD_TARGET ||
    hostTriple;
  const plan = resolveBuildPlan({
    environment,
    forceTarget,
    hostTriple,
    profile,
    tauriDirectory: defaultTauriDirectory,
    targetTriple,
  });

  executeBuildPlan(plan, { environment });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
