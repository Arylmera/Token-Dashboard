//! Build + ingest the snapshot bundle that powers multi-machine sync.
//!
//! Two surfaces:
//!
//! * **Host side** — `build(...)` serialises every message + tool_call
//!   newer than `since` into a JSON-friendly struct. The HTTP layer
//!   serves this behind Bearer auth.
//! * **Viewer side** — `merge(...)` takes a snapshot value (typically
//!   parsed from the host's JSON) and `INSERT OR IGNORE`s its rows into
//!   the local DB. Dedup keys on `messages.uuid` and `(message_uuid,
//!   tool_name, target, use_id, timestamp)` for tool_calls so re-pulling
//!   never duplicates.
//!
//! Privacy: snapshots do NOT include `prompt_text`. Users on shared
//! machines can opt-in to richer payloads later; for now the wire format
//! sticks to numerics + identifiers.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotMessage {
    pub uuid: String,
    pub session_id: String,
    pub project_slug: String,
    pub message_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub timestamp: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
    pub is_sidechain: u8,
    pub agent_id: Option<String>,
    pub parent_uuid: Option<String>,
    pub prompt_chars: Option<i64>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotToolCall {
    pub message_uuid: String,
    pub session_id: String,
    pub project_slug: String,
    pub tool_name: String,
    pub target: Option<String>,
    pub use_id: Option<String>,
    pub result_tokens: Option<i64>,
    pub is_error: u8,
    pub timestamp: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    pub host_id: String,
    pub generated_at: String,
    pub messages: Vec<SnapshotMessage>,
    pub tool_calls: Vec<SnapshotToolCall>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct MergeStats {
    pub messages_inserted: usize,
    pub tool_calls_inserted: usize,
    pub latest_ts: Option<String>,
}

/// Build a snapshot containing every row newer than `since` (exclusive).
/// Pass `None` for a full history dump.
pub fn build<P: AsRef<Path>>(db: P, since: Option<&str>) -> rusqlite::Result<Snapshot> {
    let conn = open_ro(db)?;
    let cutoff = since.unwrap_or("1970-01-01T00:00:00Z");

    let mut msg_stmt = conn.prepare(
        "SELECT uuid, session_id, project_slug, message_id, type, timestamp, model, \
                input_tokens, output_tokens, cache_read_tokens, \
                cache_create_5m_tokens, cache_create_1h_tokens, \
                is_sidechain, agent_id, parent_uuid, prompt_chars, provider \
         FROM messages WHERE timestamp > ?1 ORDER BY timestamp",
    )?;
    let messages = msg_stmt
        .query_map(params![cutoff], |r| {
            Ok(SnapshotMessage {
                uuid: r.get(0)?,
                session_id: r.get(1)?,
                project_slug: r.get(2)?,
                message_id: r.get(3)?,
                kind: r.get(4)?,
                timestamp: r.get(5)?,
                model: r.get(6)?,
                input_tokens: r.get(7)?,
                output_tokens: r.get(8)?,
                cache_read_tokens: r.get(9)?,
                cache_create_5m_tokens: r.get(10)?,
                cache_create_1h_tokens: r.get(11)?,
                is_sidechain: r.get::<_, i64>(12)? as u8,
                agent_id: r.get(13)?,
                parent_uuid: r.get(14)?,
                prompt_chars: r.get(15)?,
                provider: r.get(16)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut tc_stmt = conn.prepare(
        "SELECT message_uuid, session_id, project_slug, tool_name, target, use_id, \
                result_tokens, is_error, timestamp, provider \
         FROM tool_calls WHERE timestamp > ?1 ORDER BY timestamp",
    )?;
    let tool_calls = tc_stmt
        .query_map(params![cutoff], |r| {
            Ok(SnapshotToolCall {
                message_uuid: r.get(0)?,
                session_id: r.get(1)?,
                project_slug: r.get(2)?,
                tool_name: r.get(3)?,
                target: r.get(4)?,
                use_id: r.get(5)?,
                result_tokens: r.get(6)?,
                is_error: r.get::<_, i64>(7)? as u8,
                timestamp: r.get(8)?,
                provider: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let host_id = std::env::var("TOKEN_DASHBOARD_HOST_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "host".to_string());
    let generated_at = conn
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default();

    Ok(Snapshot {
        host_id,
        generated_at,
        messages,
        tool_calls,
    })
}

/// Merge a snapshot into the local DB. Idempotent — re-running yields
/// the same store. Returns counts so callers can show "imported N rows".
pub fn merge<P: AsRef<Path>>(db: P, snap: &Snapshot) -> rusqlite::Result<MergeStats> {
    let mut conn = rusqlite::Connection::open(db.as_ref())?;
    let tx = conn.transaction()?;
    let mut stats = MergeStats::default();

    {
        let mut msg_stmt = tx.prepare(
            "INSERT OR IGNORE INTO messages \
             (uuid, session_id, project_slug, message_id, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens, \
              is_sidechain, agent_id, parent_uuid, prompt_chars, provider) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )?;
        for m in &snap.messages {
            let inserted = msg_stmt.execute(params![
                m.uuid,
                m.session_id,
                m.project_slug,
                m.message_id,
                m.kind,
                m.timestamp,
                m.model,
                m.input_tokens,
                m.output_tokens,
                m.cache_read_tokens,
                m.cache_create_5m_tokens,
                m.cache_create_1h_tokens,
                m.is_sidechain as i64,
                m.agent_id,
                m.parent_uuid,
                m.prompt_chars,
                m.provider,
            ])?;
            stats.messages_inserted += inserted;
            if stats
                .latest_ts
                .as_deref()
                .is_none_or(|cur| m.timestamp.as_str() > cur)
            {
                stats.latest_ts = Some(m.timestamp.clone());
            }
        }

        let mut tc_stmt = tx.prepare(
            "INSERT INTO tool_calls \
             (message_uuid, session_id, project_slug, tool_name, target, use_id, \
              result_tokens, is_error, timestamp, provider) \
             SELECT ?,?,?,?,?,?,?,?,?,? \
             WHERE NOT EXISTS ( \
               SELECT 1 FROM tool_calls \
               WHERE message_uuid = ?1 AND tool_name = ?4 \
                 AND COALESCE(target,'') = COALESCE(?5,'') \
                 AND COALESCE(use_id,'') = COALESCE(?6,'') \
                 AND timestamp = ?9 \
             )",
        )?;
        for t in &snap.tool_calls {
            let inserted = tc_stmt.execute(params![
                t.message_uuid,
                t.session_id,
                t.project_slug,
                t.tool_name,
                t.target,
                t.use_id,
                t.result_tokens,
                t.is_error as i64,
                t.timestamp,
                t.provider,
            ])?;
            stats.tool_calls_inserted += inserted;
            if stats
                .latest_ts
                .as_deref()
                .is_none_or(|cur| t.timestamp.as_str() > cur)
            {
                stats.latest_ts = Some(t.timestamp.clone());
            }
        }
    }

    tx.commit()?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::Connection;
    use tempfile::NamedTempFile;

    fn fresh() -> NamedTempFile {
        let f = NamedTempFile::new().unwrap();
        init_db(f.path()).unwrap();
        f
    }

    fn insert_msg(conn: &Connection, uuid: &str, ts: &str) {
        conn.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, \
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, \
              cache_create_1h_tokens) VALUES (?1, 's', 'p', 'assistant', ?2, 0, 100, 0, 0, 0)",
            params![uuid, ts],
        )
        .unwrap();
    }

    #[test]
    fn build_skips_rows_before_cutoff() {
        let f = fresh();
        let c = Connection::open(f.path()).unwrap();
        insert_msg(&c, "old", "2024-01-01T00:00:00Z");
        insert_msg(&c, "new", "2026-05-22T00:00:00Z");
        drop(c);
        let snap = build(f.path(), Some("2025-12-31T23:59:59Z")).unwrap();
        assert_eq!(snap.messages.len(), 1);
        assert_eq!(snap.messages[0].uuid, "new");
    }

    #[test]
    fn merge_is_idempotent() {
        let f_a = fresh();
        let f_b = fresh();
        let c = Connection::open(f_a.path()).unwrap();
        insert_msg(&c, "u1", "2026-05-22T10:00:00Z");
        drop(c);
        let snap = build(f_a.path(), None).unwrap();

        let first = merge(f_b.path(), &snap).unwrap();
        assert_eq!(first.messages_inserted, 1);
        let second = merge(f_b.path(), &snap).unwrap();
        assert_eq!(second.messages_inserted, 0, "second merge must dedup");
    }

    /// Two hosts contribute to the same `session_id` (the user worked
    /// on the same Claude Code session on both machines — implausible
    /// in practice, but the dedup key must still hold). Only rows
    /// whose `uuid` is new should land; existing uuids are skipped.
    #[test]
    fn merge_overlapping_session_dedups_by_uuid() {
        let f_view = fresh();
        // Existing row already in the viewer DB.
        {
            let c = Connection::open(f_view.path()).unwrap();
            insert_msg(&c, "shared-1", "2026-05-22T10:00:00Z");
        }

        // Build a snapshot from a sibling host that has *both* the
        // overlapping uuid AND a new uuid in the same session.
        let f_host = fresh();
        {
            let c = Connection::open(f_host.path()).unwrap();
            insert_msg(&c, "shared-1", "2026-05-22T10:00:00Z");
            insert_msg(&c, "host-only-1", "2026-05-22T11:00:00Z");
        }
        let snap = build(f_host.path(), None).unwrap();
        assert_eq!(snap.messages.len(), 2);

        let stats = merge(f_view.path(), &snap).unwrap();
        assert_eq!(
            stats.messages_inserted, 1,
            "overlapping uuid must dedup, only host-only-1 lands"
        );

        // Viewer ends up with both rows.
        let c = Connection::open(f_view.path()).unwrap();
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM messages WHERE session_id = 's'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    /// Tool-calls dedup on the composite (message_uuid, tool_name,
    /// target, use_id, timestamp) rather than a synthetic key — re-
    /// pulling a snapshot with the same tool-call rows must not double.
    #[test]
    fn merge_tool_calls_dedup_composite() {
        let f_view = fresh();
        let f_host = fresh();
        {
            let c = Connection::open(f_host.path()).unwrap();
            insert_msg(&c, "u1", "2026-05-22T10:00:00Z");
            c.execute(
                "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, \
                  use_id, result_tokens, is_error, timestamp) VALUES \
                  ('u1', 's', 'p', 'Read', '/tmp/x.txt', 'use-1', 50, 0, '2026-05-22T10:00:01Z')",
                [],
            )
            .unwrap();
        }
        let snap = build(f_host.path(), None).unwrap();
        assert_eq!(snap.tool_calls.len(), 1);

        let s1 = merge(f_view.path(), &snap).unwrap();
        assert_eq!(s1.tool_calls_inserted, 1);
        let s2 = merge(f_view.path(), &snap).unwrap();
        assert_eq!(s2.tool_calls_inserted, 0, "tool-call dedup must hold on re-merge");
    }
}
