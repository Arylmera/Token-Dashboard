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
