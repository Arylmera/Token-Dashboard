//! Per-day token aggregations for the Calendar view. Pricing-free — the
//! CLI route layer folds these token rows through `cost_for`, mirroring
//! the split used by `model_breakdown` / `cache_stats`. The day is matched
//! on the UTC calendar date via `substr(timestamp, 1, 10) = ?1`.

use std::path::Path;

use rusqlite::params;
use serde::Serialize;

use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct DayTotals {
    pub turns: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayModelRow {
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayProjectRow {
    pub project_slug: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayHourRow {
    pub hour: i64,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DaySessionRow {
    pub session_id: String,
    pub project_slug: String,
    pub model: String,
    pub started: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DaySessionTurns {
    pub session_id: String,
    pub turns: i64,
}

pub fn day_totals<P: AsRef<Path>>(db: P, date: &str) -> rusqlite::Result<DayTotals> {
    let conn = open_ro(db)?;
    conn.query_row(
        "SELECT \
            COALESCE(SUM(CASE WHEN type = 'user' \
                          AND is_sidechain = 0 \
                          AND TRIM(COALESCE(prompt_text, '')) != '' THEN 1 ELSE 0 END), 0) AS turns, \
            COUNT(DISTINCT session_id) AS sessions \
         FROM messages \
         WHERE substr(timestamp, 1, 10) = ?1",
        params![date],
        |r| {
            Ok(DayTotals {
                turns: r.get(0)?,
                sessions: r.get(1)?,
            })
        },
    )
}

pub fn day_by_model<P: AsRef<Path>>(db: P, date: &str) -> rusqlite::Result<Vec<DayModelRow>> {
    let conn = open_ro(db)?;
    let mut stmt = conn.prepare(
        "SELECT COALESCE(model, '(unknown)'), \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' AND substr(timestamp, 1, 10) = ?1 \
         GROUP BY model",
    )?;
    let rows = stmt.query_map(params![date], |r| {
        Ok(DayModelRow {
            model: r.get(0)?,
            input_tokens: r.get(1)?,
            output_tokens: r.get(2)?,
            cache_read_tokens: r.get(3)?,
            cache_create_5m_tokens: r.get(4)?,
            cache_create_1h_tokens: r.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn day_by_hour<P: AsRef<Path>>(db: P, date: &str) -> rusqlite::Result<Vec<DayHourRow>> {
    let conn = open_ro(db)?;
    let mut stmt = conn.prepare(
        "SELECT CAST(substr(timestamp, 12, 2) AS INTEGER) AS hour, \
                COALESCE(model, '(unknown)'), \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' AND substr(timestamp, 1, 10) = ?1 \
         GROUP BY hour, model",
    )?;
    let rows = stmt.query_map(params![date], |r| {
        Ok(DayHourRow {
            hour: r.get(0)?,
            model: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn day_by_project<P: AsRef<Path>>(db: P, date: &str) -> rusqlite::Result<Vec<DayProjectRow>> {
    let conn = open_ro(db)?;
    let mut stmt = conn.prepare(
        "SELECT COALESCE(project_slug, '(none)'), \
                COALESCE(model, '(unknown)'), \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' AND substr(timestamp, 1, 10) = ?1 \
         GROUP BY project_slug, model",
    )?;
    let rows = stmt.query_map(params![date], |r| {
        Ok(DayProjectRow {
            project_slug: r.get(0)?,
            model: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn day_by_session<P: AsRef<Path>>(db: P, date: &str) -> rusqlite::Result<Vec<DaySessionRow>> {
    let conn = open_ro(db)?;
    let mut stmt = conn.prepare(
        "SELECT session_id, \
                COALESCE(project_slug, '(none)'), \
                COALESCE(model, '(unknown)'), \
                MIN(timestamp) AS started, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' AND substr(timestamp, 1, 10) = ?1 \
         GROUP BY session_id, project_slug, model",
    )?;
    let rows = stmt.query_map(params![date], |r| {
        Ok(DaySessionRow {
            session_id: r.get(0)?,
            project_slug: r.get(1)?,
            model: r.get(2)?,
            started: r.get(3)?,
            input_tokens: r.get(4)?,
            output_tokens: r.get(5)?,
            cache_read_tokens: r.get(6)?,
            cache_create_5m_tokens: r.get(7)?,
            cache_create_1h_tokens: r.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn day_session_turns<P: AsRef<Path>>(
    db: P,
    date: &str,
) -> rusqlite::Result<Vec<DaySessionTurns>> {
    let conn = open_ro(db)?;
    let mut stmt = conn.prepare(
        "SELECT session_id, COUNT(*) AS turns \
         FROM messages \
         WHERE type = 'user' AND is_sidechain = 0 \
           AND TRIM(COALESCE(prompt_text, '')) != '' \
           AND substr(timestamp, 1, 10) = ?1 \
         GROUP BY session_id",
    )?;
    let rows = stmt.query_map(params![date], |r| {
        Ok(DaySessionTurns {
            session_id: r.get(0)?,
            turns: r.get(1)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::{params, Connection};
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().expect("tempfile");
        init_db(f.path()).expect("init");
        f
    }

    fn insert_assistant(
        conn: &Connection,
        uuid: &str,
        session: &str,
        project: &str,
        timestamp: &str,
        model: &str,
        input: i64,
        output: i64,
    ) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens, is_sidechain) \
             VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6, ?7, 0, 0, 0, 0)",
            params![uuid, session, project, timestamp, model, input, output],
        )
        .unwrap();
    }

    fn insert_user(conn: &Connection, uuid: &str, session: &str, timestamp: &str, prompt: &str) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, prompt_text, is_sidechain) \
             VALUES (?1, ?2, 'p1', 'user', ?3, ?4, 0)",
            params![uuid, session, timestamp, prompt],
        )
        .unwrap();
    }

    #[test]
    fn totals_counts_turns_and_distinct_sessions() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_user(&conn, "u1", "s1", "2026-05-25T09:00:00Z", "hi");
        insert_user(&conn, "u2", "s1", "2026-05-25T10:00:00Z", "again");
        insert_user(&conn, "u3", "s2", "2026-05-25T11:00:00Z", "other session");
        insert_user(&conn, "u4", "s2", "2026-05-25T11:30:00Z", "   ");
        insert_user(&conn, "u5", "s3", "2026-05-24T09:00:00Z", "yesterday");

        let t = day_totals(f.path(), "2026-05-25").unwrap();
        assert_eq!(t.turns, 3);
        assert_eq!(t.sessions, 2);
    }

    #[test]
    fn by_model_sums_tokens_per_model_for_the_day() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(
            &conn,
            "a1",
            "s1",
            "p1",
            "2026-05-25T09:00:00Z",
            "claude-opus-4-7",
            100,
            10,
        );
        insert_assistant(
            &conn,
            "a2",
            "s1",
            "p1",
            "2026-05-25T10:00:00Z",
            "claude-opus-4-7",
            50,
            5,
        );
        insert_assistant(
            &conn,
            "a3",
            "s2",
            "p2",
            "2026-05-25T11:00:00Z",
            "claude-haiku-4-5",
            20,
            2,
        );
        insert_assistant(
            &conn,
            "a4",
            "s3",
            "p1",
            "2026-05-24T09:00:00Z",
            "claude-opus-4-7",
            999,
            99,
        );

        let rows = day_by_model(f.path(), "2026-05-25").unwrap();
        let opus = rows.iter().find(|r| r.model == "claude-opus-4-7").unwrap();
        assert_eq!(opus.input_tokens, 150);
        assert_eq!(opus.output_tokens, 15);
        let haiku = rows.iter().find(|r| r.model == "claude-haiku-4-5").unwrap();
        assert_eq!(haiku.input_tokens, 20);
        assert!(
            rows.iter().all(|r| r.input_tokens != 999),
            "yesterday leaked in"
        );
    }

    #[test]
    fn by_hour_buckets_on_utc_hour() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(
            &conn,
            "a1",
            "s1",
            "p1",
            "2026-05-25T09:15:00Z",
            "claude-opus-4-7",
            100,
            0,
        );
        insert_assistant(
            &conn,
            "a2",
            "s1",
            "p1",
            "2026-05-25T09:45:00Z",
            "claude-opus-4-7",
            100,
            0,
        );
        insert_assistant(
            &conn,
            "a3",
            "s2",
            "p2",
            "2026-05-25T14:00:00Z",
            "claude-haiku-4-5",
            10,
            0,
        );

        let rows = day_by_hour(f.path(), "2026-05-25").unwrap();
        let h9: i64 = rows
            .iter()
            .filter(|r| r.hour == 9)
            .map(|r| r.input_tokens)
            .sum();
        assert_eq!(h9, 200);
        let h14: i64 = rows
            .iter()
            .filter(|r| r.hour == 14)
            .map(|r| r.input_tokens)
            .sum();
        assert_eq!(h14, 10);
        assert!(rows.iter().all(|r| (0..24).contains(&r.hour)));
    }

    #[test]
    fn by_project_groups_project_and_model() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(
            &conn,
            "a1",
            "s1",
            "alpha",
            "2026-05-25T09:00:00Z",
            "claude-opus-4-7",
            100,
            0,
        );
        insert_assistant(
            &conn,
            "a2",
            "s2",
            "beta",
            "2026-05-25T10:00:00Z",
            "claude-opus-4-7",
            30,
            0,
        );

        let rows = day_by_project(f.path(), "2026-05-25").unwrap();
        assert!(rows
            .iter()
            .any(|r| r.project_slug == "alpha" && r.input_tokens == 100));
        assert!(rows
            .iter()
            .any(|r| r.project_slug == "beta" && r.input_tokens == 30));
    }

    #[test]
    fn sessions_have_earliest_started_and_turns() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(
            &conn,
            "a1",
            "s1",
            "alpha",
            "2026-05-25T10:00:00Z",
            "claude-opus-4-7",
            100,
            0,
        );
        insert_assistant(
            &conn,
            "a2",
            "s1",
            "alpha",
            "2026-05-25T09:00:00Z",
            "claude-opus-4-7",
            50,
            0,
        );
        insert_user(&conn, "u1", "s1", "2026-05-25T08:59:00Z", "first");
        insert_user(&conn, "u2", "s1", "2026-05-25T09:59:00Z", "second");

        let rows = day_by_session(f.path(), "2026-05-25").unwrap();
        let s1 = rows.iter().find(|r| r.session_id == "s1").unwrap();
        assert_eq!(s1.started, "2026-05-25T09:00:00Z");
        assert_eq!(s1.input_tokens, 150);

        let turns = day_session_turns(f.path(), "2026-05-25").unwrap();
        let t1 = turns.iter().find(|t| t.session_id == "s1").unwrap();
        assert_eq!(t1.turns, 2);
    }

    #[test]
    fn empty_day_returns_zero_and_empty() {
        let f = fresh_db();
        assert_eq!(
            day_totals(f.path(), "2026-05-25").unwrap(),
            DayTotals::default()
        );
        assert!(day_by_model(f.path(), "2026-05-25").unwrap().is_empty());
        assert!(day_by_hour(f.path(), "2026-05-25").unwrap().is_empty());
        assert!(day_by_project(f.path(), "2026-05-25").unwrap().is_empty());
        assert!(day_by_session(f.path(), "2026-05-25").unwrap().is_empty());
        assert!(day_session_turns(f.path(), "2026-05-25")
            .unwrap()
            .is_empty());
    }
}
