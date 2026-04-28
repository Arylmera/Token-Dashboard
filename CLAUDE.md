# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**Token Dashboard** — a local dashboard for tracking Claude Code token usage, costs, and session history. Reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and turns them into per-prompt cost analytics, tool/file heatmaps, subagent attribution, cache analytics, project comparisons, and a rule-based tips engine.

Inspired by [phuryn/claude-usage](https://github.com/phuryn/claude-usage) but diverges in UI (vanilla JS + ECharts, dark theme, hash router, SSE refresh) and scope (expensive-prompt drill-down, skills view, tips engine, streaming-snapshot dedup). See `docs/inspiration.md` for the original's feature set and known limitations.

## Status

Working codebase. 75 Node.js unit tests (`npm test`). Seven UI tabs wired up (Overview, Prompts, Sessions, Projects, Skills, Tips, Settings). Runs on macOS, Windows, and Linux. Requires Node.js 22.5+ (uses built-in `node:sqlite`, stable from Node 24).

## Architecture

- `cli.js` → `src/scanner.js` → `~/.claude/token-dashboard.db` (SQLite via `node:sqlite`)
- `src/server.js` exposes JSON APIs (`/api/*`) + SSE stream (`/api/stream`) + static frontend (`web/`)
- `web/` is vanilla JS, no build step — hash router + ECharts

## Data source

Claude Code writes one JSONL file per session to `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is a message record; usage fields live at `message.usage` and model identifier at `message.model`. The scanner is incremental — it tracks each file's mtime and byte offset in the `files` table and only reads new bytes on subsequent scans.

## Conventions

- **Fully local.** No telemetry, no remote calls for user data. Tests run offline.
- **Node built-ins only.** No `dependencies` in `package.json`. If a new feature needs a third-party library, argue for it first — we're willing to pay ergonomics cost to keep install friction at zero.
- **SQLite parameter binding always.** Any template literal embedded in a SQL string must interpolate only internal, caller-controlled values (column names, placeholder counts). User-reachable values go through `?`.
- **Small files with clear responsibilities.** If a file grows past ~400 lines or accretes three distinct concerns, split it.
- **Streaming-snapshot dedup.** When adding scanner logic that joins the `messages` table, remember `(session_id, message_id)` is the dedup key, not `uuid`. See `scanner.evictPriorSnapshots` and the migration note in `db.migrateAddMessageId`.
- **Plain JS + JSDoc, ES modules.** No TypeScript, no transpiler — `package.json` has `"type": "module"`.

## Customizing

Env vars: `PORT` (default 8080), `HOST` (default 127.0.0.1), `CLAUDE_PROJECTS_DIR`, `TOKEN_DASHBOARD_DB`, `TOKEN_DASHBOARD_SCAN_INTERVAL`. Pricing lives in `pricing.json`. See README.md § Environment variables for details.

## Known limitations

See `docs/KNOWN_LIMITATIONS.md`. Current summary: Skills `tokens_per_call` is populated only for skills installed under the three scanned roots (`~/.claude/skills/`, `~/.claude/scheduled-tasks/`, `~/.claude/plugins/`); project-local skills and subagent-dispatched skills show invocation counts but blank token counts.

## Verifying changes

```bash
npm test                                            # all tests via node --test
node --experimental-sqlite cli.js dashboard --no-open  # start the server
curl http://127.0.0.1:8080/api/overview             # sanity-check an endpoint
```
