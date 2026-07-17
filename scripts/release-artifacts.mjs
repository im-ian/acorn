#!/usr/bin/env node

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function filesBelow(root, maxDepth) {
  const output = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) output.push(path);
    }
  };
  visit(root, 0);
  return output.sort();
}

function requireExactlyOne(files, label) {
  if (files.length !== 1) {
    throw new Error(`expected exactly one ${label}, found ${files.length}`);
  }
  return files[0];
}

function artifactArchitecture(file) {
  const name = basename(file);
  const stem = name.replace(/(?:\.dmg|\.app\.tar\.gz(?:\.sig)?)$/i, "");
  if (/(?:^|[._-])aarch64$/i.test(stem)) return "aarch64";
  if (/(?:^|[._-])(?:x64|x86_64)$/i.test(stem)) return "x86_64";
  throw new Error(
    `artifact filename must end with exactly one architecture suffix: ${JSON.stringify(name)}`,
  );
}

function archFile(files, arch, label) {
  return requireExactlyOne(
    files.filter((file) => artifactArchitecture(file) === arch),
    `${arch} ${label}`,
  );
}

export function stageBuildArtifacts(bundleDirectory, outputDirectory, suffix) {
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
    throw new Error(`invalid artifact architecture suffix ${JSON.stringify(suffix)}`);
  }

  const dmgFiles = filesBelow(join(bundleDirectory, "dmg"), 2).filter((file) =>
    file.endsWith(".dmg"),
  );
  const macosFiles = filesBelow(join(bundleDirectory, "macos"), 2);
  const tarFiles = macosFiles.filter((file) => file.endsWith(".app.tar.gz"));
  const signatureFiles = macosFiles.filter((file) =>
    file.endsWith(".app.tar.gz.sig"),
  );
  const dmg = requireExactlyOne(dmgFiles, "DMG");
  const tar = requireExactlyOne(tarFiles, "updater tarball");
  const signature = requireExactlyOne(signatureFiles, "updater signature");
  if (signature !== `${tar}.sig`) {
    throw new Error("updater signature filename does not match its tarball");
  }

  mkdirSync(outputDirectory, { recursive: true });
  const base = basename(tar, ".app.tar.gz");
  const staged = {
    dmg: join(outputDirectory, basename(dmg)),
    tar: join(outputDirectory, `${base}_${suffix}.app.tar.gz`),
    signature: join(outputDirectory, `${base}_${suffix}.app.tar.gz.sig`),
  };
  copyFileSync(dmg, staged.dmg);
  copyFileSync(tar, staged.tar);
  copyFileSync(signature, staged.signature);
  return staged;
}

export function inspectPublishedArtifacts(directory) {
  const files = readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .sort();
  const dmgs = files.filter((file) => file.endsWith(".dmg"));
  const tarballs = files.filter((file) => file.endsWith(".app.tar.gz"));
  const signatures = files.filter((file) => file.endsWith(".app.tar.gz.sig"));
  if (dmgs.length !== 2 || tarballs.length !== 2 || signatures.length !== 2) {
    throw new Error(
      `expected two DMGs, tarballs, and signatures; found ${dmgs.length}/${tarballs.length}/${signatures.length}`,
    );
  }

  // Classify every file by its terminal Tauri architecture suffix before
  // selecting it. Earlier tokens may be part of a prerelease version (for
  // example `2.0.0-x64`) and must not be mistaken for the actual architecture.
  for (const file of [...dmgs, ...tarballs, ...signatures]) {
    artifactArchitecture(file);
  }

  const result = {
    armDmg: archFile(dmgs, "aarch64", "DMG"),
    x64Dmg: archFile(dmgs, "x86_64", "DMG"),
    armTar: archFile(tarballs, "aarch64", "updater tarball"),
    x64Tar: archFile(tarballs, "x86_64", "updater tarball"),
  };
  result.armSignature = `${result.armTar}.sig`;
  result.x64Signature = `${result.x64Tar}.sig`;
  const expectedSignatures = [result.armSignature, result.x64Signature].sort();
  if (JSON.stringify(signatures) !== JSON.stringify(expectedSignatures)) {
    throw new Error("updater tarball/signature pairs are incomplete or cross-paired");
  }
  return result;
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "stage" && args.length === 3) {
    const staged = stageBuildArtifacts(args[0], args[1], args[2]);
    process.stdout.write(`${JSON.stringify(staged, null, 2)}\n`);
    return;
  }
  if (mode === "inspect" && args.length === 1) {
    process.stdout.write(
      `${JSON.stringify(inspectPublishedArtifacts(args[0]), null, 2)}\n`,
    );
    return;
  }
  throw new Error(
    "usage: release-artifacts.mjs stage <bundle-dir> <output-dir> <arch> | inspect <artifacts-dir>",
  );
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
