# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**Token Dashboard** — a local dashboard for tracking Claude Code token usage, costs, and session history. Reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and turns them into per-prompt cost analytics, tool/file heatmaps, subagent attribution, cache analytics, project comparisons, and a rule-based tips engine.

Inspired by [phuryn/claude-usage](https://github.com/phuryn/claude-usage) but diverges in UI (React 18 bundled with esbuild, dark theme, hash router, SSE refresh) and scope (expensive-prompt drill-down, skills view, tips engine, streaming-snapshot dedup). See `docs/inspiration.md` for the original's feature set and known limitations.

## Status

Working codebase. 68 Python unit tests (`python3 -m unittest discover tests`). Seven UI tabs wired up (Overview, Prompts, Sessions, Projects, Skills, Tips, Settings). Runs on macOS, Windows, and Linux.

## v4 Rust + Tauri rewrite (in progress)

A 4.0 rewrite is on the `v4-rust` branch. See [docs/V4_RUST_TAURI_PLAN.md](docs/V4_RUST_TAURI_PLAN.md). Workspace layout:

- `crates/token-dashboard-core/` — scanner, db, queries, pricing, preferences, tips, skills_catalog, anthropic_sync, sources.
- `crates/token-dashboard-cli/` — axum router + headless `token-dashboard` bin. Same `/api/*` surface python ships.
- `crates/token-dashboard-tauri/` — Tauri 2 desktop shell. Single process: links the cli as a library, picks a free port, opens a webview at the bound localhost URL.

The 3.x Python codebase below stays canonical until 4.0 reaches feature parity. **R6 invariant:** any commit that touches `token_dashboard/db/schema.py` `_migrate_*` must mirror the change into `crates/token-dashboard-core/src/db.rs`. The parity binary at `crates/token-dashboard-core/examples/parity.rs` is the CI gate.

**Tauri build prereqs:** the frontend bundle must exist at `frontend/dist/app.js` before `cargo run -p token-dashboard-tauri` (run `cd frontend && npm install && npm run build`). Tauri's `beforeBuildCommand` runs that on `cargo tauri build`. The shell auto-detects `frontend/index.html` walking up from the binary; override with `TOKEN_DASHBOARD_STATIC` when bundling for distribution.

## Architecture

- `cli.py` → `token_dashboard/scanner.py` → `~/.claude/token-dashboard.db` (SQLite)
- `token_dashboard/server/` exposes JSON APIs (`/api/*`) + SSE stream (`/api/stream`) + static frontend under `/web/`. Split into `routes.py` (dispatch + build_handler), `endpoints/{state,data,budget,sources,io}.py` (one endpoint per function), `sse.py`, `scan_loop.py`, and `http_utils.py`.
- `frontend/` is a React 18 app bundled by esbuild (`entry.jsx` → `dist/app.js`). Sources live under `frontend/src/`: `app.jsx` (shell + hash router), `routes/*.jsx` (one per tab; `settings.jsx` is the root that imports from `routes/settings/{atoms,theme-card,plan-card,badge-card,limits-card,budget-card,backup-card,sources-card,glass-card,misc-cards}.jsx`), `components/*.jsx` (atoms + charts), `api-client.js` (fetches `/api/*` into `window.MOCK_DATA`), plus `data-store.js`, `format.js`, `theme.js`, `clipboard.js`. Charts are inline SVG (no ECharts).
- `electron/main.js` is the orchestrator only. Backend lifecycle, window creation, tray + dock-badge controller, and the SSE refresh client live in `electron/src/{backend,window,tray,sse-client}.js`.

## Data source

Claude Code writes one JSONL file per session to `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is a message record; usage fields live at `message.usage` and model identifier at `message.model`. The scanner is incremental — it tracks each file's mtime and byte offset in the `files` table and only reads new bytes on subsequent scans.

## Conventions

- **Fully local.** No telemetry, no remote calls for user data. Tests run offline. **Exception:** the user-initiated `POST /api/limits/sync` route makes one Anthropic API call with the user's saved key to read rate-limit headers; this is opt-in, never automatic, and disabled until the user saves a key in Settings.
- **Stdlib only.** No `pip install`. If a new feature needs a third-party library, argue for it first — we're willing to pay ergonomics cost to keep install friction at zero.
- **SQLite parameter binding always.** Any f-string in a SQL statement must interpolate only internal, caller-controlled values (column names, placeholder lists). User-reachable values go through `?`.
- **Small files with clear responsibilities.** If a file grows past ~400 lines or accretes three distinct concerns, split it.
- **Streaming-snapshot dedup.** When adding scanner logic that joins the `messages` table, remember `(session_id, message_id)` is the dedup key, not `uuid`. See `scanner._evict_prior_snapshots` and the migration note in `db._migrate_add_message_id`.

## Frontend cache (avoid re-reading hot files)

**`frontend/styles.css`** — single bundled stylesheet, do not split (esbuild order matters).
- Root scope: `.dir-a-root` (everything is namespaced under it). Glass-mode toggle: `.dir-a-root.is-glass`.
- Component classes: `.a-card`, `.a-kpi`, `.a-kpi-row`, `.a-strip`, `.a-strip-{left,mid,right}`, `.a-topbar`, `.a-table`, `.a-sticky-head`, `.a-glass-slider`, `.a-metric`, `.a-pre`.
- Theme tokens (CSS vars): `--bg`, `--panel`, `--panel-2`, `--iron-border`, `--iron-border-2`, `--bone`, `--gull`, `--gull-2`, `--accent`, `--accent-2`, `--good`, `--pos`, `--warn`, `--bad`, `--grid-dot`.
- Theme classes (14): `theme-light`, `theme-forge`, `theme-forest`, `theme-dusk`, `theme-ocean`, `theme-linen`, `theme-matrix`, `theme-rose`, `theme-mint`, `theme-lilac`, `theme-bb-{dark,light}`, `theme-cyber-{dark,light}`. Defined as `.dir-a-root.theme-X { --bg:…; --panel:…; … }` blocks.

**`frontend/src/routes/overview.jsx`** — single Overview tab, ~387 lines, cohesive.
- Components (top→bottom): `KpiRow`, `ChartAxis`, `LimitWindow`, `BudgetBanner`, `PhaseSplitCard`, `LimitsCard`, `TopStrip`, `DailyCharts`, `ProjectsTable`, `ModelsCard`, `TopToolsCard`, `RecentSessions`, `Overview` (root).
- Helpers: `rangeDaysFromKey`, `toneFor`, `fmtResetIn`. Constants: `BUDGET_LABEL`, `PHASE_COLORS`, `MODEL_COLORS`.
- Data via `window.MOCK_DATA` (populated by `api-client.js`). Endpoints used: `/api/overview`, `/api/limits`, `/api/budget`, `/api/phase_split`.

## Customizing

Env vars: `PORT` (default 8080), `HOST` (default 127.0.0.1), `CLAUDE_PROJECTS_DIR`, `TOKEN_DASHBOARD_DB`. Pricing lives in `pricing.json`. See README.md § Environment variables for details.

## Known limitations

See `docs/KNOWN_LIMITATIONS.md`. Current summary: Skills `tokens_per_call` is populated only for skills installed under the three scanned roots (`~/.claude/skills/`, `~/.claude/scheduled-tasks/`, `~/.claude/plugins/`); project-local skills and subagent-dispatched skills show invocation counts but blank token counts.

## Verifying changes

```bash
python3 -m unittest discover tests        # all tests
python3 cli.py dashboard --no-open        # start the server
curl http://127.0.0.1:8080/api/overview   # sanity-check an endpoint
```
