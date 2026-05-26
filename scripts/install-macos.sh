#!/usr/bin/env bash
set -euo pipefail

repo="${ACORN_REPO:-im-ian/acorn}"
app_name="Acorn"
install_dir="${ACORN_INSTALL_DIR:-/Applications}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this installer only supports macOS" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) arch_pattern="aarch64" ;;
  x86_64) arch_pattern="x64|x86_64" ;;
  *)
    echo "error: unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for tool in curl hdiutil ditto xattr sed grep mktemp tr dirname; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool not found: $tool" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/acorn-install.XXXXXX")"
mount_dir="$tmp_dir/mount"
dmg_path="$tmp_dir/acorn.dmg"
mkdir -p "$mount_dir"

cleanup() {
  if mount | grep -F " on $mount_dir " >/dev/null 2>&1; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "Resolving latest Acorn release..."
api_url="https://api.github.com/repos/${repo}/releases/latest"
release_json="$tmp_dir/latest.json"
curl -fsSL \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: acorn-install-macos" \
  "$api_url" > "$release_json"

dmg_url="$(
  tr ',' '\n' < "$release_json" \
    | grep -E '"browser_download_url"[[:space:]]*:' \
    | sed -E 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
    | grep -E "_(${arch_pattern})\\.dmg$" \
    | head -n1 \
    || true
)"

if [[ -z "$dmg_url" ]]; then
  echo "error: could not find a matching macOS DMG for $(uname -m) in the latest release" >&2
  exit 1
fi

echo "Downloading $dmg_url"
curl -fL --retry 3 --retry-delay 2 -o "$dmg_path" "$dmg_url"

echo "Mounting DMG..."
hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -readonly -quiet

source_app="$(find "$mount_dir" -maxdepth 1 -type d -name "${app_name}.app" -print -quit)"
if [[ -z "$source_app" ]]; then
  echo "error: ${app_name}.app was not found in the DMG" >&2
  exit 1
fi

target_app="${install_dir}/${app_name}.app"

run_install_cmd() {
  if [[ -w "$install_dir" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

if [[ ! -d "$install_dir" ]]; then
  echo "Creating $install_dir"
  install_parent="$(dirname "$install_dir")"
  if [[ -w "$install_parent" ]]; then
    mkdir -p "$install_dir"
  else
    sudo mkdir -p "$install_dir"
  fi
fi

echo "Installing to $target_app"
osascript -e "tell application \"${app_name}\" to quit" >/dev/null 2>&1 || true

if [[ -e "$target_app" ]]; then
  run_install_cmd rm -rf "$target_app"
fi
run_install_cmd ditto "$source_app" "$target_app"

echo "Removing quarantine attribute..."
run_install_cmd xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true

echo "Installed ${app_name} to $target_app"
