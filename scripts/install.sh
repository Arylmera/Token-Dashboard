#!/usr/bin/env bash
# Token Dashboard installer for macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Arylmera/Token-Dashboard/main/scripts/install.sh | bash
#
# What it does:
#   1. If Homebrew is present, install the cask. Otherwise download the latest
#      DMG from the GitHub releases API and copy the .app to /Applications.
#   2. Re-sign the bundle ad-hoc so macOS doesn't reject it for Team-ID
#      mismatch on first launch (the embedded Electron Framework is signed by
#      Electron's team while the outer bundle is unsigned).
#   3. Launch the app.

set -euo pipefail

REPO="Arylmera/Token-Dashboard"
CASK="arylmera/token-dashboard/token-dashboard"
APP_NAME="Token Dashboard"
APP_PATH="/Applications/${APP_NAME}.app"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This installer is macOS-only. For Linux/Windows see https://github.com/${REPO}#readme"
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  warn "Detected $(uname -m); only Apple Silicon (arm64) builds are published. Continuing anyway."
fi

if command -v brew >/dev/null 2>&1; then
  info "Homebrew detected — installing the cask"
  brew install --cask "${CASK}"
else
  info "Homebrew not found — downloading latest DMG from GitHub Releases"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"; [[ -n "${mount_point:-}" ]] && hdiutil detach "${mount_point}" -quiet >/dev/null 2>&1 || true' EXIT

  dmg_url="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -oE 'https://[^"]*macos-arm64[^"]*\.dmg' | head -n 1)"

  if [[ -z "${dmg_url}" ]]; then
    err "Could not find a macOS DMG in the latest release of ${REPO}."
    exit 1
  fi

  info "Downloading ${dmg_url}"
  curl -fL --progress-bar -o "${tmp}/td.dmg" "${dmg_url}"

  info "Mounting DMG"
  mount_point="$(hdiutil attach -nobrowse -noautoopen "${tmp}/td.dmg" \
    | grep -oE '/Volumes/.+$' | tail -n 1)"

  if [[ -z "${mount_point}" || ! -d "${mount_point}/${APP_NAME}.app" ]]; then
    err "DMG mounted but ${APP_NAME}.app was not found inside."
    exit 1
  fi

  info "Copying ${APP_NAME}.app to /Applications"
  rm -rf "${APP_PATH}"
  cp -R "${mount_point}/${APP_NAME}.app" "${APP_PATH}"
fi

if [[ ! -d "${APP_PATH}" ]]; then
  err "${APP_PATH} not found after install."
  exit 1
fi

info "Re-signing bundle ad-hoc (fixes Team-ID mismatch on first launch)"
codesign --force --deep --sign - "${APP_PATH}"

info "Launching ${APP_NAME}"
open -a "${APP_NAME}"

info "Done. ${APP_NAME} is installed and running."
