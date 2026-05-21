//! Prompt verbosity ranking.
//!
//! Surfaces user prompts where the input/output ratio is high — long prompts
//! that produced tiny assistant responses. "Ratio" mixes units (chars in vs
//! tokens out); it's a coarse heuristic but stable across English and code.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct WastedPrompt {
    pub session_id: String,
    pub timestamp: String,
    pub prompt_chars: u64,
    pub output_tokens: u64,
    pub ratio: f64,
    pub preview: String,
    pub model: Option<String>,
}

pub fn worst(conn: &Connection, min_chars: u32, top: u32) -> rusqlite::Result<Vec<WastedPrompt>> {
    let mut stmt = conn.prepare(
        "SELECT u.session_id, u.timestamp, u.prompt_chars, u.prompt_text, \
                a.model, a.output_tokens \
         FROM messages u \
         JOIN messages a ON a.parent_uuid = u.uuid AND a.type = 'assistant' \
         WHERE u.type = 'user' AND u.prompt_chars >= ?1 \
         ORDER BY (CAST(u.prompt_chars AS REAL) / MAX(a.output_tokens, 1)) DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![min_chars as i64, top as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, i64>(5)? as u64,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (session_id, timestamp, prompt_chars, prompt_text, model, output_tokens) = row?;
        let ratio = prompt_chars as f64 / output_tokens.max(1) as f64;
        let preview = prompt_text
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(240)
            .collect();
        out.push(WastedPrompt {
            session_id,
            timestamp,
            prompt_chars,
            output_tokens,
            ratio,
            preview,
            model,
        });
    }
    Ok(out)
}

pub fn worst_at_path<P: AsRef<Path>>(
    db: P,
    min_chars: u32,
    top: u32,
) -> rusqlite::Result<Vec<WastedPrompt>> {
    let conn = crate::queries::open_ro(db)?;
    worst(&conn, min_chars, top)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().expect("tempfile");
        init_db(f.path()).expect("init");
        f
    }

    fn seed(c: &Connection) {
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, \
             prompt_text, prompt_chars, model, input_tokens, output_tokens, \
             cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES ('u1','s1','p1','user','2026-05-20T10:00:00Z', \
             'long prompt text here', 1000, NULL, 0, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, \
             timestamp, model, input_tokens, output_tokens, \
             cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES ('a1','u1','s1','p1','assistant','2026-05-20T10:00:01Z', \
             'claude-opus-4-7', 200, 5, 0, 0, 0)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn returns_prompts_with_high_ratio() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        seed(&c);
        let rows = worst(&c, 100, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ratio >= 200.0);
        assert_eq!(rows[0].output_tokens, 5);
        assert_eq!(rows[0].model.as_deref(), Some("claude-opus-4-7"));
    }

    #[test]
    fn filters_below_min_chars() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        seed(&c);
        let rows = worst(&c, 5000, 10).unwrap();
        assert!(rows.is_empty());
    }
}
