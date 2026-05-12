//! Port of `tests/test_db.py`.

use rusqlite::Connection;
use std::collections::BTreeSet;
use tempfile::TempDir;
use token_dashboard_core::{init_db, open};

#[test]
fn init_creates_expected_tables() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("test.db");
    init_db(&db).unwrap();
    let c = Connection::open(&db).unwrap();
    let mut stmt = c
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .unwrap();
    let tables: BTreeSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for expected in ["files", "messages", "tool_calls", "plan", "dismissed_tips"] {
        assert!(
            tables.contains(expected),
            "missing table: {expected}; got {tables:?}"
        );
    }
}

#[test]
fn init_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("test.db");
    init_db(&db).unwrap();
    init_db(&db).unwrap();
}

#[test]
fn migrate_adds_provider_column_and_backfills_claude() {
    // Simulate an old DB (no `provider` column) and verify the migration
    // adds the column AND existing rows default to 'claude'.
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("test.db");
    {
        let c = Connection::open(&db).unwrap();
        // Pre-provider schema: matches v4.0.x SCHEMA exactly minus the
        // provider column on messages/tool_calls/files. Mirrors what an
        // upgrading user's DB looks like before this migration runs.
        c.execute_batch(
            "CREATE TABLE files (
                path        TEXT PRIMARY KEY,
                mtime       REAL    NOT NULL,
                bytes_read  INTEGER NOT NULL,
                scanned_at  REAL    NOT NULL
             );
             CREATE TABLE messages (
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
                tool_calls_json         TEXT
             );
             CREATE TABLE tool_calls (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                message_uuid  TEXT    NOT NULL,
                session_id    TEXT    NOT NULL,
                project_slug  TEXT    NOT NULL,
                tool_name     TEXT    NOT NULL,
                target        TEXT,
                use_id        TEXT,
                result_tokens INTEGER,
                is_error      INTEGER NOT NULL DEFAULT 0,
                timestamp     TEXT    NOT NULL
             );",
        )
        .unwrap();
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp) \
             VALUES ('u1', 's1', 'p', 'assistant', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    init_db(&db).unwrap();

    let c = Connection::open(&db).unwrap();
    let provider: String = c
        .query_row("SELECT provider FROM messages WHERE uuid='u1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(provider, "claude");

    // All three tables have the column.
    for table in ["messages", "tool_calls", "files"] {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = c.prepare(&sql).unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            cols.iter().any(|c| c == "provider"),
            "{table} missing provider column; got {cols:?}"
        );
    }
}

#[test]
fn fresh_db_has_provider_column_on_all_tables() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("test.db");
    init_db(&db).unwrap();
    let c = Connection::open(&db).unwrap();
    for table in ["messages", "tool_calls", "files"] {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = c.prepare(&sql).unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            cols.iter().any(|col| col == "provider"),
            "{table} missing provider column"
        );
    }
}

#[test]
fn open_returns_usable_connection() {
    // Python equivalent asserts `c.execute("SELECT 1 AS one")[0]["one"] == 1`.
    // The Rust spirit: open() yields a Connection that runs queries.
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("test.db");
    init_db(&db).unwrap();
    let c = open(&db).unwrap();
    let one: i64 = c.query_row("SELECT 1 AS one", [], |r| r.get(0)).unwrap();
    assert_eq!(one, 1);
}
