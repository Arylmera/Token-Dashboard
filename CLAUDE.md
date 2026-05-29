# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**Token Dashboard** — a local desktop dashboard for tracking Claude Code token usage, costs, and session history. Reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and turns them into per-prompt cost analytics, tool/file heatmaps, subagent attribution, cache analytics, project comparisons, and a rule-based tips engine.

Inspired by [phuryn/claude-usage](https://github.com/phuryn/claude-usage) but diverges in UI (React 18 bundled with esbuild, dark theme, hash router, SSE refresh) and scope (expensive-prompt drill-down, skills view, tips engine, streaming-snapshot dedup). See `docs/inspiration.md` for the original's feature set.

## Status

**4.0 line — Rust + Tauri.** The 3.x Python + Electron stack is no longer in the tree; existing 3.x users keep their installed builds, future development targets v4 only. Workspace builds clean on `cargo build --workspace`; 62 tests across `core` + `cli`. Tauri shell verified on Windows; macOS and Linux QA happens via the release-tauri pipeline.

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

Claude Code writes one JSONL file per session to `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is a message record; usage fields live at `message.usage` and model identifier at `message.model`. The scanner (`crates/token-dashboard-core/src/scanner.rs`) is incremental — it tracks each file's mtime and byte offset in the `files` table and only reads new bytes on subsequent scans.

## Conventions

- **Fully local.** No telemetry, no remote calls for user data. Tests run offline. **Exception:** the user-initiated `POST /api/limits/sync` route makes one Anthropic API call with the user's saved key to read rate-limit headers; this is opt-in, never automatic, and disabled until the user saves a key in Settings.
- **rusqlite parameter binding always.** Any `format!()` in a SQL statement must interpolate only internal, caller-controlled values (column names, placeholder lists). User-reachable values go through `?` via `params!` or `params_from_iter`.
- **Streaming-snapshot dedup.** When adding scanner logic that joins the `messages` table, remember `(session_id, message_id)` is the dedup key, not `uuid`. See `scanner::evict_prior_snapshots` and the migration note in `db::migrate_add_message_id`.
- **Small files with clear responsibilities.** If a file grows past ~600 lines or accretes three distinct concerns, split it.

## Tauri build prereqs

The frontend bundle must exist at `frontend/dist/app.js` before `cargo run -p token-dashboard-tauri` or `cargo tauri build`. Run `cd frontend && npm install && npm run build` once. (Tauri's `beforeBuildCommand` hook is intentionally omitted: Tauri 2 picks `frontend_dir` by walking up from `tauri.conf.json` for a `package.json`; this repo has none at the workspace root, so the hook resolves outside the tree. CI's `release-tauri` workflow pre-builds the frontend explicitly.) The shell walks upward from the binary to find `frontend/index.html`; override with `TOKEN_DASHBOARD_STATIC` when bundling for distribution.

## Frontend cache (avoid re-reading hot files)

**`frontend/styles.css`** — single bundled stylesheet, do not split (esbuild order matters).
- Root scope: `.dir-a-root` (everything is namespaced under it). Glass-mode toggle: `.dir-a-root.is-glass`.
- Component classes: `.a-card`, `.a-kpi`, `.a-kpi-row`, `.a-strip`, `.a-strip-{left,mid,right}`, `.a-topbar`, `.a-table`, `.a-sticky-head`, `.a-glass-slider`, `.a-metric`, `.a-pre`.
- Theme tokens (CSS vars): `--bg`, `--panel`, `--panel-2`, `--iron-border`, `--iron-border-2`, `--bone`, `--gull`, `--gull-2`, `--accent`, `--accent-2`, `--good`, `--pos`, `--warn`, `--bad`, `--grid-dot`.
- Theme classes (14): `theme-paper`, `theme-forge`, `theme-forest`, `theme-dusk`, `theme-ocean`, `theme-linen`, `theme-matrix`, `theme-rose`, `theme-mint`, `theme-lilac`, `theme-bb-{dark,light}`, `theme-cyber-{dark,light}`. Defined as `.dir-a-root.theme-X { --bg:…; --panel:…; … }` blocks.

**`frontend/src/routes/overview.jsx`** — single Overview tab, ~387 lines, cohesive.
- Components (top→bottom): `KpiRow`, `ChartAxis`, `LimitWindow`, `BudgetBanner`, `PhaseSplitCard`, `LimitsCard`, `TopStrip`, `DailyCharts`, `ProjectsTable`, `ModelsCard`, `TopToolsCard`, `RecentSessions`, `Overview` (root).
- Helpers: `rangeDaysFromKey`, `toneFor`, `fmtResetIn`. Constants: `BUDGET_LABEL`, `PHASE_COLORS`, `MODEL_COLORS`.
- Data via `window.MOCK_DATA` (populated by `api-client.js`). Endpoints used: `/api/overview`, `/api/limits`, `/api/budget`, `/api/phase_split`.

## Customizing

Env vars (Tauri shell uses sensible defaults; the headless cli respects `PORT` + `HOST`):

| Variable                     | Default                              |
|------------------------------|--------------------------------------|
| `PORT`                       | `8080` (cli only — tauri picks free) |
| `HOST`                       | `127.0.0.1`                          |
| `TOKEN_DASHBOARD_DB`         | `~/.claude/token-dashboard.db`       |
| `CLAUDE_PROJECTS_DIR`        | `~/.claude/projects`                 |
| `TOKEN_DASHBOARD_PRICING`    | (embedded copy of `pricing.json`)    |
| `TOKEN_DASHBOARD_STATIC`     | (auto-detected, points at `frontend/`) |

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

For iterative frontend work, prefer `npm run dev` (esbuild `--watch` + sourcemap) over re-running `npm run build` on every change — it stays resident and rebuilds `dist/app.js` on save.

## Releasing

Branch model: **`develop`** is the working branch (always ahead); **`main`** is the released/stable branch (trails between releases). A release promotes develop→main — nothing else.

To release version `X.Y.Z`:

1. Bump the version in **4 spots** (keep in sync): `crates/token-dashboard-{core,cli,tauri}/Cargo.toml` and `crates/token-dashboard-tauri/tauri.conf.json`. (`Cargo.lock` is gitignored — only the 4 files commit.)
2. Commit on `develop`: `chore(release): bump version to X.Y.Z`, push.
3. Open a **`develop`→`main` PR** titled `Release vX.Y.Z`. Wait for CI green.
4. **Merge with a merge-commit** (not squash/rebase) — the `main-merge-commit-only` ruleset enforces this. `gh pr merge <n> --merge`.

**The merge IS the release. Never create or push a tag manually.** `.github/workflows/release-tauri.yml` has a `tag` job that fires on push to `main`, reads the version from `token-dashboard-tauri/Cargo.toml`, and auto-creates+pushes `vX.Y.Z` if it doesn't exist — which chains into the Win/macOS/Linux bundle builds, the GitHub Release, and winget/homebrew. Pre-tagging makes that job skip (`tagged=false`) and the main-push run won't build, so the release stalls. After it succeeds, `sync-main-to-develop` merges `main` back into `develop`.

Full walkthrough: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#releasing).
