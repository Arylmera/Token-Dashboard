# Token Dashboard — Backend API Contract

Stable JSON shapes the frontend (and any future client — Electron host, OS-shell
tray, etc.) can rely on. Source of truth for Phase 2+ decoupling.

All responses send `Cache-Control: no-store` and `Content-Type: application/json`
unless noted. Errors have shape `{"error": "<msg>"}` with appropriate status code.

## Lifecycle

### Ready signal (stdout)

When the listening socket is bound, the server prints exactly one line:

```
TOKEN_DASHBOARD_READY {"url":"http://127.0.0.1:8080/","host":"127.0.0.1","port":8080,"pid":12345,"db":"...","projects_dir":"...","ts":1730000000.0}
```

Parent processes (Electron, supervisors) should grep for the literal token
`TOKEN_DASHBOARD_READY` at line start. Everything before that token is
not part of the ready protocol; everything after the token (after one space)
is JSON.

### Health probe

`GET /api/health` → `200 OK`

```json
{
  "ok": true,
  "version": "1.0.0",
  "started_at": 1730000000.0,
  "uptime_s": 12.34,
  "now": 1730000012.34,
  "scan_interval_s": 5.0,
  "projects_dir": "/Users/.../.claude/projects",
  "db": "/Users/.../.claude/token-dashboard.db",
  "sse_clients": 1
}
```

Cheap. Use as the readiness poll target. Returns 200 as soon as the handler
is wired up; `started_at` is `null` until the listening socket is bound.

### Port conflicts

If the configured port is already in use the server prints to stderr:

```
Token Dashboard: port 8080 on 127.0.0.1 is already in use. Set PORT=<free port> and retry.
```

…and exits with status code `2`. Parent processes should treat exit-2 as a
recoverable signal (probe a free port and respawn with `PORT=<n>` env).

## SSE stream

`GET /api/stream` → `text/event-stream`

- Per-client queue (bounded, `64` events). Slow clients drop oldest event,
  not newest. Multiple concurrent subscribers each get their own copy of
  every event.
- Keep-alive `: ping\n\n` comment frame every 15s by default.
  Override with `TOKEN_DASHBOARD_SSE_KEEPALIVE=<seconds>`.
- Default (unnamed) event only. `EventSource.onmessage` handles all.

Event payloads:

```json
{"type": "scan", "n": {"files": 12, "messages": 34, "tools": 56}, "ts": 1730000000.0}
{"type": "error", "message": "<exception text>"}
```

Frontends should treat any event as "refetch all `/api/*` endpoints and re-render".

## Read endpoints

| Method | URL | Notes |
| ------ | --- | ----- |
| GET | `/api/overview?since&until` | totals + cost_usd |
| GET | `/api/prompts?limit&sort` | top expensive prompts |
| GET | `/api/projects?since&until` | per-project rollup |
| GET | `/api/tools?since&until` | tool-call rollup |
| GET | `/api/sessions?limit&since&until` | recent sessions |
| GET | `/api/sessions/<session_id>` | per-turn breakdown |
| GET | `/api/daily?since&until` | daily token series (rows include `cost_usd`) |
| GET | `/api/day?date=YYYY-MM-DD` | bundled single-day detail |
| GET | `/api/hourly?hours=N` | last N hours, oldest→newest, length N |
| GET | `/api/skills?since&until` | skill invocation rollup |
| GET | `/api/by-model?since&until` | per-model breakdown |
| GET | `/api/tips` | active tips |
| GET | `/api/plan` | `{plan, pricing}` |
| GET | `/api/scan` | trigger immediate scan, returns `{files, messages, tools}` |
| GET | `/api/health` | readiness/liveness probe |
| GET | `/api/stream` | SSE — see above |

`since` / `until` are ISO 8601 timestamps. Both optional; omit for all-time.

`limit` is clamped to `[1, MAX_LIMIT]` (default `1000`, override
`TOKEN_DASHBOARD_MAX_LIMIT`).

## Write endpoints

| Method | URL | Body | Response |
| ------ | --- | ---- | -------- |
| POST | `/api/plan` | `{"plan": "max" \| "api" \| ...}` | `{"ok": true}` |
| POST | `/api/tips/dismiss` | `{"key": "<tip key>"}` | `{"ok": true}` |

POST body cap: `MAX_POST_BYTES` (default `1_000_000`, override
`TOKEN_DASHBOARD_MAX_POST_BYTES`). `Content-Type` is parsed as JSON
regardless of the request header.

## Pricing hot-reload

`pricing.json` is reread when its mtime changes. No server restart needed.
Override the path with `TOKEN_DASHBOARD_PRICING=/abs/path/to/pricing.json`.

## Environment variables

| Var | Default | Purpose |
| --- | ------- | ------- |
| `HOST` | `127.0.0.1` | bind address |
| `PORT` | `8080` | bind port |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | JSONL transcript root |
| `TOKEN_DASHBOARD_DB` | `~/.claude/token-dashboard.db` | SQLite path |
| `TOKEN_DASHBOARD_PRICING` | bundled `pricing.json` | pricing override |
| `TOKEN_DASHBOARD_SCAN_INTERVAL` | `5.0` | scan loop interval (floor `0.5`) |
| `TOKEN_DASHBOARD_SSE_KEEPALIVE` | `15.0` | SSE ping interval |
| `TOKEN_DASHBOARD_MAX_POST_BYTES` | `1000000` | POST body cap |
| `TOKEN_DASHBOARD_MAX_LIMIT` | `1000` | upper bound for `?limit=` |
| `TOKEN_DASHBOARD_RELOAD_CHILD` | (unset) | internal — set by `--reload` reloader |
