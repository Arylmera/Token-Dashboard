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

### `first_prompt` in `recent_sessions`

`/api/export.csv` and the Sessions tab both have a `first_prompt`
column that's empty for the rust port — `recent_sessions` skips the
per-session sub-query the python helper used. Add it to
`crates/token-dashboard-core/src/queries.rs::recent_sessions`.

Sized at **XS**.

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
