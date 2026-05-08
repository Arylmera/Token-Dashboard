# Token Dashboard

A local dashboard that reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and turns them into per-prompt cost analytics, tool/file heatmaps, subagent attribution, cache analytics, project comparisons, and a rule-based tips engine.

**Everything runs locally.** No data leaves your machine — no telemetry, no API calls for your data, no login.

![Overview tab — totals and daily charts](docs/images/dashboard-overview-top.jpg)

![Overview tab — per-project, per-model, top tools, recent sessions](docs/images/dashboard-overview-bottom.jpg)

## What this is useful for

- Seeing which of your prompts are expensive (surprise: they usually involve large tool results).
- Comparing token usage across projects you've worked on.
- Spotting wasteful patterns — the same file read twenty times in a session, a tool call returning 80k tokens.
- Understanding what a "cache hit" actually saves you.
- If you're on Pro or Max, confirming you're getting your money's worth in API-equivalent dollars.

## Prerequisites

- **Python 3.8 or newer** — already installed on macOS and most Linux. On Windows: `winget install Python.Python.3.12` or download from python.org.
- **Claude Code** — installed and with at least one session run. The dashboard reads those sessions. If you just installed Claude Code and haven't used it yet, run at least one prompt first.
- **A web browser.** Any modern one.

The package itself has zero runtime dependencies (Python stdlib only). No Node.js. No build step.

## Quickstart

### Option A — prebuilt binary (no Python needed)

Two flavors ship per release:

- **Standalone Python executable** — single PyInstaller bundle, run from the command line.
- **Electron desktop installer** — full desktop app with tray icon and dock badge.

Grab one for your OS from the [latest release](https://github.com/Arylmera/Token-Dashboard/releases/latest):

| OS | Standalone exe | Electron installer |
|---|---|---|
| Windows | `token-dashboard-<version>-windows-x64.exe` | `token-dashboard-<version>-windows-x64-*.exe` (NSIS) |
| macOS (Apple Silicon) | `token-dashboard-<version>-macos-arm64` | `token-dashboard-<version>-macos-arm64-*.dmg` |
| Linux x64 | `token-dashboard-<version>-linux-x64` | `token-dashboard-<version>-linux-x64-*.AppImage` |

Run the standalone executable:

```bash
# macOS / Linux
chmod +x token-dashboard-*
./token-dashboard-* dashboard

# Windows
token-dashboard-<version>-windows-x64.exe dashboard
```

The Electron installer drops a regular desktop app — launch it from Start Menu / Launchpad / your app launcher.

The standalone binary is a self-contained PyInstaller bundle (no Python on the host). The Electron installer wraps the same bundle inside a Chromium shell. Both are built in CI from the same source tree — see [`.github/workflows/release.yml`](.github/workflows/release.yml).

**Versioning.** [`VERSION`](VERSION) at the repo root holds `MAJOR.MINOR` (manual bump). Every merge to `main` reads it, computes the next free patch by counting existing `v<major>.<minor>.*` tags, builds, then tags + publishes a release as `v<major>.<minor>.<patch>`. Pushing a `v*` tag manually publishes that exact version. Pull requests and other branches build but do not publish.

### Option B — from source

```bash
git clone https://github.com/Arylmera/Token-Dashboard.git
cd Token-Dashboard
pip install .
token-dashboard dashboard
```

The command:
1. Scans `~/.claude/projects/` (first run can take 20–60 seconds on a heavy user's machine).
2. Starts a local server at http://127.0.0.1:8080.
3. Opens your default browser to that URL.

Leave it running; it re-scans every 5 seconds and pushes updates live over SSE. There's also a manual refresh button in the header for when you want to force one immediately. Stop with `Ctrl+C`.

> On Windows, if `python` isn't on your PATH, use `py -3 -m pip install .` instead of `pip install .`.

### Without installing (run from the source tree)

If you'd rather not install the package — useful when hacking on the code:

```bash
python3 cli.py dashboard            # equivalent to `token-dashboard dashboard`
python3 -m token_dashboard dashboard # also equivalent
```

Every `token-dashboard <subcmd>` example below works as `python3 cli.py <subcmd>` too.

### One-click launchers

| OS | Double-click |
|---|---|
| Windows | `run.bat` |
| macOS | `run.command` (first time: `chmod +x run.command run.sh`) |
| Linux | `run.sh` (first time: `chmod +x run.sh`) |

## Desktop app (Electron)

A native-feeling desktop wrapper lives under [`electron/`](electron/). It
spawns the same Python backend, opens a frameless window, and surfaces today's
billable-token count in the OS shell (Windows taskbar overlay icon, macOS
menu-bar tray title + dock badge).

### Dev workflow

```bash
# 1. Build the React bundle (esbuild, ~150 ms)
cd frontend
npm install
npm run build         # or `npm run dev` for watch mode

# 2. Run the Electron shell
cd ../electron
npm install
npm run dev
```

The Electron main process probes a free TCP port, spawns
`python -m token_dashboard dashboard --no-open --no-scan` with `PORT=<n>`,
parses the `TOKEN_DASHBOARD_READY {…}` line on stdout, and opens a
`BrowserWindow` at the bound URL. Multiple SSE clients (main window + tray)
each get their own event stream.

### Production build

```bash
# Optional: regenerate the placeholder app icon
python electron/scripts/gen-icon.py

# Stage the PyInstaller exe under dist-py/ for electron-builder
python electron/scripts/prepare-py.py

# Build the Electron installer
cd electron
npm run build              # current OS
npm run build:win          # Windows NSIS
npm run build:mac          # macOS DMG
npm run build:linux        # Linux AppImage
```

`prepare-py` runs PyInstaller using [`token-dashboard.spec`](token-dashboard.spec)
and copies the result to `dist-py/`; electron-builder ships `dist-py/` under
`<resources>/py/` and the main process picks it up automatically when
`app.isPackaged` is true.

### Layout

| Dir | Contents |
| --- | -------- |
| [`token_dashboard/`](token_dashboard/) | Python backend (scanner + SQLite + stdlib HTTP server + tips engine) |
| [`frontend/`](frontend/) | React 18 frontend, esbuild-bundled, vendored fonts |
| [`electron/`](electron/) | Electron main + preload + electron-builder config |
| [`shared/`](shared/) | JSON Schema + format helpers used by both sides |
| [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) | Backend HTTP/SSE contract |

## Where the data comes from

Claude Code writes one JSONL file per session here:

| OS | Path |
|---|---|
| macOS / Linux | `~/.claude/projects/<project-slug>/<session-id>.jsonl` |
| Windows | `C:\Users\<you>\.claude\projects\<project-slug>\<session-id>.jsonl` |

The dashboard never modifies those files — it only reads them and keeps a local SQLite cache at `~/.claude/token-dashboard.db`.

To point at a different location:

```bash
token-dashboard dashboard --projects-dir /path/to/projects --db /path/to/cache.db
```

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the local web server listens on |
| `HOST` | `127.0.0.1` | Bind address. Keep the default. Setting `0.0.0.0` exposes your entire prompt history to anyone on your local network — don't do this on any network you don't fully control (no coffee-shop Wi-Fi, no coworking spaces). |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to scan for session JSONL files |
| `TOKEN_DASHBOARD_DB` | `~/.claude/token-dashboard.db` | SQLite cache location |
| `TOKEN_DASHBOARD_SCAN_INTERVAL` | `5` | Seconds between background rescans of the JSONL files. Lower = fresher dashboard, more disk reads. Floor is `0.5`. |

Pricing lives in [`token_dashboard/pricing.json`](token_dashboard/pricing.json). Edit it directly if model prices change or to add a new plan.

## CLI reference

```bash
token-dashboard scan          # populate / refresh the local DB, then exit
token-dashboard today         # today's totals (terminal)
token-dashboard stats         # all-time totals (terminal)
token-dashboard tips          # active suggestions (terminal)
token-dashboard dashboard     # scan + serve the UI at http://localhost:8080

# dashboard flags
token-dashboard dashboard --no-open   # don't auto-open the browser
token-dashboard dashboard --no-scan   # skip the initial scan (use cached DB only)
```

Change the port: `PORT=9000 token-dashboard dashboard`.

## The 7 tabs

The dashboard is a single page with a hash-router tab bar across the top. Each tab is backed by its own JSON API under `/api/`:

- **Overview** — all-time input/output/cache tokens, sessions, turns, estimated cost on your chosen plan, daily work and cache-read charts, tokens-by-project, token share by model, top tools by call count, and recent sessions. This is the landing tab.
- **Prompts** — your most expensive user prompts ranked by tokens. Click any row to see the assistant response, tool calls made, and the size of each tool result.
- **Sessions** — turn-by-turn view of any single session, with per-turn tokens and tool calls.
- **Projects** — per-project comparison: tokens, session counts, and which files were touched most.
- **Skills** — which skills you invoke most often, and (where we can measure them) their token cost. See [limitations](docs/KNOWN_LIMITATIONS.md#skills-token-counts-are-partial).
- **Tips** — rule-based suggestions for reducing token usage (repeated file reads, oversized tool results, low cache-hit rate, etc.).
- **Settings** — switch pricing between API / Pro / Max / Max-20x so cost figures everywhere else reflect your actual plan.

The Overview tab also has a built-in "What do these numbers mean?" panel that explains input/output/cache tokens in plain English.

## Troubleshooting

**"No data" or empty charts.** Run `token-dashboard scan` once to populate the DB, then reload.

**Port 8080 already in use.** `PORT=9000 token-dashboard dashboard`.

**Numbers look wrong / stuck.** The DB lives at `~/.claude/token-dashboard.db`. Delete it and re-run `token-dashboard scan` to rebuild from scratch.

**Running the dashboard twice at the same time.** Don't — both processes will fight over the SQLite DB. Stop all instances before starting a new one.

## Accuracy note

Claude Code writes each assistant response 2–3 times to disk while it streams (the same API message gets snapshotted as output grows). The dashboard dedupes these by `message.id` so the final tally matches what the API actually billed. If you compare against another tool that sums every JSONL row, expect this dashboard's numbers to be lower — and closer to reality.

## Privacy

Nothing leaves your machine. No telemetry. No remote calls for your data. The browser fetches its JSON from `127.0.0.1`, and all JS/CSS/fonts are served from that same local server — ECharts is vendored into `token_dashboard/web/`, and the UI falls back to system fonts rather than pulling from a font CDN. If you want to verify: `grep -r "https://" token_dashboard/` — you'll find nothing.

## Tech stack

Python 3 (stdlib only) for the CLI, scanner, and HTTP server. SQLite for the local cache. React 18 + inline-SVG charts for the UI, bundled with esbuild. Dark theme, hash-based router, server-sent events for live refresh. An optional Electron shell wraps the backend into a desktop app.

Layout:

- `cli.py` / `token_dashboard/__main__.py` — argparse entrypoint.
- `token_dashboard/scanner.py` — incremental JSONL → SQLite ingest.
- `token_dashboard/skills.py` — skill discovery + token measurement across `~/.claude/skills/`, `~/.claude/scheduled-tasks/`, `~/.claude/plugins/`.
- `token_dashboard/tips.py` — rule-based suggestions engine.
- `token_dashboard/pricing.py` / `pricing.json` — per-model and per-plan price tables.
- `token_dashboard/reloader.py` — dev auto-reload helper.
- `token_dashboard/db/` — `schema.py` (DDL + migrations), `queries.py` (read paths), `projects.py` (project-slug helpers).
- `token_dashboard/server/` — `routes.py` (HTTP routes), `sse.py` (server-sent events), `scan_loop.py` (background rescan), `http_utils.py` (shared helpers).
- `frontend/` — React 18 app bundled with esbuild (`entry.jsx` → `dist/app.js`). Sources live in `frontend/src/`: `app.jsx` (shell + hash router), `routes/*.jsx` (one per tab), `components/*.jsx` (atoms + charts), `api-client.js` (fetches `/api/*` and shapes `MOCK_DATA`), `data-store.js`, `format.js`, `theme.js`, `clipboard.js`. Stylesheet is `styles.css`; charts are inline SVG.
- `electron/` — Electron desktop shell. `main.js` orchestrates; `src/` splits backend lifecycle, window, tray + dock badge, and SSE refresh into focused modules.
- `token-dashboard.spec` — PyInstaller spec for the prebuilt binaries.
- `.github/workflows/release.yml` — CI builds Windows / macOS-arm64 / Linux-x64 standalone executables and Electron installers on every push to `main`, auto-tags the next `v<major>.<minor>.<patch>` from [`VERSION`](VERSION), and publishes a GitHub Release.

Data flow: `token-dashboard` → `scanner.scan_dir` → SQLite at `~/.claude/token-dashboard.db`; `token_dashboard.server.run` exposes `/api/*` JSON routes and serves the static frontend.

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — conventions and architecture overview (also picked up automatically by Claude Code)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to develop and test
- [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) — rough edges
- [`docs/inspiration.md`](docs/inspiration.md) — prior art and how this project diverges

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: fork, `python3 -m unittest discover tests` before opening a PR, keep it stdlib-only.

## License

[MIT](LICENSE).
