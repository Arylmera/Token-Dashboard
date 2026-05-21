//! Remote-machine sources for the read-only multi-machine sync feature.
//!
//! A "remote source" is another Token Dashboard install (CLI or Tauri)
//! reachable over HTTP. The viewer machine pulls a JSON snapshot from
//! each enabled remote source and merges the rows into its local DB
//! (deduplicated by `messages.uuid`). Bearer-token auth gates the host
//! side; the token lives only in the viewer's local DB and never leaves
//! the user's machine over the network in clear text on the wire other
//! than the `Authorization: Bearer` request header.
//!
//! Distinct from `sources.rs` (which attaches local SQLite files) — both
//! systems coexist.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS remote_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  base_url    TEXT NOT NULL UNIQUE,
  bearer      TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_sync_at REAL,
  last_error  TEXT,
  added_at    REAL NOT NULL
);
"#;

pub(crate) fn ensure_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSource {
    pub id: i64,
    pub label: String,
    pub base_url: String,
    /// Always elided from API responses (returned `None`) so the token
    /// never leaks back to the UI / logs. Stored verbatim in DB.
    pub bearer: Option<String>,
    pub enabled: bool,
    pub last_sync_at: Option<f64>,
    pub last_error: Option<String>,
    pub added_at: f64,
}

fn now_ts() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn open<P: AsRef<Path>>(db: P) -> rusqlite::Result<rusqlite::Connection> {
    let c = rusqlite::Connection::open(db.as_ref())?;
    c.busy_timeout(std::time::Duration::from_secs(30))?;
    ensure_schema(&c)?;
    Ok(c)
}

fn redact(mut row: RemoteSource) -> RemoteSource {
    row.bearer = None;
    row
}

/// List configured remote sources, redacting the bearer token from each row.
pub fn list<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<RemoteSource>> {
    let c = open(db)?;
    let mut stmt = c.prepare(
        "SELECT id, label, base_url, bearer, enabled, last_sync_at, last_error, added_at \
         FROM remote_sources ORDER BY added_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(RemoteSource {
            id: r.get(0)?,
            label: r.get(1)?,
            base_url: r.get(2)?,
            bearer: r.get(3)?,
            enabled: r.get::<_, i64>(4)? != 0,
            last_sync_at: r.get(5)?,
            last_error: r.get(6)?,
            added_at: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(redact(row?));
    }
    Ok(out)
}

/// Add a new remote source. URL is canonicalised (trailing slash stripped).
/// Returns the inserted row (with bearer redacted).
pub fn add<P: AsRef<Path>>(
    db: P,
    label: &str,
    base_url: &str,
    bearer: Option<&str>,
) -> rusqlite::Result<RemoteSource> {
    let label = label.trim();
    let url = base_url.trim_end_matches('/').to_string();
    if label.is_empty() || url.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "label and base_url required".into(),
        ));
    }
    let c = open(db.as_ref())?;
    c.execute(
        "INSERT INTO remote_sources (label, base_url, bearer, enabled, added_at) \
         VALUES (?1, ?2, ?3, 1, ?4)",
        params![label, url, bearer, now_ts()],
    )?;
    let id = c.last_insert_rowid();
    get(db, id).and_then(|maybe| maybe.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows))
}

pub fn get<P: AsRef<Path>>(db: P, id: i64) -> rusqlite::Result<Option<RemoteSource>> {
    let c = open(db)?;
    let row = c.query_row(
        "SELECT id, label, base_url, bearer, enabled, last_sync_at, last_error, added_at \
         FROM remote_sources WHERE id = ?1",
        params![id],
        |r| {
            Ok(RemoteSource {
                id: r.get(0)?,
                label: r.get(1)?,
                base_url: r.get(2)?,
                bearer: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                last_sync_at: r.get(5)?,
                last_error: r.get(6)?,
                added_at: r.get(7)?,
            })
        },
    );
    match row {
        Ok(r) => Ok(Some(redact(r))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Like `get` but DOESN'T redact the bearer. Used by the sync driver in
/// the CLI crate to actually authenticate the outbound pull. Never
/// expose the result through any HTTP response — it carries the token.
pub fn get_with_bearer<P: AsRef<Path>>(db: P, id: i64) -> rusqlite::Result<Option<RemoteSource>> {
    let c = open(db)?;
    let row = c.query_row(
        "SELECT id, label, base_url, bearer, enabled, last_sync_at, last_error, added_at \
         FROM remote_sources WHERE id = ?1",
        params![id],
        |r| {
            Ok(RemoteSource {
                id: r.get(0)?,
                label: r.get(1)?,
                base_url: r.get(2)?,
                bearer: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                last_sync_at: r.get(5)?,
                last_error: r.get(6)?,
                added_at: r.get(7)?,
            })
        },
    );
    match row {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn delete<P: AsRef<Path>>(db: P, id: i64) -> rusqlite::Result<bool> {
    let c = open(db)?;
    let n = c.execute("DELETE FROM remote_sources WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

pub fn set_enabled<P: AsRef<Path>>(db: P, id: i64, enabled: bool) -> rusqlite::Result<bool> {
    let c = open(db)?;
    let n = c.execute(
        "UPDATE remote_sources SET enabled = ?1 WHERE id = ?2",
        params![if enabled { 1 } else { 0 }, id],
    )?;
    Ok(n > 0)
}

/// Stamp the row after a sync attempt. `error` is `Some` on failure and
/// `None` on success; either way `last_sync_at` updates so the UI can
/// show "last attempted N ago".
pub fn stamp_sync<P: AsRef<Path>>(db: P, id: i64, error: Option<&str>) -> rusqlite::Result<()> {
    let c = open(db)?;
    c.execute(
        "UPDATE remote_sources SET last_sync_at = ?1, last_error = ?2 WHERE id = ?3",
        params![now_ts(), error, id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use tempfile::NamedTempFile;

    fn fresh() -> NamedTempFile {
        let f = NamedTempFile::new().unwrap();
        init_db(f.path()).unwrap();
        f
    }

    #[test]
    fn add_get_list_delete_round_trip() {
        let f = fresh();
        let row = add(f.path(), "laptop", "http://1.2.3.4:8080/", Some("tok-1")).unwrap();
        assert!(row.bearer.is_none(), "bearer must be redacted");
        assert_eq!(row.base_url, "http://1.2.3.4:8080");
        let listed = list(f.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "laptop");
        assert!(listed[0].bearer.is_none());

        let with_token = get_with_bearer(f.path(), row.id).unwrap().unwrap();
        assert_eq!(with_token.bearer.as_deref(), Some("tok-1"));

        set_enabled(f.path(), row.id, false).unwrap();
        let after = get(f.path(), row.id).unwrap().unwrap();
        assert!(!after.enabled);

        let removed = delete(f.path(), row.id).unwrap();
        assert!(removed);
        let listed = list(f.path()).unwrap();
        assert!(listed.is_empty());
    }

    #[test]
    fn unique_base_url_constraint() {
        let f = fresh();
        add(f.path(), "a", "http://example.com", None).unwrap();
        let err = add(f.path(), "b", "http://example.com", None).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("UNIQUE"),
            "expected UNIQUE violation, got {msg}"
        );
    }
}
