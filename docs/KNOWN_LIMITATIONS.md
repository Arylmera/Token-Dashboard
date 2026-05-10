# Known Limitations

None of these are blockers — the dashboard still gives you useful
information. They're the rough edges you'll notice if you look hard.

## Skills token counts are partial

The Skills route shows every skill Claude Code invoked, how many times,
across how many sessions, and when. The **est. tokens** column is
populated only for skills whose `SKILL.md` lives under
`~/.claude/skills/`, `~/.claude/scheduled-tasks/`, or
`~/.claude/plugins/`. Skills registered elsewhere (project-local
`.claude/skills/`, or invocations that go through the `Task` tool with
a skill-shaped `subagent_type`) show invocation counts but leave the
estimates blank. The catalog scan walks all three roots once per
minute (`crates/token-dashboard-core/src/skills_catalog.rs`).

## Cost for Pro / Max users is API-equivalent, not subscription value

Settings lets you select your pricing plan, but the Overview cost
number is always the API-equivalent (what the same usage would have
cost on pay-per-token rates). If you're on Pro you pay a flat
$20/month regardless of how much of that API-equivalent number you
rack up. There's no "subscription ROI" math — Anthropic doesn't
publish per-plan rate limits as public JSON, and faking it would be
worse than not doing it.

## Cowork sessions are invisible

Cowork mode runs server-side. Those sessions don't write JSONL to
`~/.claude/projects/` and the dashboard can't see them.

## Non-standard model names get tier-fallback pricing

If a transcript references a model ID not in `pricing.json` (e.g. a
future snapshot that isn't in our table yet), cost is estimated from
the tier substring (`opus` / `sonnet` / `haiku`) in the name. The UI
marks these as `estimated: true`. If the model name contains none of
those substrings, cost is reported as null.

## First scan can be slow

The first scan on a heavy user's machine reads tens of MB across
hundreds of JSONLs. Subsequent scans are incremental (mtime +
byte-offset tracking in the `files` table), so they're fast.

## Running two dashboards against the same DB

Both will fight over the SQLite file and produce inconsistent numbers
plus occasional `database is locked` errors. Only run one at a time.
To view from a second device, run the headless cli with
`HOST=0.0.0.0 PORT=8080 cargo run -p token-dashboard-cli` and point the
second device's browser at it.

## webkit2gtk SSE drops on Linux

webkit2gtk has a documented history of dropping idle long-poll
connections. The frontend's `api-client.js` includes a 90-second
first-frame watchdog and a 3-failure consecutive-reconnect counter
that switches the page into a 15-second polling loop instead. Once
polling is active it stays active for that page session — flapping
between modes would be worse. A manual reload reverts to SSE.

## Attached-source ATTACH layer not yet wired

The 3.x server unioned attached external SQLite sources into every
read query via SQLite ATTACH + UNION ALL views. The Rust port reads
from `messages` / `tool_calls` directly. When no sources are attached
the output is identical (the python view was a passthrough); when a
user attaches a second DB, totals will only reflect the local DB
until the ATTACH layer ports.

## first_prompt is empty in CSV exports

`/api/export.csv` includes a `first_prompt` column that's always empty
in the v4 build — `recent_sessions` doesn't run the per-session
sub-query that populates it yet. Visible session rows in the Sessions
tab still show first prompts (they come from
`/api/sessions?...&order=recent` which has its own enrichment path).

## project_name reuses project_slug

Projects routes show `project_name` equal to the JSONL directory slug
(`C--work-foo`, etc.) rather than a friendly repo name. The cwd-walking
that derived friendlier names in 3.x is a Phase 2 follow-up. The slug
is still informative — it's the directory under
`~/.claude/projects/`.
