# Developer documentation

Technical reference for contributors and anyone building Token Dashboard
from source. End-user install instructions live in the
[README](../README.md).

## Build from source

Pre-built installers cover most cases. Build locally only if you want to
hack on it.

```bash
git clone https://github.com/Arylmera/Token-Dashboard
cd Token-Dashboard

# Frontend bundle
cd frontend && npm install && npm run build && cd ..

# Desktop shell
cargo build --release -p token-dashboard-tauri

# Or produce a real installer (.msi / .dmg / .AppImage)
cargo install tauri-cli --version "^2"
cargo tauri build
```

Headless mode (HTTP server only, point a browser at the bound URL):

```bash
cargo run --release -p token-dashboard-cli
```

For iterative frontend work, prefer `npm run dev` (esbuild `--watch`
with sourcemaps) over re-running `npm run build` on every change — it
stays resident and rebuilds `dist/app.js` on save.

### Build prerequisites

- **Rust 1.78+** — `winget install Rustlang.Rustup` (Windows) or
  `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
- **Node.js 18+** — for the esbuild frontend bundle.
- **WebView2** — ships with Windows 10+.
- **webkit2gtk-4.1 + libappindicator** — Linux only:
  `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`.

## Architecture

```
crates/
  token-dashboard-core/   scanner, db, queries, pricing, preferences,
                          tips, skills_catalog, anthropic_sync, sources.
                          No process model — just a library.
  token-dashboard-cli/    axum router + tokio bin (`token-dashboard`).
                          Owns the /api/* surface and the SSE bus.
  token-dashboard-tauri/  Tauri 2 desktop shell. Links the cli as a
                          library and calls app(state) directly inside
                          the tauri runtime — single process, no
                          subprocess to spawn or kill.

frontend/                 React 18 + esbuild (`entry.jsx` →
                          `frontend/dist/app.js`). The webview talks
                          directly to /api/* through the embedded
                          server; the SSE consumer in api-client.js
                          drives view refreshes.
docs/                     plan, design, roadmap, inspiration.
```

## Data source

Claude Code writes one JSONL file per session to
`~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is a
message record; usage fields live at `message.usage` and the model
identifier at `message.model`. The scanner
(`crates/token-dashboard-core/src/scanner.rs`) is incremental — it
tracks each file's mtime and byte offset in the `files` table and only
reads new bytes on subsequent scans.

## Configuration

Sensible defaults — override only when you need to.

| Variable                  | Default                              |
|---------------------------|--------------------------------------|
| `PORT`                    | `8080` (cli only — tauri picks free) |
| `HOST`                    | `127.0.0.1`                          |
| `TOKEN_DASHBOARD_DB`      | `~/.claude/token-dashboard.db`       |
| `CLAUDE_PROJECTS_DIR`     | `~/.claude/projects`                 |
| `TOKEN_DASHBOARD_PRICING` | (embedded copy of `pricing.json`)    |
| `TOKEN_DASHBOARD_STATIC`  | (auto-detected)                      |

## Verifying changes

```bash
cargo test --workspace
cargo fmt --check
cargo clippy --all-targets --workspace -- -D warnings
```

Frontend smoke check:

```bash
cd frontend && npm install && npm run build && cd ..
cargo run --release -p token-dashboard-tauri
```

## Releasing

Token Dashboard uses a two-branch model:

- **`develop`** — the working/integration branch. All feature and fix PRs
  squash-merge here first, so it is always **ahead** of `main`.
- **`main`** — the released/stable branch. It deliberately **trails**
  `develop` and only catches up at release time. It should contain only
  what has shipped.

A release simply **promotes `develop` to `main`**. The CI does the rest.

### Steps

To release version `X.Y.Z`:

1. **Bump the version in four places** (they must stay in sync):
   - `crates/token-dashboard-core/Cargo.toml`
   - `crates/token-dashboard-cli/Cargo.toml`
   - `crates/token-dashboard-tauri/Cargo.toml`
   - `crates/token-dashboard-tauri/tauri.conf.json`

   `Cargo.lock` is gitignored, so only those four files appear in the
   commit (`cargo update -p ...` refreshes the lock locally but it is
   not tracked).

2. Commit on `develop`:

   ```bash
   git commit -am "chore(release): bump version to X.Y.Z"
   git push origin develop
   ```

3. Open a **`develop` → `main` pull request** titled `Release vX.Y.Z`.
   Wait for CI (rust, frontend-tests, source-branch checks) to go green.

4. **Merge it as a merge commit** — not squash, not rebase:

   ```bash
   gh pr merge <number> --merge
   ```

   The `main-merge-commit-only` branch ruleset blocks the other merge
   methods, so merge-commits keep `develop`'s per-feature history as real
   ancestors of `main`.

### What happens automatically — do NOT tag manually

The merge to `main` is the whole release. **Never create or push a
`vX.Y.Z` tag by hand.** `.github/workflows/release-tauri.yml` runs a
`tag` job on every push to `main` that:

1. parses the version from `crates/token-dashboard-tauri/Cargo.toml`,
2. checks whether `vX.Y.Z` already exists on the remote, and
3. if not, creates and pushes the tag itself.

Pushing the tag sets `tagged=true`, which chains into the build matrix
(Windows `.msi`, macOS `.dmg`, Linux `.deb`/`.AppImage`), the GitHub
Release (`softprops/action-gh-release`, with generated notes), and the
winget + Homebrew tap updates.

If you pre-create the tag, the `tag` job finds it already present and
sets `tagged=false`. Because the main-push event's ref is
`refs/heads/main` (not a tag), the build jobs then refuse to run from
that workflow run — the release stalls. Let the workflow own the tag.

After the release run succeeds, the `sync-main-to-develop` workflow
merges `main` back into `develop` (the `chore(sync): merge main into
develop` commits), and `develop` pulls ahead again with the next PR.

### Verifying the local build before releasing

See [Build from source](#build-from-source) and
[Verifying changes](#verifying-changes) above — run the desktop shell
and confirm the version chip / `GET /api/health` reports `X.Y.Z` before
opening the release PR.

## Further reading

- [docs/DESIGN.md](DESIGN.md) — UI and data-model design notes.
- [docs/API_CONTRACT.md](API_CONTRACT.md) — `/api/*` surface reference.
- [docs/ROADMAP.md](ROADMAP.md) — what's planned next.
- [docs/PRODUCT.md](PRODUCT.md) — product scope and positioning.
- [docs/KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — current rough edges.
- [docs/inspiration.md](inspiration.md) — comparison with phuryn/claude-usage.
