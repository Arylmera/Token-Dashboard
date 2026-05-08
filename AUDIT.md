# Token Dashboard — Phase 1 Audit

Descriptive snapshot of the codebase as it exists on `main` (working tree
includes uncommitted refactor — the legacy `web/*.js` modules have been
deleted on disk and replaced by a single React 18 + Babel-standalone
front-end). No fixes are proposed here.

---

## 1. Repo inventory

Top-level layout (excluding `.git/`, `build/`, `__pycache__`):

```
token-dashboard/
├── .github/workflows/release.yml
├── build/token-dashboard/        (PyInstaller intermediate output)
├── docs/                          (empty in this checkout)
├── tests/                         (13 test files)
├── token_dashboard/               (Python package)
│   ├── db/                        (schema, queries, projects)
│   ├── server/                    (routes, sse, scan_loop, http_utils)
│   ├── web/                       (frontend: 4 files)
│   ├── scanner.py
│   ├── skills.py
│   ├── tips.py
│   ├── pricing.py
│   ├── reloader.py
│   ├── pricing.json
│   ├── __main__.py
│   └── __init__.py
├── cli.py                         (back-compat shim)
├── pyproject.toml
├── token-dashboard.spec           (PyInstaller)
├── run.bat / run.sh / run.command
├── VERSION
├── README.md / CLAUDE.md / CONTRIBUTING.md / DESIGN.md / DESIGN.json / PRODUCT.md / LICENSE
└── UsersguillAppDataLocalTemphourly.json   (junk — see §7)
```

Approximate counts (current working tree):

| Group        | Files | LOC (approx) |
| ------------ | ----- | ------------ |
| Python (pkg + cli) | 17 | ~2.3k |
| Tests        | 13 (12 `test_*.py` + `__init__.py`) | ~1.6k |
| Frontend (`web/`)  | 4 (`index.html`, `direction-a.jsx`, `data.js`, `a-styles.css`) | ~2.6k |
| Config / build | `pyproject.toml`, `token-dashboard.spec`, `pricing.json`, `VERSION`, `release.yml` | — |
| Docs         | `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `DESIGN.md`, `DESIGN.json`, `PRODUCT.md` | — |

Frontend collapsed from a multi-file `core/` + `routes/` + `charts/`
architecture (15+ JS files, including a 1 MB-ish `echarts.min.js`) to **one
JSX bundle** + a small data adapter. See §7 for the deletion list.

---

## 2. Backend (Python)

### Entry points

- [`cli.py`](cli.py) — 5-line shim that imports `token_dashboard.__main__:main`.
- [`token_dashboard/__main__.py`](token_dashboard/__main__.py) — argparse
  CLI. Subcommands:
  - `scan` → `cmd_scan` → `scan_dir(projects_dir, db_path)`; prints
    `files / messages / tools` counts.
  - `today` → `cmd_today` → `overview_totals` for today (UTC). Prints
    sessions/turns/in/out/cache.
  - `stats` → `cmd_stats` → all-time `overview_totals`.
  - `tips` → `cmd_tips` → prints `all_tips(db)`.
  - `dashboard` (default if no subcommand) → `cmd_dashboard` →
    `init_db`, optional `scan_dir`, then `token_dashboard.server.run(host,
    port, db, projects_dir)`. Flags: `--no-scan`, `--no-open`, `--reload`.
  - `--reload` re-execs itself as a child under `reloader.run_with_reload`.
- Stdout/stderr `None`-safety shim at top of `__main__.py` — needed when
  the PyInstaller windowed `.exe` runs detached from a console.
- Browser launch helper `_open_app_window(url)` probes Chrome/Edge/Brave
  paths per OS and launches with `--app=<url>` (Chromium app-window mode);
  falls back to `webbrowser.open`. Recently added (commit `0df3b97`,
  "windowed mode + app-window browser launch").

### Module map

| Module | Purpose |
| ------ | ------- |
| [`scanner.py`](token_dashboard/scanner.py) | Walks `~/.claude/projects/**/*.jsonl`, parses Claude Code transcript records, inserts `messages` + `tool_calls`, evicts prior streaming snapshots, persists per-file `(mtime, bytes_read)`. |
| [`db/schema.py`](token_dashboard/db/schema.py) | `SCHEMA` DDL string, `init_db`, `connect`, `default_db_path`, migration `_migrate_add_message_id`. |
| [`db/queries.py`](token_dashboard/db/queries.py) | All read-side aggregations (overview, prompts, projects, tools, sessions, daily, hourly, skills, by-model, session_turns). |
| [`db/projects.py`](token_dashboard/db/projects.py) | `best_project_name(cwds, slug)` / `project_name_for(...)` — derives a human-readable project name from cwd paths. |
| [`server/__init__.py`](token_dashboard/server/__init__.py) | Re-exports `EVENTS`, `build_handler`, `run`. |
| [`server/routes.py`](token_dashboard/server/routes.py) | `build_handler(db_path, projects_dir)` → returns a `BaseHTTPRequestHandler` subclass; `_api_*` per-endpoint functions; `GET_ROUTES` dispatch dict. |
| [`server/scan_loop.py`](token_dashboard/server/scan_loop.py) | `run(host, port, db, projects)` — starts a daemon thread polling `scan_dir` every `TOKEN_DASHBOARD_SCAN_INTERVAL` (default 5s, floor 0.5s) and emits SSE events; serves `http.server.ThreadingHTTPServer`. |
| [`server/sse.py`](token_dashboard/server/sse.py) | Module-level `queue.Queue` `EVENTS` and the `stream(handler)` long-poll loop (15s ping). |
| [`server/http_utils.py`](token_dashboard/server/http_utils.py) | `send_json`, `send_error_json`, `clamp_limit`, `serve_static`, `pricing_path`, `WEB_ROOT` (PyInstaller-aware via `sys._MEIPASS`). |
| [`tips.py`](token_dashboard/tips.py) | Rule-based tips engine (cache discipline, repeated targets, right-sizing, outliers) + `dismiss_tip` / `dismissed_tips` table. |
| [`skills.py`](token_dashboard/skills.py) | Reads installed skills from `~/.claude/skills/`, `~/.claude/scheduled-tasks/`, `~/.claude/plugins/`; `cached_catalog` for skill metadata. |
| [`pricing.py`](token_dashboard/pricing.py) | Loads `pricing.json`, computes `cost_for(model, usage, pricing)`, `get_plan` / `set_plan` (stored in `plan` table). |
| [`reloader.py`](token_dashboard/reloader.py) | Stdlib dev reloader: poll `**/*.py` and `**/*.json` mtimes every 0.5s, restart the child process. Sets `TOKEN_DASHBOARD_RELOAD_CHILD=1` to prevent recursion. |

### Server framework

- **stdlib `http.server.ThreadingHTTPServer` confirmed** — see
  `server/scan_loop.py`. No Flask, FastAPI, etc.
- Handler class is built fresh per `build_handler(db_path, projects_dir)`
  call; closes over `db_path`, `projects_dir`, and a `pricing` dict
  loaded once at startup.
- `do_GET` dispatches in this order: static `/` and `/index.html`,
  static `/web/*`, SSE `/api/stream`, on-demand `/api/scan`,
  parameterized `/api/sessions/<sid>`, then `GET_ROUTES` dict lookup.
- `do_POST` accepts `/api/plan` (sets active plan) and
  `/api/tips/dismiss` (writes to `dismissed_tips`); body capped at
  `MAX_POST_BYTES = 1_000_000`.
- `do_HEAD` aliases `do_GET`. `log_message` is silenced.
- Static-file serving in `serve_static` does a `Path.resolve()` jail
  check against `WEB_ROOT` to prevent path traversal.

### Scanner

- File watching = **mtime + byte-offset polling**. No filesystem
  notifications (`watchdog`/inotify). Driven by `scan_loop` every
  `TOKEN_DASHBOARD_SCAN_INTERVAL` seconds (default 5).
- Per-file row in `files` table: `path PRIMARY KEY, mtime, bytes_read,
  scanned_at`. On rescan: skip if `(mtime, size)` unchanged; otherwise
  read from `bytes_read` to current EOF.
- Reads bytes (not text lines) so a partially flushed final line is held
  back until the next scan (`end_offset` is the byte just after the last
  fully-parsed `\n`).
- **Dedup key for streaming snapshots: `(session_id, message_id)`**, not
  `uuid`. `_evict_prior_snapshots` deletes older rows in `messages` +
  `tool_calls` for the same `(session_id, message_id)` whenever a newer
  snapshot of the same assistant turn arrives.
- Tool-target field map (`_TARGET_FIELDS`) extracts a meaningful
  `target` for Read/Edit/Write/Glob/Grep/Bash/WebFetch/WebSearch/Task/Skill.

### DB

- SQLite, default path `~/.claude/token-dashboard.db` from
  `db.schema.default_db_path()`. Created with `path.parent.mkdir(parents=True, exist_ok=True)`.
- Tables: `files`, `messages`, `tool_calls`, `plan`, `dismissed_tips`.
- Indexes on `messages(session_id)`, `messages(project_slug)`,
  `messages(timestamp)`, `messages(model)`, `messages(session_id,
  message_id)`, and `tool_calls` by `session_id`/`tool_name`/`target`.
- One migration: `_migrate_add_message_id` — adds `messages.message_id`
  for the streaming-snapshot dedup; if applied, **wipes** `messages`,
  `tool_calls`, and `files` (rescan from disk is the recovery path).
- Query layer in [`db/queries.py`](token_dashboard/db/queries.py): 11
  public functions (`overview_totals`, `expensive_prompts`,
  `project_summary`, `tool_token_breakdown`, `recent_sessions`,
  `session_turns`, `daily_token_breakdown`, `hourly_breakdown`,
  `skill_breakdown`, `model_breakdown`). Internal `_range_clause(since,
  until, col)` injects column name only — caller-controlled.
- All user-reachable values bound via `?` placeholders. F-strings only
  used for column names and placeholder lists (per CLAUDE.md
  convention).

### Dependencies

- `pyproject.toml`: `dependencies = []` — **stdlib-only confirmed**.
  `requires-python = ">=3.8"`. Build backend `hatchling>=1.18`.
- The only third-party tool used in the workflow is PyInstaller, and
  only at build time.

### Launch / env vars

- `PORT` (default `8080`), `HOST` (default `127.0.0.1`) — read in
  `cmd_dashboard` only.
- `CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`).
- `TOKEN_DASHBOARD_DB` (default `~/.claude/token-dashboard.db`).
- `TOKEN_DASHBOARD_PRICING` — overrides packaged `pricing.json`.
- `TOKEN_DASHBOARD_SCAN_INTERVAL` (default `5.0`s, floor `0.5`s).
- `TOKEN_DASHBOARD_RELOAD_CHILD=1` — internal flag set by `reloader`
  for the child process.
- [`run.bat`](run.bat) — picks `py -3` then `python`; runs
  `cli.py dashboard --reload %*`. Pauses on error.
- [`run.sh`](run.sh) — picks `python3` then `python`; runs
  `cli.py dashboard "$@"` (no `--reload` here).
- [`run.command`](run.command) — one-liner that re-execs `run.sh`
  (macOS double-click target).

---

## 3. Frontend (`token_dashboard/web/`)

Files **actually present on disk** (the git status shows ~15 deleted
modules; only these four remain):

| File | Size | Notes |
| ---- | ---- | ----- |
| [`index.html`](token_dashboard/web/index.html) | ~1.6 KB | Loads React 18 UMD + Babel-standalone from unpkg, mounts JSX after `window.DATA_READY`. |
| [`direction-a.jsx`](token_dashboard/web/direction-a.jsx) | 995 lines | Single component file ("Direction A"). Wraps the whole app. |
| [`data.js`](token_dashboard/web/data.js) | ~11.3 KB | Real-data adapter. Fetches `/api/*` endpoints in one `Promise.all`, shapes them into the `MOCK_DATA` contract, exposes `window.DATA_READY` + `window.RELOAD_DATA`. |
| [`a-styles.css`](token_dashboard/web/a-styles.css) | ~1.5 KB metadata reports — actually multiple KB of CSS, dark theme with uppercase headings, 1px borders ("flat-surface" aesthetic per JSX comment). |

### React / Babel-standalone (confirmed)

`index.html` directly:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<script src="/web/data.js"></script>
<script type="text/babel" src="/web/direction-a.jsx" data-presets="env,react"></script>
```

No build step. Babel transpiles JSX in the browser at load time. **Note:
this requires network access to unpkg.com**.

### State management

- `useState` (15 occurrences) and `useEffect` (7) in
  `direction-a.jsx`. No Redux/Zustand/context.
- Top-level `DirectionA` component holds `tab`, `range`, etc. in local
  state.
- A `Proxy` wrapper `D` reads live from `window.MOCK_DATA` on every
  property access — that's how the SSE-driven re-render picks up new
  data without prop drilling.

### Data fetching (`data.js`)

`load()` does a single `Promise.all` over:
`/api/overview` (5 variants for today/yesterday/7d/30d/all-time and a
range variant), `/api/daily`, `/api/projects`, `/api/tools`,
`/api/sessions?limit=50`, `/api/skills`, `/api/by-model`,
`/api/prompts?limit=20&sort=tokens`, `/api/hourly?hours=24`,
`/api/tips`, `/api/plan`. Result is denormalized into
`window.MOCK_DATA = { totals, daily, projects, models, tools,
sessions, prompts, skills, tips, hourly, heatmap, burn, plan }`.

SSE subscription lives in `index.html` (not `data.js`):

```js
const es = new EventSource("/api/stream");
es.onmessage = async () => { await window.RELOAD_DATA(); render(); };
```

Every event triggers a full data reload + re-render. No diff/patch.

### Hash router

- `tabFromHash()` parses `window.location.hash` (`#/<slug>`).
- `useEffect` on `hashchange` updates `tab` state.
- Setter writes back to `window.location.hash` only when changed.
- Tabs: `overview`, `prompts`, `sessions`, `projects`, `skills`,
  `tips`, `settings` (7 — CLAUDE.md says "seven UI tabs", matches).

### Charts

- `<svg>` / `viewBox` appears in 6 places.
- `echarts` references: **0**.
- The deleted `web/echarts.min.js` and `web/charts/theme.js` confirm a
  prior ECharts integration that was removed.

### CSS

`a-styles.css` is the single stylesheet. Dark theme, hash routes
unstyled (rendering is tab-switch, not per-route page). Filename
prefix `a-` matches the "Direction A" naming in the JSX header.

---

## 4. Backend ↔ frontend communication

### HTTP endpoints

| Method | URL | Response shape |
| ------ | --- | -------------- |
| GET | `/` `/index.html` | static HTML |
| GET | `/web/<rel>` | static asset (jsx/js/css/etc.) |
| GET | `/api/overview?since&until` | `{sessions, turns, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, cost_usd}` |
| GET | `/api/prompts?limit&sort` | `[{prompt_text, model, tokens, cache_read_tokens, estimated_cost_usd, ...}]` (joins user prompt with following assistant turn) |
| GET | `/api/projects?since&until` | `[{project_slug, project_name, sessions, turns, input/output/cache_*_tokens, billable_tokens}]` |
| GET | `/api/tools?since&until` | `[{tool_name, target, count, sessions, result_tokens}]` |
| GET | `/api/sessions?limit&since&until` | `[{session_id, project_slug, project_name, first_prompt, started_at, turns, billable_tokens, cost_usd, ...}]` |
| GET | `/api/sessions/<session_id>` | per-turn breakdown for that session |
| GET | `/api/daily?since&until` | `[{date, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens}]` |
| GET | `/api/hourly?hours` | last `N` hours, oldest → newest, `[{cost_usd, billable_tokens}]` (server post-processes from `hourly_breakdown`) |
| GET | `/api/skills?since&until` | `[{skill, count, sessions, ...}]` |
| GET | `/api/by-model?since&until` | per-model token totals |
| GET | `/api/tips` | `[{key, category, scope, title, body, target, project_slug, count, sessions, ...}]` |
| GET | `/api/plan` | `{plan: "max" \| "api" \| ...}` |
| GET | `/api/scan` | triggers an immediate scan, returns `{files, messages, tools}` |
| GET | `/api/stream` | SSE (text/event-stream) |
| POST | `/api/plan` | `{plan: "..."}` → `{ok: true}` |
| POST | `/api/tips/dismiss` | `{key: "..."}` → `{ok: true}` |

All JSON responses send `Cache-Control: no-store`. POST body cap is 1 MB.

### SSE stream

- Endpoint: `GET /api/stream`. Headers `Content-Type: text/event-stream`,
  `Cache-Control: no-store`, `Connection: keep-alive`.
- Event format: `data: <json>\n\n`. No `event:` field — only the
  unnamed default event is used. `EventSource.onmessage` handles all.
- Payloads from `scan_loop`:
  - `{type: "scan", n: {files, messages, tools}, ts: <epoch>}` — only
    when `n.messages > 0`.
  - `{type: "error", message: "<str>"}` — on scanner exception.
- 15s keep-alive: comment frame `: ping\n\n` when the queue is empty.
- Frontend treats every event identically — full data refetch.

### Polling

- **Server side**: scanner thread polls `~/.claude/projects/` every
  `TOKEN_DASHBOARD_SCAN_INTERVAL` seconds (default 5).
- **Client side**: no polling. SSE-only refresh after the initial load.

---

## 5. Build / packaging / CI

### `.github/workflows/release.yml`

- Triggers: push to `main`, push to `v*` tag, PR to `main`,
  `workflow_dispatch`.
- `version` job reads `VERSION` and appends `${GITHUB_RUN_NUMBER}` →
  `version=<base>.<run>`, `tag=v<version>`.
- `build` matrix: `windows-latest` (x64), `macos-latest` (arm64),
  `ubuntu-22.04` (x64). Each: setup Python 3.12 → install pyinstaller
  → `python -m unittest discover tests` → `pyinstaller --clean
  --noconfirm token-dashboard.spec` → rename to
  `token-dashboard-<version>-<target>(.exe)?` → upload artifact.
- `release-tag` job: only on `refs/tags/v*` — downloads all artifacts
  and runs `softprops/action-gh-release@v2` with
  `generate_release_notes: true`. Auto-release on `main` was dropped
  in commit `5471455` (`ci: release only on v* tag push`).

### `pyproject.toml`

- Hatchling build. Wheel target package: `token_dashboard`.
- Sdist explicitly includes `tests`, `cli.py`, `run.sh`, `run.bat`,
  `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `LICENSE`, `docs`.
- `[project.scripts] token-dashboard = "token_dashboard.__main__:main"`.

### `token-dashboard.spec` (PyInstaller)

- Entry: `cli.py`.
- `datas`: `token_dashboard/web/` and `token_dashboard/pricing.json`
  bundled into the EXE.
- `hiddenimports` lists every submodule explicitly (PyInstaller's
  static analysis can't always find them through the dynamic
  `from token_dashboard.server import run` in `__main__.py`).
- `console=False` → windowed mode (no terminal pops up). Matches the
  recent commit `0df3b97` "windowed mode + app-window browser launch".
- `runtime_tmpdir=None`, `argv_emulation=False`, no codesign.

### `build/token-dashboard/`

PyInstaller intermediate output (not the final dist):
- `base_library.zip` (~1.4 MB), `PYZ-00.pyz` (~1.6 MB),
  `token-dashboard.pkg` (~8.9 MB),
  `Analysis-00.toc` / `EXE-00.toc` / `PKG-00.toc` / `PYZ-00.toc`,
  `xref-token-dashboard.html` (~289 KB), `warn-token-dashboard.txt`
  (~2 KB).
- `localpycs/` holds bootstrap modules (`pyimod01_archive` etc.).
- Final exe lives under `dist/` (gitignored, not present in checkout).

### Recent commits (relevant)

- `5471455 ci: release only on v* tag push (drop auto-release on main)`
- `0df3b97 feat(exe): windowed mode + app-window browser launch`
- `e90041f Merge pull request #11 from Arylmera/develop`
- `0587cc2 Merge pull request #10 from Arylmera/fix/exe-no-args-default-dashboard`
- `4dd09c7 fix(cli): default to dashboard when no subcommand given`

---

## 6. Tests

`tests/` contents (12 `test_*.py` files):

| File | Topic |
| ---- | ----- |
| `test_cli.py` | argparse CLI commands |
| `test_db.py` | schema init, migration |
| `test_end_to_end_totals.py` | fixture JSONL → scanner → query totals |
| `test_queries.py` | all `db/queries.py` aggregations |
| `test_scanner_dedup.py` | `(session_id, message_id)` snapshot eviction |
| `test_scanner_parse.py` | JSONL record parsing |
| `test_scanner_rescan.py` | mtime/byte-offset incremental rescan |
| `test_scanner_walk.py` | `scan_dir` filesystem walk |
| `test_server.py` | HTTP endpoints (likely uses `http.client` against `ThreadingHTTPServer`) |
| `test_skills.py` | skills catalog reader |
| `test_pricing.py` | `cost_for` / plan handling |
| `test_tips.py` | tips engine rules |

Run command: `python3 -m unittest discover tests` (CI uses
`python -m unittest discover tests`). CLAUDE.md states **68 tests**.

---

## 7. Pain points / observations

### Stale junk file at repo root

`UsersguillAppDataLocalTemphourly.json` (1100 bytes) is at the repo
root, untracked in git. The filename is `%LOCALAPPDATA%\Temp\hourly.json`
with backslashes stripped — a Windows path that was passed somewhere
expecting `/` separators and got created literally. Contents are an
array of `{cost_usd: 0.0, billable_tokens: 0}` (24 entries) — the
`/api/hourly` payload shape. **Likely a bug in something that wrote
the response to disk using the URL/path directly.** Should be deleted
and the writer found.

### Frontend deletion event (in working tree, not yet committed)

`git status` shows 15 deleted files under `token_dashboard/web/`
(staged):
```
app.js, charts.js, charts/theme.js, echarts.min.js, style.css,
core/{api,dom,format,router,settings,shell,states}.js,
routes/{overview,projects,prompts,sessions,settings,skills,tips}.js
```

Replaced by 2 new/modified files: `direction-a.jsx` (995 lines) and
`data.js` (the adapter). `index.html` and `a-styles.css` modified.
Git history also shows `web/routes/tools.js` and `token_dashboard/server.py`
were deleted earlier (server.py split into the `server/` package).

This is a major architectural pivot from a vanilla-JS module
architecture (with ECharts) to a single React+Babel-standalone JSX
file (with inline SVG charts). Tests that check static-file routes
may need to be re-checked, though `serve_static` is path-agnostic.

### Tight coupling to stdlib `http.server`

- Per-request handler closes over `db_path`, `projects_dir`, `pricing`
  via `build_handler` factory. Pricing is loaded **once at startup**
  and is not re-read if `pricing.json` changes.
- SSE `stream(handler)` writes directly to `handler.wfile` and uses a
  blocking `queue.Queue.get(timeout=15)`. Each SSE client occupies one
  thread for its entire lifetime (`ThreadingHTTPServer` spawns one
  thread per connection, no pool, no upper bound). With many clients
  this is unbounded thread growth; for a single local user it's fine.
- A single global `EVENTS` queue is shared across all SSE clients.
  Because `Queue.get` is destructive (FIFO consumer), if multiple
  clients are connected, **only one of them receives each event** —
  the others see only pings. For a desktop app with one window, this
  is invisible; for the planned Electron migration with potentially a
  tray + main window subscribing, this is a hazard.
- `do_HEAD = do_GET` returns a body (just suppresses log_message —
  there's no real HEAD handling).
- `log_message` overridden to silence stdout — no access logs.

### Hardcoded values that could be config

- `MAX_POST_BYTES = 1_000_000`, `MAX_LIMIT = 1000` in `http_utils.py`.
- `DEFAULT_SCAN_INTERVAL = 5.0`, floor `0.5` in `server/scan_loop.py`.
- `POLL_INTERVAL = 0.5` in `reloader.py`.
- Browser executable paths hardcoded in `__main__._open_app_window`.
- SSE keep-alive 15s hardcoded in `server/sse.py`.

### Network dependency at runtime (frontend)

`index.html` loads React + ReactDOM + Babel-standalone + Google Fonts
from unpkg/Google CDNs at every page load. No fallback. Offline use is
broken. PyInstaller bundles only the JSX/CSS/HTML — nothing CDN-based.

### Babel-standalone in production

Babel-standalone transpilation runs **on every page load in the
browser**. Significant JS download (~3 MB combined) and CPU. For
Electron, the natural move is a real bundler.

### Things that block / complicate Electron migration

1. **Frontend assumes `same-origin`** for `/api/*` and `/api/stream`.
   Electron's `file://` renderer can't hit relative URLs without a
   protocol handler or the Python server still running on a port.
2. **No port-conflict handling.** `cmd_dashboard` calls
   `httpd.serve_forever()` directly. If `8080` is taken, Python raises
   `OSError: [Errno 48] Address already in use` and the parent has no
   way to know unless it parses stderr.
3. **No "ready" signal.** The server prints `Token Dashboard listening
   on …` then enters `serve_forever()`. There is **no health
   endpoint** — Electron would need to poll `/api/overview` to detect
   readiness.
4. **Single global `EVENTS` queue** (above) — a tray app + dashboard
   window cannot both receive scan events.
5. **Pricing loaded once** — config edits require server restart.
6. **stdout/stderr None-shim** in `__main__.py` is a workaround for
   PyInstaller `console=False` mode and would also be needed under
   Electron's spawned child process.
7. **`_open_app_window`** opens a Chromium app window itself. Under
   Electron this code path is dead and should not run.
8. **Subprocess group / signal handling.** `reloader.py` uses
   `CREATE_NEW_PROCESS_GROUP` on Windows and `terminate()` elsewhere —
   reasonable, but Electron will spawn the Python child itself and
   manage shutdown. The `--reload` mode would need to be off in the
   packaged app.
9. **Tests for `test_server.py`** likely import the package and bind
   to a port; that's fine, but no mock-server pattern is established.

### Misc

- `docs/` directory is empty in this checkout (the
  `docs/superpowers/...` files referenced in older commits have been
  deleted).
- `DESIGN.md` (22 KB) and `DESIGN.json` (19 KB) at repo root are
  authored design artifacts (not generated). `PRODUCT.md` (3.7 KB)
  is the product brief.
- `cli.py` is a 5-line shim — could be removed if `pyproject.toml`
  is updated, but PyInstaller spec uses it.

---

## 8. Electron-migration readiness

- **Stable JSON contract for token data?** Mostly stable per endpoint,
  but ad-hoc shapes per response — no shared TS types, no schema file.
  `data.js` does the denormalization into a single `MOCK_DATA` shape;
  that contract is the de-facto API but lives only in JS.
- **Backend launchable as child process?** Yes — `python -m
  token_dashboard dashboard --no-open --no-scan` runs headless. **No
  ready signal, no health endpoint** — Electron must poll
  `/api/overview` or parse stdout for `"Token Dashboard listening"`.
- **Port-conflict handling?** None. `OSError` propagates and the
  process exits. Electron must catch nonzero exit and retry with a
  different `PORT=` env or pre-probe the port.
- **How would Electron find/spawn Python today?** No discovery code
  exists. `run.bat` / `run.sh` probe `py -3` then `python3` then
  `python` on `PATH` — Electron would replicate that, or bundle the
  PyInstaller binary (the spec already produces a single
  `token-dashboard(.exe)` that needs no Python on the host) and spawn
  that with `dashboard --no-open` instead of a Python interpreter.

---
