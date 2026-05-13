#!/usr/bin/env bash
# Token Dashboard — macOS installer (Apple Silicon).
#
# Pulls the latest v4.x .dmg from the GitHub releases API, copies the .app
# into /Applications, ad-hoc re-signs it (the bundle is unsigned, so macOS
# 14+ refuses to load the embedded WebKit/Tauri frameworks otherwise), and
# launches it.
#
#   curl -fsSL https://raw.githubusercontent.com/Arylmera/Token-Dashboard/main/scripts/install.sh | bash

set -euo pipefail

REPO="Arylmera/Token-Dashboard"
APP_NAME="Token Dashboard"
APP_PATH="/Applications/${APP_NAME}.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: install.sh is macOS-only. On Windows, download the .msi from"
  echo "       https://github.com/${REPO}/releases/latest"
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  arm64)  primary='aarch64.*\.dmg$';            fallback='x64.*\.dmg$|x86_64.*\.dmg$' ;;
  x86_64) primary='x64.*\.dmg$|x86_64.*\.dmg$'; fallback='' ;;
  *) echo "error: unsupported arch $arch"; exit 1 ;;
esac

echo "==> resolving latest v4 release"
api_url="https://api.github.com/repos/${REPO}/releases/latest"
assets="$(curl -fsSL "$api_url" \
  | grep -Eo '"browser_download_url": *"[^"]+"' \
  | sed -E 's/.*"([^"]+)"/\1/')"

dmg_url="$(printf '%s\n' "$assets" | grep -E "$primary" | head -1 || true)"

if [[ -z "${dmg_url:-}" && -n "$fallback" ]]; then
  dmg_url="$(printf '%s\n' "$assets" | grep -E "$fallback" | head -1 || true)"
  if [[ -n "${dmg_url:-}" ]]; then
    echo "==> no native arm64 build on latest release — falling back to x64 (runs via Rosetta)"
    if ! /usr/bin/pgrep oahd >/dev/null 2>&1; then
      echo "    Rosetta 2 not detected. If the app fails to launch, run:"
      echo "    softwareupdate --install-rosetta --agree-to-license"
    fi
  fi
fi

if [[ -z "${dmg_url:-}" ]]; then
  echo "error: no .dmg asset on the latest release for arch '$arch'"
  exit 1
fi

echo "==> downloading $(basename "$dmg_url")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dmg="${tmp}/td.dmg"
curl -fsSL -o "$dmg" "$dmg_url"

echo "==> mounting"
mount_point="$(hdiutil attach -nobrowse -readonly "$dmg" \
  | tail -1 | awk '{ for (i=3; i<=NF; i++) printf "%s ", $i }' | sed 's/ *$//')"

src_app="${mount_point}/${APP_NAME}.app"
if [[ ! -d "$src_app" ]]; then
  hdiutil detach "$mount_point" >/dev/null || true
  echo "error: ${APP_NAME}.app not found inside dmg"
  exit 1
fi

echo "==> copying to /Applications"
rm -rf "$APP_PATH"
cp -R "$src_app" "$APP_PATH"
hdiutil detach "$mount_point" >/dev/null

echo "==> ad-hoc re-signing (fixes Team-ID dyld mismatch on unsigned bundles)"
codesign --force --deep --sign - "$APP_PATH"
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

echo "==> launching"
open -a "$APP_NAME"

echo
echo "Installed to ${APP_PATH}"
