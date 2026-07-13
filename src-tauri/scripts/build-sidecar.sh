#!/usr/bin/env bash
# Build the sidecar binaries (`acorn-ipc`, `acornd`) and stage them where
# Tauri's externalBin expects: `src-tauri/binaries/<name>-<target-triple>`.
#
# Tauri 2's externalBin convention names the staged file after the target
# triple. Native builds use Cargo's standard host output directory so the
# following Tauri app build can reuse the same dependency artifacts. Cross
# builds keep target-specific output directories. Callers that explicitly
# pass the host triple to Tauri can set TAURI_SIDECAR_FORCE_TARGET=1 to make
# the sidecar use the same target-specific directory as the app build.
#
# Tauri passes the active target through `TAURI_ENV_TARGET_TRIPLE` to
# commands spawned via `beforeBuildCommand`. Standalone callers (local
# `pnpm run build:sidecar`, manual runs) use Cargo's configured target or
# fall back to the host triple so the script works without extra setup.
#
# Exits non-zero on any failure so the build surfaces the problem instead
# of silently shipping a `.app` without one of the sidecars.

set -euo pipefail

cd "$(dirname "$0")/.."

profile="${TAURI_SIDECAR_PROFILE:-release}"
host_triple="$(rustc -vV | sed -n 's|host: ||p')"
target_triple="${TAURI_ENV_TARGET_TRIPLE:-${CARGO_BUILD_TARGET:-$host_triple}}"
target_dir="${CARGO_TARGET_DIR:-target}"

if [ -z "$host_triple" ] || [ -z "$target_triple" ]; then
  echo "error: could not determine host and target triples" >&2
  exit 1
fi

# List of [[bin]] targets that need to land in the bundle. Each entry is
# `<bin-name>:<cargo-package>` because the sidecars now live in separate
# workspace crates (`acorn-ipc` is its own leaf crate; `acornd` ships
# from the main `acorn` package). Adding a new sidecar here is a
# single-line change; `externalBin` in tauri.conf.json must match.
sidecars=("acorn-ipc:acorn-ipc" "acornd:acorn")

# Cargo separates explicit-target artifacts from native artifacts even when
# both triples are identical. Keep native sidecars in target/<profile>/ so a
# regular `tauri dev` or `tauri build` does not compile the dependency graph
# again under target/<host-triple>/<profile>/.
cargo_flags=()
artifact_dir="$target_dir/$profile"
if [ "$target_triple" != "$host_triple" ] || [ "${TAURI_SIDECAR_FORCE_TARGET:-0}" = "1" ] || [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  cargo_flags+=(--target "$target_triple")
  artifact_dir="$target_dir/$target_triple/$profile"
fi
for entry in "${sidecars[@]}"; do
  bin="${entry%%:*}"
  pkg="${entry##*:}"
  cargo_flags+=(-p "$pkg" --bin "$bin")
done
if [ "$profile" = "release" ]; then
  cargo_flags+=(--release)
elif [ "$profile" != "debug" ]; then
  cargo_flags+=(--profile "$profile")
fi

# Tauri's build.rs verifies that every `externalBin` path exists at
# compile time. The sidecars we're about to build *are* those externalBin
# entries, so the check would fail before we have binaries to point at.
# Stage empty placeholders first to satisfy the existence check; cargo's
# build script only inspects whether each file is there, not its
# contents. The real binaries overwrite the placeholders once
# `cargo build` finishes.
dest_dir="binaries"
mkdir -p "$dest_dir"
for entry in "${sidecars[@]}"; do
  bin="${entry%%:*}"
  dest="$dest_dir/$bin-$target_triple"
  if [ ! -f "$dest" ]; then
    : > "$dest"
  fi
done

echo "build-sidecar: cargo build ${cargo_flags[*]}"
cargo build "${cargo_flags[@]}"

for entry in "${sidecars[@]}"; do
  bin="${entry%%:*}"
  src="$artifact_dir/$bin"
  dest="$dest_dir/$bin-$target_triple"
  if [ ! -f "$src" ]; then
    echo "error: expected built binary at $src" >&2
    exit 1
  fi
  cp -f "$src" "$dest"
  chmod +x "$dest"
  echo "build-sidecar: staged $dest"
done
