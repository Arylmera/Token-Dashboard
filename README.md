# Token Dashboard

A local desktop app that reads the JSONL transcripts Claude Code writes
to `~/.claude/projects/` and turns them into per-prompt cost analytics,
tool/file heatmaps, subagent attribution, cache analytics, project
comparisons, and a rule-based tips engine.

**Everything runs locally.** No data leaves your machine — no telemetry,
no API calls for your data, no login. The one optional network call is
the user-initiated `Sync limits` button in Settings, which probes the
Anthropic Messages API to read rate-limit headers; it is opt-in and
disabled until you save an API key.

![Token Dashboard overview](docs/images/dashboard-wide.png)

## Status

This is the **v4 line** — a Rust + Tauri rewrite of the 3.x Python +
Electron app. The plan is in [docs/V4_RUST_TAURI_PLAN.md](docs/V4_RUST_TAURI_PLAN.md).

- **Backend**: Rust workspace at `crates/token-dashboard-{core,cli,tauri}`.
- **Frontend**: unchanged from 3.x — React 18 bundled with esbuild
  (`frontend/`).
- **Desktop shell**: Tauri 2 — single binary, no Chromium, ~5–10 MB
  installer instead of 150 MB.

The 3.x line lives on `develop`; if you want the published Electron app
today, see the [3.x release page](https://github.com/Arylmera/Token-Dashboard/releases).

## What it shows

- **Overview** — top-line totals + cost per day with stacked input /
  output / cache breakdown.
- **Prompts** — your most expensive user prompts joined to the
  assistant turn that followed.
- **Sessions** — recent sessions with cost, model, tags, and a
  drill-down per turn.
- **Projects** — per-project aggregation, with worktree-fold so a
  parent repo doesn't get split into N rows.
- **Skills** — invocation counts plus per-call context cost from
  `~/.claude/skills/`.
- **Tips** — rule-based suggestions: low cache hit rate, repeated
  file reads, Opus-on-tiny-turns, retry storms, oversized tool
  results.
- **Settings** — plan, budget caps, badge metric, glass mode, source
  attachment, pricing overrides.

Inspired by [phuryn/claude-usage](https://github.com/phuryn/claude-usage)
but diverges in UI (dark theme, hash router, SSE refresh) and scope
(expensive-prompt drill-down, skills view, tips engine,
streaming-snapshot dedup). See [docs/inspiration.md](docs/inspiration.md)
for the original's feature set and known limitations.

## Prerequisites

Pre-built artifacts ship for tagged releases (see § Install). To build
from source you need:

- **Rust 1.78+** — `winget install Rustlang.Rustup` on Windows;
  `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` on
  macOS/Linux.
- **Node.js 18+** — for the frontend bundle (esbuild). Already on most
  developer machines.
- **WebView2** — Windows 10+ ships it; Tauri uses it transparently.
- **webkit2gtk-4.1 + libappindicator** — Linux only. On Ubuntu /
  Debian: `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`.

## Install

Install paths are still being wired up for the v4 line; for now the
canonical path is build-from-source. Pre-built `.msi` / `.dmg` /
`.AppImage` will land alongside the first `v4.0.0` tag.

## Build from source

```bash
git clone https://github.com/Arylmera/Token-Dashboard
cd Token-Dashboard
git checkout v4-rust

# Frontend bundle (produces frontend/dist/app.js)
cd frontend && npm install && npm run build && cd ..

# Build the desktop shell (release artifact at
# crates/token-dashboard-tauri/target/release/token-dashboard-app)
cargo build --release -p token-dashboard-tauri
```

To produce a distributable installer:

```bash
cargo install tauri-cli@^2     # one-time
cargo tauri build              # picks .msi / .dmg / .AppImage per OS
```

## Run

The Tauri shell is the default user-facing entrypoint. Headless / CLI
use stays available:

```bash
# Desktop app — opens a window, owns a tray icon
cargo run --release -p token-dashboard-tauri

# Headless HTTP server only — point a browser at the bound URL
cargo run --release -p token-dashboard-cli
```

Both bin entrypoints respect the same env vars:

| Variable                     | Default                              |
|------------------------------|--------------------------------------|
| `PORT`                       | `8080` (cli only — tauri uses a free port) |
| `HOST`                       | `127.0.0.1`                          |
| `TOKEN_DASHBOARD_DB`         | `~/.claude/token-dashboard.db`       |
| `CLAUDE_PROJECTS_DIR`        | `~/.claude/projects`                 |
| `TOKEN_DASHBOARD_PRICING`    | (embedded copy of `pricing.json`)    |
| `TOKEN_DASHBOARD_STATIC`     | (auto-detected, points at `frontend/`) |

## Architecture

```
crates/
  token-dashboard-core/  scanner, db, queries, pricing, preferences,
                         tips, skills_catalog, anthropic_sync
  token-dashboard-cli/   axum router + bin (`token-dashboard`) — same
                         /api/* surface python ships
  token-dashboard-tauri/ Tauri 2 shell — embeds the cli router as a
                         library, picks a free port, opens a webview

frontend/                React 18 + esbuild (unchanged from 3.x)
docs/                    plan, inspiration, design, roadmap, etc.
electron/                LEGACY 3.x desktop shell — kept until cutover,
                         no longer wired into CI builds
token_dashboard/         LEGACY 3.x backend — same status
```

## Verifying changes

```bash
# Workspace tests (62 across core + cli)
cargo test --workspace

# Style + lint
cargo fmt --check
cargo clippy --all-targets --workspace -- -D warnings
```

## Known limitations

See [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md). Migration
notes specific to v4:

- **Skills `tokens_per_call`** is populated for skills installed under
  `~/.claude/{skills,scheduled-tasks,plugins}/`. Project-local and
  subagent-dispatched skills show invocation counts but blank token
  counts.
- **Attached-source ATTACH layer** is not yet wired into the read
  path — when no sources are attached, output is identical to 3.x;
  when a user attaches a second DB the totals will diverge until the
  ATTACH port lands.
- **Code signing** — releases are unsigned for now (matches the 3.x
  policy). Windows SmartScreen will warn on first launch; click *More
  info* → *Run anyway*. macOS will refuse to launch without
  `xattr -d com.apple.quarantine /Applications/Token\ Dashboard.app`
  the first time.

## macOS notes

The macOS build ships as a `.dmg` (drag-to-Applications). Vibrancy +
dock-badge integration are wired into the Tauri shell:

- **Vibrancy** — when `glass_enabled` is on (toggle in Settings), the
  window uses `NSVisualEffectMaterial::UnderWindowBackground` so the
  desktop wallpaper shows through a blurred panel.
- **Dock badge** — the value of `badge_metric` (Settings) is rendered
  on the dock tile every 5 seconds. Tokens render as `127k`-style
  short labels; cost renders as `$5.21`.
- **Minimum macOS** — 11.0 (Big Sur). Apple Silicon and Intel both work
  via the universal binary the release pipeline produces.

First launch: macOS refuses unsigned apps by default. Either run

```bash
xattr -d com.apple.quarantine /Applications/Token\ Dashboard.app
```

once after install, or right-click the app and choose *Open* to bypass
Gatekeeper for that single launch.

## License

MIT.
