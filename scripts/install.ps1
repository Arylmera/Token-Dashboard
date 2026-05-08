# Token Dashboard installer for Windows.
#
# Usage:
#   irm https://raw.githubusercontent.com/Arylmera/Token-Dashboard/main/scripts/install.ps1 | iex
#
# What it does:
#   1. Query the GitHub releases API for the latest release.
#   2. Download the Windows NSIS installer (token-dashboard-*-windows-x64-*.exe),
#      falling back to the standalone PyInstaller binary if no NSIS asset is
#      published in this release.
#   3. Run the installer. The user accepts the SmartScreen "More info -> Run
#      anyway" prompt if Windows flags the unsigned binary.

$ErrorActionPreference = 'Stop'
$Repo = 'Arylmera/Token-Dashboard'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "warn: $msg" -ForegroundColor Yellow }

Write-Step "Fetching latest release info from GitHub"
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing

# Prefer the NSIS desktop installer; fall back to the standalone exe if absent.
$asset = $release.assets | Where-Object { $_.name -match '^token-dashboard-.*-windows-x64-.+\.exe$' } | Select-Object -First 1
if (-not $asset) {
    Write-Warn "No NSIS installer in $($release.tag_name); falling back to the standalone exe."
    $asset = $release.assets | Where-Object { $_.name -match '^token-dashboard-.*-windows-x64\.exe$' } | Select-Object -First 1
}
if (-not $asset) {
    throw "Could not find a Windows asset in release $($release.tag_name) of $Repo."
}

$dest = Join-Path $env:TEMP $asset.name
Write-Step "Downloading $($asset.name)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -UseBasicParsing

Write-Step "Launching $($asset.name)"
Write-Host "    If SmartScreen prompts, click 'More info' -> 'Run anyway'." -ForegroundColor DarkGray
Start-Process -FilePath $dest -Wait

Write-Step "Done. Launch Token Dashboard from the Start Menu."
