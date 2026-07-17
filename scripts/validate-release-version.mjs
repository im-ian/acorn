#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_TAG_RE =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?)$/;

export function releaseVersionFromTag(tag) {
  if (typeof tag !== "string") return null;
  return RELEASE_TAG_RE.exec(tag)?.[1] ?? null;
}

export function compareReleaseTags(leftTag, rightTag) {
  const left = releaseVersionFromTag(leftTag);
  const right = releaseVersionFromTag(rightTag);
  if (!left || !right) {
    throw new Error(
      `cannot compare invalid release tags ${JSON.stringify(leftTag)} and ${JSON.stringify(rightTag)}`,
    );
  }

  const parse = (version) => {
    const separator = version.indexOf("-");
    const core = separator === -1 ? version : version.slice(0, separator);
    const prerelease = separator === -1 ? null : version.slice(separator + 1);
    return {
      core: core.split(".").map((part) => BigInt(part)),
      prerelease: prerelease?.split(".") ?? null,
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] < rightVersion.core[index]) return -1;
    if (leftVersion.core[index] > rightVersion.core[index]) return 1;
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;

  const count = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function assertReleaseIsNewer(candidateTag, currentTag) {
  if (compareReleaseTags(candidateTag, currentTag) <= 0) {
    throw new Error(
      `release ${candidateTag} is not newer than current latest ${currentTag}`,
    );
  }
}

export function assertMatchingReleaseVersions(tag, versions) {
  const releaseVersion = releaseVersionFromTag(tag);
  if (!releaseVersion) {
    throw new Error(
      `invalid release tag ${JSON.stringify(tag)}; expected vMAJOR.MINOR.PATCH with an optional prerelease suffix`,
    );
  }

  for (const [source, version] of Object.entries(versions)) {
    if (version !== releaseVersion) {
      throw new Error(
        `release version mismatch: ${source} has ${JSON.stringify(version)}, tag ${tag} requires ${releaseVersion}`,
      );
    }
  }
  return releaseVersion;
}

export function readRepositoryVersions(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const tauriConfig = JSON.parse(
    readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const cargoToml = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
  const packageHeader = /^\[package\]\s*$/m.exec(cargoToml);
  const packageRemainder = packageHeader
    ? cargoToml.slice(packageHeader.index + packageHeader[0].length)
    : "";
  const nextSection = packageRemainder.search(/^\[/m);
  const packageSection =
    nextSection >= 0 ? packageRemainder.slice(0, nextSection) : packageRemainder;
  const cargoVersion = /^version\s*=\s*"([^"]+)"\s*(?:#.*)?$/m.exec(
    packageSection ?? "",
  )?.[1];
  if (!cargoVersion) {
    throw new Error("could not read [package].version from src-tauri/Cargo.toml");
  }

  return {
    "package.json": packageJson.version,
    "src-tauri/tauri.conf.json": tauriConfig.version,
    "src-tauri/Cargo.toml": cargoVersion,
  };
}

export function validateRepositoryReleaseVersion(tag, root = process.cwd()) {
  return assertMatchingReleaseVersions(tag, readRepositoryVersions(root));
}

function main() {
  if (process.argv[2] === "--assert-newer" && process.argv.length === 5) {
    assertReleaseIsNewer(process.argv[3], process.argv[4]);
    return;
  }
  const tag = process.argv[2];
  const version = validateRepositoryReleaseVersion(tag);
  process.stdout.write(`${version}\n`);
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
