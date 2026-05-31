//! SQLite schema, migrations, and connection helpers.
//!
//! Mirrors `token_dashboard/db/schema.py` byte-for-byte at the SQL level so
//! 3.x → 4.0 is a binary swap, not a data migration. The `_migrate_*`
//! functions match the Python ones in name and effect: any new schema work
//! must land in both files (CLAUDE.md `needs-rust-port` invariant, R6).
//!
//! Phase 1 deliberately omits the `_setup_source_views` ATTACH layer from
//! schema.py — it's a read-side concern and lands with the endpoint port
//! in Phase 2.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  mtime       REAL    NOT NULL,
  bytes_read  INTEGER NOT NULL,
  scanned_at  REAL    NOT NULL,
  provider    TEXT    NOT NULL DEFAULT 'claude'
);

CREATE TABLE IF NOT EXISTS messages (
  uuid                    TEXT PRIMARY KEY,
  parent_uuid             TEXT,
  session_id              TEXT NOT NULL,
  project_slug            TEXT NOT NULL,
  cwd                     TEXT,
  git_branch              TEXT,
  cc_version              TEXT,
  entrypoint              TEXT,
  type                    TEXT NOT NULL,
  is_sidechain            INTEGER NOT NULL DEFAULT 0,
  agent_id                TEXT,
  timestamp               TEXT NOT NULL,
  model                   TEXT,
  stop_reason             TEXT,
  prompt_id               TEXT,
  message_id              TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  prompt_text             TEXT,
  prompt_chars            INTEGER,
  tool_calls_json         TEXT,
  provider                TEXT    NOT NULL DEFAULT 'claude'
);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project_slug);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_msgid     ON messages(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread    ON messages(session_id, type, is_sidechain, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_provider  ON messages(provider);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  project_slug  TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target        TEXT,
  use_id        TEXT,
  result_tokens INTEGER,
  is_error      INTEGER NOT NULL DEFAULT 0,
  timestamp     TEXT    NOT NULL,
  provider      TEXT    NOT NULL DEFAULT 'claude'
);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_target  ON tool_calls(target);
CREATE INDEX IF NOT EXISTS idx_tools_use_id  ON tool_calls(session_id, use_id);

CREATE TABLE IF NOT EXISTS plan (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dismissed_tips (
  tip_key       TEXT PRIMARY KEY,
  dismissed_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  REAL NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

-- Records every (session, tag) the auto-tagger has applied at least once
-- so that if the user later removes the tag, the next scan doesn't
-- re-apply it. Independent of session_tags so the user-facing state stays
-- authoritative.
CREATE TABLE IF NOT EXISTS session_auto_tag_log (
  session_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  applied_at  REAL NOT NULL,
  PRIMARY KEY (session_id, tag)
);

CREATE TABLE IF NOT EXISTS attached_sources (
  name        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    REAL    NOT NULL,
  size_bytes  INTEGER
);
"#;

/// FTS5 virtual table mirroring `messages.prompt_text`, kept in sync via
/// AFTER INSERT / UPDATE / DELETE triggers. External-content mode (`content=messages`)
/// — the index references rows by rowid; raw text is read back from messages
/// on query, so we don't store prompts twice.
const FTS_SCHEMA: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    prompt_text,
    content='messages',
    content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, prompt_text) VALUES (new.rowid, new.prompt_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, prompt_text) VALUES('delete', old.rowid, old.prompt_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, prompt_text) VALUES('delete', old.rowid, old.prompt_text);
  INSERT INTO messages_fts(rowid, prompt_text) VALUES (new.rowid, new.prompt_text);
END;
"#;

pub fn default_db_path() -> PathBuf {
    let home = dirs_home();
    home.join(".claude").join("token-dashboard.db")
}

fn dirs_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HOME") {
        return PathBuf::from(h);
    }
    if let Some(h) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(h);
    }
    PathBuf::from(".")
}

pub fn init_db<P: AsRef<Path>>(path: P) -> rusqlite::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    migrate_add_message_id(&conn)?;
    migrate_add_tool_use_id(&conn)?;
    migrate_add_provider(&conn)?;
    conn.execute_batch(SCHEMA)?;
    migrate_add_fts(&conn)?;
    Ok(())
}

/// Add `provider` column to `messages`, `tool_calls`, `files`.
///
/// Why: multi-provider support (Codex, Ollama). Existing rows are all
/// Claude — default value backfills them in a single statement, no
/// truncation needed. How to apply: idempotent; no-op on fresh DBs (the
/// SCHEMA above already defines the column).
fn migrate_add_provider(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["messages", "tool_calls", "files"] {
        if !table_exists(conn, table)? {
            continue;
        }
        if column_exists(conn, table, "provider")? {
            continue;
        }
        let sql = format!("ALTER TABLE {table} ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
        conn.execute(&sql, [])?;
    }
    Ok(())
}

/// Create the FTS5 mirror table and triggers, and on first creation rebuild
/// the index from existing `messages.prompt_text` rows. Subsequent inserts
/// are picked up by the triggers, so the rebuild only runs once per DB.
fn migrate_add_fts(conn: &Connection) -> rusqlite::Result<()> {
    let preexisted = table_exists(conn, "messages_fts")?;
    conn.execute_batch(FTS_SCHEMA)?;
    if !preexisted && table_exists(conn, "messages")? {
        conn.execute(
            "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')",
            [],
        )?;
    }
    Ok(())
}

/// Open a writer connection. Mirrors Python `connect()`: 30s busy timeout
/// (matches CLAUDE.md note about ThreadingHTTPServer + ATTACH contention),
/// `foreign_keys = ON`. The Python `_setup_source_views` ATTACH layer is
/// deferred to Phase 2 (endpoints/queries) where it actually matters.
pub fn open<P: AsRef<Path>>(path: P) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI,
    )?;
    tune(&conn)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// Apply the performance PRAGMAs shared by the read and write paths.
///
/// WAL lets the scanner (writer) and the dashboard reads proceed without
/// blocking each other; `synchronous=NORMAL` is durable under WAL with far
/// fewer fsyncs; `mmap_size`/`cache_size` keep the hot DB in mapped/cached
/// pages so cold opens stay warm. `execute_batch` is used because some
/// PRAGMAs (e.g. `journal_mode`) return a row, which `pragma_update` rejects.
///
/// `query_only` is deliberately *not* set: the `open_ro` read helper is also
/// used by a few write paths (e.g. `budget_alerts` recording fired alerts),
/// and the connection pool reuses these connections across both.
pub fn tune(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\
         PRAGMA synchronous=NORMAL;\
         PRAGMA mmap_size=268435456;\
         PRAGMA cache_size=-65536;\
         PRAGMA temp_store=MEMORY;",
    )?;
    Ok(())
}

/// Add `messages.message_id` for streaming-snapshot dedup.
///
/// Why: pre-migration rows were summed from all streaming snapshots
/// (over-count). How to apply: if the old table exists without the column,
/// add it and clear messages/tool_calls/files so the next scan replays
/// JSONLs cleanly.
fn migrate_add_message_id(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "messages")? {
        return Ok(());
    }
    if column_exists(conn, "messages", "message_id")? {
        return Ok(());
    }
    conn.execute("ALTER TABLE messages ADD COLUMN message_id TEXT", [])?;
    conn.execute("DELETE FROM messages", [])?;
    conn.execute("DELETE FROM tool_calls", [])?;
    conn.execute("DELETE FROM files", [])?;
    Ok(())
}

/// Add `tool_calls.use_id` so result_tokens can be joined back to the
/// tool_use row. Why: pre-migration tool_use rows had no link to their
/// matching `_tool_result` row.
fn migrate_add_tool_use_id(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "tool_calls")? {
        return Ok(());
    }
    if column_exists(conn, "tool_calls", "use_id")? {
        return Ok(());
    }
    conn.execute("ALTER TABLE tool_calls ADD COLUMN use_id TEXT", [])?;
    conn.execute("DELETE FROM tool_calls", [])?;
    conn.execute("DELETE FROM files", [])?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let n: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |r| r.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(n.is_some())
}

fn column_exists(conn: &Connection, table: &str, col: &str) -> rusqlite::Result<bool> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let name: String = r.get(1)?;
        if name == col {
            return Ok(true);
        }
    }
    Ok(false)
}
