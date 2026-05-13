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

## Further reading

- [docs/DESIGN.md](DESIGN.md) — UI and data-model design notes.
- [docs/API_CONTRACT.md](API_CONTRACT.md) — `/api/*` surface reference.
- [docs/ROADMAP.md](ROADMAP.md) — what's planned next.
- [docs/PRODUCT.md](PRODUCT.md) — product scope and positioning.
- [docs/KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — current rough edges.
- [docs/inspiration.md](inspiration.md) — comparison with phuryn/claude-usage.
