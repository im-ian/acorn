#!/usr/bin/env bash
# Build the `acorn-ipc` CLI and stage it where Tauri's externalBin expects
# it: `src-tauri/binaries/acorn-ipc-<host-triple>`.
#
# Tauri 2's externalBin convention requires the file name to end with the
# build target triple; this script asks rustc for the host triple, builds
# in release mode, and copies the binary into place with the right name.
# Invoke before `tauri build` (wired via `beforeBuildCommand`).
#
# Exits non-zero on any failure so the build fails loudly instead of
# silently shipping a `.app` without the CLI sidecar.

set -euo pipefail

cd "$(dirname "$0")/.."

profile="${TAURI_SIDECAR_PROFILE:-release}"
target_triple="$(rustc -vV | sed -n 's|host: ||p')"

if [ -z "$target_triple" ]; then
  echo "error: could not read host triple from \`rustc -vV\`" >&2
  exit 1
fi

cargo_flags=(--bin acorn-ipc)
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

echo "build-sidecar: cargo build ${cargo_flags[*]} (triple=$target_triple)"
cargo build "${cargo_flags[@]}"

src="target/$profile/acorn-ipc"
if [ ! -f "$src" ]; then
  echo "error: expected built binary at $src" >&2
  exit 1
fi

cp -f "$src" "$dest"
chmod +x "$dest"

echo "build-sidecar: staged $dest"
