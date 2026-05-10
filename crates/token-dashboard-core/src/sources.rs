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

const SQLITE_MAGIC: &[u8] = b"SQLite format 3\x00";

/// Build the on-disk directory holding attached source DBs. Mirrors
/// python `sources_dir`. Created on demand.
pub fn sources_dir<P: AsRef<Path>>(db_path: P) -> std::io::Result<std::path::PathBuf> {
    let parent = db_path
        .as_ref()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = parent.join("token-dashboard-sources");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn safe_name(filename: &str) -> String {
    // Strip path components.
    let base = std::path::Path::new(filename)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "source.db".into());
    // Drop anything outside [A-Za-z0-9._-]; collapse repeats.
    let mut out = String::with_capacity(base.len());
    let mut prev_underscore = false;
    for c in base.chars() {
        let keep = c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-';
        if keep {
            out.push(c);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let cleaned = out.trim_matches(['.', '_']).to_string();
    let cleaned = if cleaned.is_empty() {
        "source.db".to_string()
    } else {
        cleaned
    };
    if cleaned.to_lowercase().ends_with(".db") {
        cleaned
    } else {
        format!("{cleaned}.db")
    }
}

fn unique_name<P: AsRef<Path>>(db_path: P, candidate: &str) -> rusqlite::Result<String> {
    let conn = Connection::open(db_path.as_ref())?;
    let mut stmt = conn.prepare("SELECT name FROM attached_sources")?;
    let existing: std::collections::HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !existing.contains(candidate) {
        return Ok(candidate.to_string());
    }
    let stem = if candidate.to_lowercase().ends_with(".db") {
        &candidate[..candidate.len() - 3]
    } else {
        candidate
    };
    let mut n: u32 = 2;
    loop {
        let trial = format!("{stem}-{n}.db");
        if !existing.contains(&trial) {
            return Ok(trial);
        }
        n += 1;
    }
}

/// Validate + store an uploaded source DB and register it (enabled).
/// Mirrors python `add_source`. Returns the registry row.
pub fn add_source<P: AsRef<Path>>(
    db_path: P,
    filename: &str,
    bytes: &[u8],
) -> Result<Source, AddSourceError> {
    if bytes.is_empty() || !bytes.starts_with(SQLITE_MAGIC) {
        return Err(AddSourceError::NotSqlite);
    }
    let name = unique_name(db_path.as_ref(), &safe_name(filename))?;
    let dir = sources_dir(db_path.as_ref()).map_err(AddSourceError::Io)?;
    let target = dir.join(&name);
    std::fs::write(&target, bytes).map_err(AddSourceError::Io)?;

    // Probe: confirm it's a readable SQLite file with a `messages` table —
    // surfaces invalid uploads at upload time, not later.
    let probe = Connection::open(&target);
    let has_msgs = match probe {
        Ok(p) => {
            let n: Result<i64, _> = p.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |r| r.get(0),
            );
            n.is_ok()
        }
        Err(_) => {
            let _ = std::fs::remove_file(&target);
            return Err(AddSourceError::NotReadable);
        }
    };
    if !has_msgs {
        let _ = std::fs::remove_file(&target);
        return Err(AddSourceError::NoMessages);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let conn = Connection::open(db_path.as_ref())?;
    conn.execute(
        "INSERT INTO attached_sources (name, path, enabled, added_at, size_bytes) \
         VALUES (?, ?, 1, ?, ?)",
        rusqlite::params![name, target.to_string_lossy(), now, bytes.len() as i64],
    )?;
    Ok(Source {
        name,
        path: target.to_string_lossy().into_owned(),
        enabled: true,
        added_at: now,
        size_bytes: Some(bytes.len() as i64),
        exists: true,
    })
}

#[derive(Debug)]
pub enum AddSourceError {
    NotSqlite,
    NotReadable,
    NoMessages,
    Io(std::io::Error),
    Db(rusqlite::Error),
}

impl std::fmt::Display for AddSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSqlite => write!(f, "not a SQLite database"),
            Self::NotReadable => write!(f, "file is not a readable SQLite database"),
            Self::NoMessages => write!(f, "source DB has no `messages` table"),
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Db(e) => write!(f, "db: {e}"),
        }
    }
}

impl From<rusqlite::Error> for AddSourceError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
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
