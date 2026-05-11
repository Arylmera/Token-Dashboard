# Roadmap

Features that aren't built yet but are on the radar. PRs welcome — see
[CLAUDE.md](../CLAUDE.md) for the workspace conventions before
designing one.

## Closed

- **4.0 — Rust + Tauri rewrite.** Shipped. The python+Electron stack
  was removed in the cutover commit. Plan archived at
  [V4_RUST_TAURI_PLAN.md](V4_RUST_TAURI_PLAN.md) for historical
  reference.

## Open

### Attached-source ATTACH layer

The 3.x server unioned external SQLite sources into every read query
via ATTACH + UNION ALL views (`_setup_source_views`). The Rust port
ships the upload + toggle + delete endpoints but the read side reads
from `messages` / `tool_calls` directly. Wiring the views back in is
mechanical — port `_setup_source_views` to a `connect_for_reads`
helper in `crates/token-dashboard-core/src/db.rs` and route every
query in `queries.rs` through it.

Sized at **S**.

### `best_project_name` cwd-walking

`/api/projects` and `/api/sessions` currently surface
`project_name = project_slug` (the directory name under
`~/.claude/projects/`). The 3.x logic walked the captured `cwd`
column to find the nearest git-root basename, falling back to the
slug. Port the rule to a `core::projects::resolve_name(slugs, cwds)`
helper.

Sized at **S**.

### Session favorites / pinning

Sessions can be tagged today, but there's no first-class "favorite"
flag — useful for marking a few investigations worth coming back to.
Either add a dedicated `pinned INTEGER NOT NULL DEFAULT 0` column on
a new `session_meta` table, or reserve a `__pinned` tag in
`session_tags` and surface it in the Sessions tab as a sticky filter
+ row icon.

Sized at **S**.

### Conversation viewer

The expensive-prompts drilldown today shows cost and the first 240
chars of the user prompt. The next obvious step is a full replay
of the JSONL message thread — every user/assistant turn in order,
with tool calls and tool results expanded. Reads the same `messages`
table; needs a new `/api/sessions/:sid/transcript` endpoint and a
new route on the frontend.

Sized at **M**.

### Period-over-period comparison

Overview shows a single range. Adding a second card that compares
the current range against the prior equivalent window (week-over-
week, month-over-month) would surface cost trends at a glance.
Backend: one extra `/api/overview?since=…&until=…` call against
the shifted window. Frontend: a delta card next to the KPI row.

Sized at **S–M**.

### Budget-threshold OS notifications

The budget banner is visual-only. Tauri's notification plugin can
fire a native OS notification when the user crosses a percentage of
their saved daily/weekly budget. Requires a small notification
gate (don't re-fire on every scan) and a settings toggle.

Sized at **M**.

### Scheduled DB backups

The `/api/export.db` endpoint serves an instant SQLite blob, and
import is a one-shot upload. A scheduled rotating backup
(e.g. nightly snapshot to `~/.claude/token-dashboard-backups/`)
would protect against accidental DB corruption without the user
having to remember.

Sized at **S**.

### Multi-machine merge

**Goal.** A user with a laptop + a desktop sees one unified view.

**Why it's not trivial.**

1. **Schema drift.** Two `token-dashboard.db` files might have been
   migrated at different times. The merge tool needs an explicit
   version check + a migration path, not a blind `INSERT OR IGNORE`.
2. **Project identity.** The `project_slug` is derived from the
   JSONL directory name — `~/.claude/projects/-Users-alice-git-foo/`
   on the laptop vs `-Users-alice-Documents-foo/` on the desktop.
   A naive merge fragments the same project under two slugs.

**Recommended order:**

1. Capture `git_remote_url` (where available) in the `messages`
   table so projects can be unified across machines.
2. Add `cargo run -p token-dashboard-cli -- merge --from other.db`
   with a dry-run mode listing which sessions/projects land where.
3. Surface a one-click import in Settings.

Sized at **M–L** — the only feature with real schema-migration risk
in the current candidate set.

### Code signing

Releases are unsigned today. Windows SmartScreen warns; macOS refuses
to launch without `xattr -d com.apple.quarantine`. Adding signing
needs a Windows codesigning cert and an Apple Developer account, plus
secrets management in `release-tauri.yml`. Out of scope until there's
a clear user-volume justification.
