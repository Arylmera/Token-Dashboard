//! Attached source DB registry — read side only for Phase 2 scaffold.
//!
//! Direct port of `list_sources` from `token_dashboard/db/sources.py`.
//! Add/remove/toggle land alongside the POST endpoints in a follow-up
//! commit (they need multipart upload validation + SQLite magic-byte
//! sniffing, which warrants its own review).

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One row of the `attached_sources` table, shaped for JSON output.
///
/// Wire format mirrors python `list_sources` exactly so the existing
/// frontend (`/api/sources` consumer in `frontend/src/api-client.js`)
/// works without changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub name: String,
    pub path: String,
    pub enabled: bool,
    pub added_at: f64,
    pub size_bytes: Option<i64>,
    pub exists: bool,
}

/// Toggle the `enabled` flag for a registered source. Returns true when
/// the row exists. Mirrors python `set_source_enabled`.
pub fn set_source_enabled<P: AsRef<Path>>(
    db_path: P,
    name: &str,
    enabled: bool,
) -> rusqlite::Result<bool> {
    let conn = Connection::open(db_path.as_ref())?;
    let n = conn.execute(
        "UPDATE attached_sources SET enabled=? WHERE name=?",
        rusqlite::params![if enabled { 1 } else { 0 }, name],
    )?;
    Ok(n > 0)
}

/// Remove a source from the registry and its on-disk file. The unlink
/// happens AFTER the connection drops — when the python port lands the
/// ATTACH layer it'll need to release the file lock the same way.
/// Returns true when a row was deleted.
pub fn remove_source<P: AsRef<Path>>(db_path: P, name: &str) -> rusqlite::Result<bool> {
    let conn = Connection::open(db_path.as_ref())?;
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM attached_sources WHERE name=?",
            [name],
            |r| r.get(0),
        )
        .ok();
    let Some(path_str) = path else {
        return Ok(false);
    };
    let removed = conn.execute("DELETE FROM attached_sources WHERE name=?", [name])?;
    drop(conn);
    if removed > 0 {
        let _ = std::fs::remove_file(&path_str);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn list_sources<P: AsRef<Path>>(db_path: P) -> rusqlite::Result<Vec<Source>> {
    let conn = Connection::open(db_path.as_ref())?;
    let mut stmt = conn.prepare(
        "SELECT name, path, enabled, added_at, size_bytes \
         FROM attached_sources ORDER BY added_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        let path: String = r.get(1)?;
        let enabled: i64 = r.get(2)?;
        let exists = Path::new(&path).exists();
        Ok(Source {
            name: r.get(0)?,
            path,
            enabled: enabled != 0,
            added_at: r.get(3)?,
            size_bytes: r.get(4)?,
            exists,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}
