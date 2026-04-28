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

Python 3 (stdlib only) for the CLI, scanner, and HTTP server. SQLite for the local cache. Vanilla JS + ECharts for the UI, no build step. Dark theme, hash-based router, server-sent events for live refresh.

Layout:

- `cli.py` / `token_dashboard/__main__.py` — argparse entrypoint.
- `token_dashboard/scanner.py` — incremental JSONL → SQLite ingest.
- `token_dashboard/db/` — schema, queries, project helpers.
- `token_dashboard/server/` — HTTP routes, SSE stream, background scan loop.
- `token_dashboard/web/` — frontend, split into `core/` (router, API client, formatters), `charts/` (ECharts theme), and `routes/` (one file per tab).
- `token_dashboard/pricing.json` — per-model and per-plan prices.

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
