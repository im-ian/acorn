#!/usr/bin/env bash
# Build the `acorn-ipc` CLI and stage it where Tauri's externalBin expects
# it: `src-tauri/binaries/acorn-ipc-<target-triple>`.
#
# Tauri 2's externalBin convention names the staged file after the *target*
# triple — the one being built for, not the host the script is running on.
# When `tauri build --target X` runs, the matching `acorn-ipc-X` file must
# exist before the build script's existence check fires. For the release
# matrix on Apple-Silicon `macos-latest` runners that means producing an
# x86_64 binary alongside the aarch64 one, even though the host is aarch64.
#
# Tauri passes the active target through `TAURI_ENV_TARGET_TRIPLE` to
# commands spawned via `beforeBuildCommand`. Standalone callers (local
# `bun run build:sidecar`, manual runs) fall back to the host triple so
# the script keeps working without extra setup.
#
# Exits non-zero on any failure so the build surfaces the problem instead
# of silently shipping a `.app` without the CLI sidecar.

set -euo pipefail

cd "$(dirname "$0")/.."

profile="${TAURI_SIDECAR_PROFILE:-release}"
target_triple="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's|host: ||p')}"

if [ -z "$target_triple" ]; then
  echo "error: could not determine target triple (TAURI_ENV_TARGET_TRIPLE unset and \`rustc -vV\` produced no host line)" >&2
  exit 1
fi

# Always cross-compile with `--target` so the output lands in
# `target/<triple>/<profile>/` even when host == target. The uniform
# layout removes a branching copy step below and matches how the rest of
# the release workflow already invokes cargo for the main binary.
cargo_flags=(--bin acorn-ipc --target "$target_triple")
if [ "$profile" = "release" ]; then
  cargo_flags+=(--release)
fi

# Tauri's build.rs verifies that every `externalBin` path exists at
# compile time. The sidecar we're about to build *is* that externalBin,
# so the check would fail before we have a binary to point at. Stage an
# empty placeholder first to satisfy the existence check; cargo's build
# script only inspects whether the file is there, not its contents. The
# real binary overwrites the placeholder once `cargo build` finishes.
dest_dir="binaries"
dest="$dest_dir/acorn-ipc-$target_triple"
mkdir -p "$dest_dir"
if [ ! -f "$dest" ]; then
  : > "$dest"
fi

echo "build-sidecar: cargo build ${cargo_flags[*]}"
cargo build "${cargo_flags[@]}"

src="target/$target_triple/$profile/acorn-ipc"
if [ ! -f "$src" ]; then
  echo "error: expected built binary at $src" >&2
  exit 1
fi

cp -f "$src" "$dest"
chmod +x "$dest"

echo "build-sidecar: staged $dest"
