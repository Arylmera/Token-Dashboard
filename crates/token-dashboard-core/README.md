# token-dashboard-core

Library for parsing and analyzing Claude Code session transcripts.

Claude Code writes one JSONL file per session to `~/.claude/projects/<slug>/<session-id>.jsonl`. Each line is a message record with `message.usage` (input/output/cache tokens) and `message.model`. This crate ingests those files into a local SQLite store and exposes typed queries for cost, usage, and session analytics.

This is the engine behind the [Token Dashboard](https://github.com/Arylmera/Token-Dashboard) desktop app. If you want the dashboard UI, install that. If you want to build your own tooling on top of Claude Code transcripts, depend on this crate.

## Install

```toml
[dependencies]
token-dashboard-core = "4"
```

The default `http` feature pulls `ureq` for the optional `anthropic_sync` module (queries the Anthropic API for live rate-limit headers). Disable if you only need the offline parser:

```toml
[dependencies]
token-dashboard-core = { version = "4", default-features = false }
```

## Usage

```rust
use token_dashboard_core::{open, default_db_path, scan_dir};

let db = open(&default_db_path()?)?;
let stats = scan_dir(&db, "~/.claude/projects")?;
println!("indexed {} new bytes across {} files", stats.bytes_read, stats.files_seen);
```

Modules:

- `scanner` — incremental JSONL ingestion (tracks per-file mtime + byte offset).
- `db` — SQLite schema, migrations, connection helpers.
- `queries` — typed read paths: overview, daily, models, tools, projects, sessions.
- `pricing` — cost computation against an embeddable `pricing.json`.
- `preferences` — user-tunable settings stored in the same db.
- `tips` — rule-based tips engine over recent activity.
- `skills_catalog` — Claude Code skill metadata.
- `sources` — discovers candidate transcript directories.
- `anthropic_sync` *(feature `http`)* — calls Anthropic's API to read rate-limit headers.

## Conventions

- **Fully local.** No telemetry. The only outbound request is the opt-in `anthropic_sync` call, gated behind the `http` feature *and* a user-supplied API key.
- **rusqlite parameter binding.** User-reachable values always go through `?` placeholders.
- **Streaming-snapshot dedup.** The `(session_id, message_id)` pair is the dedup key for incremental rescans.

## Stability

`4.0.x` follows semver: any breaking API change forces `5.0.0`. The internal database schema is migrated forward automatically; downgrades are not supported.

## License

MIT. See `LICENSE`.
