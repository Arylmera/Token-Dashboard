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

- **Node.js 22.5 or newer** — install from https://nodejs.org/ (the LTS download is fine). On Windows: `winget install OpenJS.NodeJS`. On macOS: `brew install node`. The dashboard uses Node's built-in SQLite (`node:sqlite`), introduced in 22.5 and stable from 24.
- **Claude Code** — installed and with at least one session run. The dashboard reads those sessions. If you just installed Claude Code and haven't used it yet, run at least one prompt first.
- **A web browser.** Any modern one.

No `npm install`. No build step. Zero dependencies — only Node built-ins.

## Quickstart

```bash
git clone https://github.com/nateherkai/token-dashboard.git
cd token-dashboard
node --experimental-sqlite cli.js dashboard
```

(The `--experimental-sqlite` flag is a no-op on Node 24+ where `node:sqlite` is stable; harmless to keep.)

**One-click launchers** (after cloning):

| OS | Double-click |
|---|---|
| Windows | `run.bat` |
| macOS | `run.command` (first time: `chmod +x run.command run.sh`) |
| Linux | `run.sh` (first time: `chmod +x run.sh`) |

The command:
1. Scans `~/.claude/projects/` (first run can take 20–60 seconds on a heavy user's machine).
2. Starts a local server at http://127.0.0.1:8080.
3. Opens your default browser to that URL.

Leave it running; it re-scans every 5 seconds and pushes updates live (configurable via `TOKEN_DASHBOARD_SCAN_INTERVAL`). Stop with `Ctrl+C`.

## Where the data comes from

Claude Code writes one JSONL file per session here:

| OS | Path |
|---|---|
| macOS / Linux | `~/.claude/projects/<project-slug>/<session-id>.jsonl` |
| Windows | `C:\Users\<you>\.claude\projects\<project-slug>\<session-id>.jsonl` |

The dashboard never modifies those files — it only reads them and keeps a local SQLite cache at `~/.claude/token-dashboard.db`.

To point at a different location:

```bash
node --experimental-sqlite cli.js dashboard --projects-dir /path/to/projects --db /path/to/cache.db
```

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the local web server listens on |
| `HOST` | `127.0.0.1` | Bind address. Keep the default. Setting `0.0.0.0` exposes your entire prompt history to anyone on your local network — don't do this on any network you don't fully control (no coffee-shop Wi-Fi, no coworking spaces). |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to scan for session JSONL files |
| `TOKEN_DASHBOARD_DB` | `~/.claude/token-dashboard.db` | SQLite cache location |
| `TOKEN_DASHBOARD_SCAN_INTERVAL` | `5` | Seconds between background rescans of the JSONL files. Lower = fresher dashboard, more disk reads. Floor is `0.5`. |

Pricing lives in [`pricing.json`](pricing.json). Edit it directly if model prices change or to add a new plan.

## CLI reference

```bash
node --experimental-sqlite cli.js scan        # populate / refresh the local DB, then exit
node --experimental-sqlite cli.js today       # today's totals (terminal)
node --experimental-sqlite cli.js stats       # all-time totals (terminal)
node --experimental-sqlite cli.js tips        # active suggestions (terminal)
node --experimental-sqlite cli.js dashboard   # scan + serve the UI at http://localhost:8080

# dashboard flags
node --experimental-sqlite cli.js dashboard --no-open   # don't auto-open the browser
node --experimental-sqlite cli.js dashboard --no-scan   # skip the initial scan (use cached DB only)
```

Change the port: `PORT=9000 node --experimental-sqlite cli.js dashboard`.

For convenience, `npm run start`, `npm run scan`, and `npm test` are wired up in `package.json`.

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

**"No data" or empty charts.** Run `node --experimental-sqlite cli.js scan` once to populate the DB, then reload.

**Port 8080 already in use.** `PORT=9000 node --experimental-sqlite cli.js dashboard`.

**Numbers look wrong / stuck.** The DB lives at `~/.claude/token-dashboard.db`. Delete it and re-run `node --experimental-sqlite cli.js scan` to rebuild from scratch.

**Running the dashboard twice at the same time.** Don't — both processes will fight over the SQLite DB. Stop all instances before starting a new one.

## Accuracy note

Claude Code writes each assistant response 2–3 times to disk while it streams (the same API message gets snapshotted as output grows). The dashboard dedupes these by `message.id` so the final tally matches what the API actually billed. If you compare against another tool that sums every JSONL row, expect this dashboard's numbers to be lower — and closer to reality.

## Privacy

Nothing leaves your machine. No telemetry. No remote calls for your data. The browser fetches its JSON from `127.0.0.1`, and all JS/CSS/fonts are served from that same local server — ECharts is vendored into `web/`, and the UI falls back to system fonts rather than pulling from a font CDN. If you want to verify: `grep -r "https://" src/ web/` — you'll find nothing.

## Tech stack

Node.js 22.5+ (built-ins only — `node:sqlite`, `node:http`, `node:test`) for the CLI, scanner, and HTTP server. SQLite for the local cache. Vanilla JS + ECharts for the UI, no build step. Dark theme, hash-based router, server-sent events for live refresh.

Data flow: `cli.js` → `src/scanner.js` → SQLite DB; `src/server.js` exposes `/api/*` JSON routes and serves `web/`.

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — conventions and architecture overview (also picked up automatically by Claude Code)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to develop and test
- [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) — rough edges
- [`docs/inspiration.md`](docs/inspiration.md) — prior art and how this project diverges

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: fork, `npm test` before opening a PR, keep it dependency-free (Node built-ins only).

## License

[MIT](LICENSE).
