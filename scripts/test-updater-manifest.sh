#!/usr/bin/env bash
# Offline check for the updater-manifest plumbing in
# .github/workflows/release-tauri.yml. Deps: bash + coreutils only.
#
# The workflow is not runnable locally and each real iteration is a ~20 minute
# build, so this reproduces the two things that actually broke on the manifest
# step's first execution (v5.1.3), against a fake `dist` tree shaped the way
# actions/download-artifact@v4 lays one out:
#
#   1. macOS bundles were located with `find -path '*aarch64*'` / '*x86_64*'.
#      upload-artifact@v4 rebases uploaded paths onto their common ancestor,
#      which strips the `<target>-apple-darwin` segment — so the predicate can
#      never match and both variables came out empty.
#   2. Both macOS legs bundle `Token Dashboard.app.tar.gz`. Release assets are
#      a flat namespace: the two collide on upload, and the manifest derives
#      one url for both arches — silently serving the wrong architecture.
#
# Run: bash scripts/test-updater-manifest.sh
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cd "$root"

fake() { mkdir -p "$(dirname "$1")"; printf 'content-of-%s\n' "$(basename "$1")" > "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. what each macOS build leg produces, then renames ---------------------
# Mirrors the "Name the macOS updater archive per arch" step.
for arch in aarch64 x64; do
  case $arch in
    aarch64) tgt=aarch64-apple-darwin ;;
    x64)     tgt=x86_64-apple-darwin ;;
  esac
  dir="target/$tgt/release/bundle/macos"
  fake "$dir/Token Dashboard.app.tar.gz"
  fake "$dir/Token Dashboard.app.tar.gz.sig"

  src=$(find "$dir" -name '*.app.tar.gz' | head -1)
  [ -n "$src" ] && [ -f "$src.sig" ] || fail "rename step found no signed archive in $dir"
  mv "$src"     "$dir/Token.Dashboard_${arch}.app.tar.gz"
  mv "$src.sig" "$dir/Token.Dashboard_${arch}.app.tar.gz.sig"
done

# --- 2. what download-artifact@v4 hands the release job ----------------------
# Note the rebasing: the `<target>-apple-darwin` segment is GONE, replaced by
# the artifact name (`token-dashboard-<matrix.label>`).
mkdir -p dist/token-dashboard-macos-arm64 dist/token-dashboard-macos-x64
cp -r target/aarch64-apple-darwin/release/bundle/macos dist/token-dashboard-macos-arm64/macos
cp -r target/x86_64-apple-darwin/release/bundle/macos  dist/token-dashboard-macos-x64/macos
fake 'dist/token-dashboard-macos-arm64/dmg/Token Dashboard_9.9.9_aarch64.dmg'
fake 'dist/token-dashboard-macos-x64/dmg/Token Dashboard_9.9.9_x64.dmg'
fake 'dist/token-dashboard-windows/Token Dashboard_9.9.9_x64_en-US.msi'
fake 'dist/token-dashboard-windows/Token Dashboard_9.9.9_x64_en-US.msi.sig'
fake 'dist/token-dashboard-linux/deb/Token Dashboard_9.9.9_amd64.deb'
fake 'dist/token-dashboard-linux/appimage/Token Dashboard_9.9.9_amd64.AppImage'
fake 'dist/token-dashboard-linux/appimage/Token Dashboard_9.9.9_amd64.AppImage.sig'

# Guard the premise: if this ever matches, the fake tree stopped being faithful
# to how download-artifact rebases and the rest of the test proves nothing.
[ -z "$(find dist -path '*apple-darwin*' -name '*.app.tar.gz')" ] \
  || fail "fake tree is unrealistic — the arch path segment survived"

# --- 3. the manifest step's lookups and url derivation ----------------------
base="https://github.com/Arylmera/token-dashboard/releases/download/v9.9.9"
gh_name() { basename "$1" | tr ' ' '.'; }   # GitHub turns spaces into dots

msi=$(find dist -name '*.msi' | head -1)
appimage=$(find dist -name '*.AppImage' | head -1)
mac_arm=$(find dist -name 'Token.Dashboard_aarch64.app.tar.gz' | head -1)
mac_x64=$(find dist -name 'Token.Dashboard_x64.app.tar.gz' | head -1)
for f in "$msi" "$appimage" "$mac_arm" "$mac_x64"; do
  [ -n "$f" ] && [ -f "$f" ] && [ -f "$f.sig" ] \
    || fail "missing updater artifact or signature: '$f'"
done

arm_url="$base/$(gh_name "$mac_arm")"
x64_url="$base/$(gh_name "$mac_x64")"
[ "$arm_url" != "$x64_url" ]         || fail "the two macOS urls are identical"
[[ "$arm_url" == *_aarch64.app.tar.gz ]] || fail "arm url wrong: $arm_url"
[[ "$x64_url" == *_x64.app.tar.gz ]]     || fail "x64 url wrong: $x64_url"
for u in "$arm_url" "$x64_url" "$base/$(gh_name "$msi")" "$base/$(gh_name "$appimage")"; do
  [[ "$u" != *" "* ]] || fail "space survived into url: $u"
done

# --- 4. every release asset must have a unique basename (flat namespace) -----
dupes=$(find dist -type f \( -name '*.msi' -o -name '*.dmg' -o -name '*.deb' \
          -o -name '*.AppImage' -o -name '*.app.tar.gz' -o -name '*.sig' \) \
          -exec basename {} \; | tr ' ' '.' | sort | uniq -d)
[ -z "$dupes" ] || fail "colliding release assets: $dupes"

echo "PASS — manifest lookups resolve, macOS urls are per-arch, no asset collides"
