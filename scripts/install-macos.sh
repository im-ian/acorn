#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

repo="${ACORN_REPO:-im-ian/acorn}"
app_name="Acorn"
install_dir="${ACORN_INSTALL_DIR:-/Applications}"
expected_bundle_id="io.im-ian.acorn"

repo_owner="${repo%%/*}"
repo_name="${repo#*/}"
if [[ "$repo_owner" == "$repo" \
  || ! "$repo_owner" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ \
  || ! "$repo_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ \
  || "$repo_name" == "." \
  || "$repo_name" == ".." ]]; then
  echo "error: ACORN_REPO must be a GitHub owner/repository slug" >&2
  exit 1
fi
case "$install_dir" in
  ""|[!/]*|/|//*|*/|*//*|*/.|*/..|*/./*|*/../*|*$'\n'*|*$'\r'*)
    echo "error: ACORN_INSTALL_DIR must be a normalized absolute directory other than /" >&2
    exit 1
    ;;
esac

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

for tool in codesign curl hdiutil ditto mktemp dirname osascript lipo shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool not found: $tool" >&2
    exit 1
  fi
done
if [[ ! -x /usr/libexec/PlistBuddy ]]; then
  echo "error: required tool not found: /usr/libexec/PlistBuddy" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/acorn-install.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd -P)"
mount_dir="$tmp_dir/mount"
dmg_path="$tmp_dir/acorn.dmg"
mkdir -p "$mount_dir"

cleanup() {
  hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "Resolving latest Acorn release..."
api_url="https://api.github.com/repos/${repo}/releases/latest"
release_json="$tmp_dir/latest.json"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --fail --show-error --silent --location \
  --connect-timeout 15 --max-time 60 --max-filesize 2097152 \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: acorn-install-macos" \
  "$api_url" > "$release_json"

release_asset="$(
  osascript -l JavaScript \
    -e 'ObjC.import("Foundation");' \
    -e 'function run(argv) {' \
    -e '  const text = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null));' \
    -e '  const release = JSON.parse(text);' \
    -e '  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error("invalid GitHub release payload");' \
    -e '  const suffix = new RegExp("_(" + argv[2] + ")\\.dmg$");' \
    -e '  const matches = release.assets.filter((asset) => asset && typeof asset.name === "string" && /^[A-Za-z0-9._-]+$/.test(asset.name) && suffix.test(asset.name));' \
    -e '  if (matches.length !== 1) throw new Error("expected exactly one matching macOS DMG");' \
    -e '  const expected = "https://github.com/" + argv[1] + "/releases/download/" + release.tag_name + "/" + matches[0].name;' \
    -e '  if (matches[0].browser_download_url !== expected) throw new Error("unexpected GitHub release asset URL");' \
    -e '  if (!/^sha256:[0-9a-f]{64}$/.test(matches[0].digest)) throw new Error("missing or invalid GitHub release asset digest");' \
    -e '  return matches[0].digest + "\n" + expected;' \
    -e '}' \
    "$release_json" "$repo" "$arch_pattern"
)"
dmg_digest="${release_asset%%$'\n'*}"
dmg_url="${release_asset#*$'\n'}"

if [[ "$dmg_digest" != sha256:* || -z "$dmg_url" || "$dmg_url" == "$release_asset" ]]; then
  echo "error: could not find a matching macOS DMG for $(uname -m) in the latest release" >&2
  exit 1
fi

echo "Downloading $dmg_url"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --fail --show-error --location --retry 3 --retry-delay 2 \
  --connect-timeout 15 --max-time 600 --max-filesize 536870912 \
  -o "$dmg_path" "$dmg_url"

actual_digest="$(shasum -a 256 "$dmg_path")"
actual_digest="sha256:${actual_digest%% *}"
if [[ "$actual_digest" != "$dmg_digest" ]]; then
  echo "error: downloaded DMG SHA-256 does not match the GitHub release digest" >&2
  exit 1
fi

echo "Verifying DMG checksum..."
hdiutil verify "$dmg_path" -quiet
echo "Mounting DMG..."
hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -readonly -quiet

source_app="$mount_dir/${app_name}.app"
if [[ ! -d "$source_app" || -L "$source_app" ]]; then
  echo "error: ${app_name}.app was not found in the DMG" >&2
  exit 1
fi
contents_dir="$source_app/Contents"
macos_dir="$contents_dir/MacOS"
info_plist="$contents_dir/Info.plist"
if [[ ! -d "$contents_dir" || -L "$contents_dir" \
  || ! -d "$macos_dir" || -L "$macos_dir" \
  || ! -f "$info_plist" || -L "$info_plist" ]]; then
  echo "error: Acorn app bundle structure is invalid" >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$source_app"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist" 2>/dev/null || true)"
if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
  echo "error: unexpected app bundle identifier: ${bundle_id:-missing}" >&2
  exit 1
fi
main_executable="$macos_dir/acorn"
if [[ ! -f "$main_executable" || -L "$main_executable" ]]; then
  echo "error: Acorn main executable is missing or invalid" >&2
  exit 1
fi
expected_binary_arch="$(uname -m)"
if [[ " $(lipo -archs "$main_executable") " != *" $expected_binary_arch "* ]]; then
  echo "error: Acorn executable does not contain the expected $expected_binary_arch architecture" >&2
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
codesign --verify --deep --strict --verbose=2 "$target_app"

echo "Installed ${app_name} to $target_app"
