# Scoop manifest

This is the source manifest for the Scoop bucket
[`Arylmera/scoop-token-dashboard`](https://github.com/Arylmera/scoop-token-dashboard).

## Publishing the bucket (one-time)

1. Create a public repo named `scoop-token-dashboard` on GitHub.
2. Copy `token-dashboard.json` into a `bucket/` folder at the repo root.
3. Push.

After that, users install via:

```powershell
scoop bucket add token-dashboard https://github.com/Arylmera/scoop-token-dashboard
scoop install token-dashboard
```

## Updating per release

On every `v4.*` tag:

1. Compute the MSI SHA-256:

   ```powershell
   (Get-FileHash .\Token.Dashboard_x64_en-US.msi -Algorithm SHA256).Hash.ToLower()
   ```

2. In the bucket repo, bump `version` and replace `hash`.
3. Commit + push. Scoop's `checkver` + `autoupdate` keys handle the rest
   on subsequent versions if you wire `scoop checkver -u` in a workflow.

## CI hook (optional)

Add a `scoop` job to `.github/workflows/release-tauri.yml` mirroring the
existing `homebrew` job:

- Download the `token-dashboard-windows-x64` artifact.
- Compute SHA-256 of the MSI.
- Clone `Arylmera/scoop-token-dashboard` with a PAT (`SCOOP_BUCKET_TOKEN`).
- `sed`-replace `version` and `hash` in `bucket/token-dashboard.json`.
- Commit + push.
