# Roadmap

Features that aren't built yet but are on the radar. PRs welcome — though see [CLAUDE.md](../CLAUDE.md) for the stdlib-only / fully-local conventions before designing one.

## 4.0 — Rust + Tauri rewrite

Long-term direction: rewrite the Python backend in Rust and replace the Electron shell with Tauri. Same SQLite schema, same React frontend, ~5–10 MB installer instead of ~150 MB, ~50 MB idle RAM instead of 200–400 MB, scanner ingest 5–20× faster. Phased plan with parity gates per phase. Full draft: [V4_RUST_TAURI_PLAN.md](V4_RUST_TAURI_PLAN.md).

## Multi-machine merge

**Goal.** A user with a laptop + a desktop sees one unified view across both machines.

**Why it's not trivial.** Two failure modes need design before code:

1. **Schema drift.** Two `token-dashboard.db` files might have been migrated at different times. The merge tool needs an explicit version check + a migration path, not a blind `INSERT OR IGNORE`.
2. **Project identity.** The `project_slug` is derived from the JSONL directory name — `~/.claude/projects/-Users-alice-git-foo/` on the laptop, `-Users-alice-Documents-foo/` on the desktop. A naive merge fragments the same project under two slugs. Either the merge tool unifies projects by content hash (CWD + git remote URL captured in the message rows), or the user maps slugs interactively.

**Two candidate approaches:**

- **DB merge.** `python3 cli.py merge --from other.db` re-keys on the existing `(session_id, message_id)` dedup key, unifies projects by `cwd` + `git_branch` heuristic, and preserves session_tags. Cleanest, but has migration risk.
- **JSONL tarball import.** User exports `~/.claude/projects/` as a tarball, imports into the second machine's `CLAUDE_PROJECTS_DIR`. Easier — punts both problems to the scanner — but doubles disk usage and doesn't resolve project-identity drift.

**Recommended order if you're picking this up:**
1. Capture `git_remote_url` (where available) in the `messages` table so projects can be unified across machines.
2. Implement `cli.py merge --from other.db` with a dry-run mode that lists which sessions/projects would land where.
3. Add a settings UI in the Electron app for one-click import.

Sized at **M–L** — the only feature with real schema-migration risk in the current candidate set.
