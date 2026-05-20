//! Cache hit-rate trend over a recent window of days.
//!
//! Hit rate is `cache_read / (input + cache_read)` per day (token-weighted),
//! computed from assistant messages only. `cache_create_*` tokens are
//! deliberately excluded from the denominator — those are misses being
//! seeded, not lookups.

use std::path::Path;

use rusqlite::params;
use serde::Serialize;

use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DailyCache {
    pub date: String,
    pub input: i64,
    pub cache_read: i64,
    pub cache_create_5m: i64,
    pub cache_create_1h: i64,
    pub hit_rate: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CacheTrend {
    pub days: Vec<DailyCache>,
    pub avg_7d: f64,
    pub avg_30d: f64,
}

/// Aggregate per-day cache-token totals over the last `days` days and
/// return alongside 7d and 30d token-weighted averages.
pub fn cache_trend<P: AsRef<Path>>(db: P, days: u32) -> rusqlite::Result<CacheTrend> {
    let conn = open_ro(db)?;
    let offset = format!("-{} days", days.max(1) as i64);
    let mut stmt = conn.prepare(
        "SELECT substr(timestamp, 1, 10) AS day, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' \
           AND substr(timestamp, 1, 10) >= date('now', ?1) \
         GROUP BY day ORDER BY day",
    )?;
    let rows = stmt.query_map(params![offset], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    let mut days_rows: Vec<DailyCache> = Vec::new();
    for row in rows {
        let (date, input, cache_read, c5, c1) = row?;
        let denom = input + cache_read;
        let hit_rate = if denom > 0 {
            cache_read as f64 / denom as f64
        } else {
            0.0
        };
        days_rows.push(DailyCache {
            date,
            input,
            cache_read,
            cache_create_5m: c5,
            cache_create_1h: c1,
            hit_rate,
        });
    }

    let avg = |window: usize| -> f64 {
        let (cr, denom) = days_rows
            .iter()
            .rev()
            .take(window)
            .fold((0i64, 0i64), |(cr, dn), d| {
                (cr + d.cache_read, dn + d.cache_read + d.input)
            });
        if denom > 0 {
            cr as f64 / denom as f64
        } else {
            0.0
        }
    };

    Ok(CacheTrend {
        avg_7d: avg(7),
        avg_30d: avg(30),
        days: days_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::Connection;
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().expect("tempfile");
        init_db(f.path()).expect("init");
        f
    }

    fn insert_msg(conn: &Connection, uuid: &str, timestamp: &str, input: i64, cache_read: i64) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's1', 'p1', 'assistant', ?2, 'claude-opus-4-7', \
                     ?3, 0, ?4, 0, 0)",
            params![uuid, timestamp, input, cache_read],
        )
        .unwrap();
    }

    fn today_iso(offset_days: i64) -> String {
        // Use SQLite to compute the date — keeps the test in lock-step with
        // the production SQL, which also calls date('now', ...).
        let conn = Connection::open_in_memory().unwrap();
        let s: String = conn
            .query_row(
                "SELECT date('now', ?1)",
                params![format!("{} days", offset_days)],
                |r| r.get(0),
            )
            .unwrap();
        format!("{s}T12:00:00Z")
    }

    #[test]
    fn computes_per_day_hit_rate() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // Yesterday: 100 input + 900 cache_read => hit_rate 0.9
        insert_msg(&conn, "u1", &today_iso(-1), 100, 900);
        // Today: 200 input + 200 cache_read => hit_rate 0.5
        insert_msg(&conn, "u2", &today_iso(0), 200, 200);

        let t = cache_trend(f.path(), 30).unwrap();
        assert_eq!(t.days.len(), 2, "expected 2 day rows, got {t:?}");
        let yesterday_date = today_iso(-1)[..10].to_string();
        let today_date = today_iso(0)[..10].to_string();
        let d1 = t
            .days
            .iter()
            .find(|d| d.date == yesterday_date)
            .expect("yesterday row");
        assert!(
            (d1.hit_rate - 0.9).abs() < 1e-9,
            "yesterday hit_rate {}",
            d1.hit_rate
        );
        let d2 = t
            .days
            .iter()
            .find(|d| d.date == today_date)
            .expect("today row");
        assert!((d2.hit_rate - 0.5).abs() < 1e-9);
    }

    #[test]
    fn averages_weighted_by_tokens() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_msg(&conn, "u1", &today_iso(-1), 100, 900);
        insert_msg(&conn, "u2", &today_iso(0), 200, 200);
        // total cache_read = 1100, total (input+cache_read) = 1400; 1100/1400
        let t = cache_trend(f.path(), 30).unwrap();
        let expected = 1100.0 / 1400.0;
        assert!((t.avg_30d - expected).abs() < 1e-9, "avg_30d={}", t.avg_30d);
        // avg_7d uses the same data (both rows are within 7d)
        assert!((t.avg_7d - expected).abs() < 1e-9);
    }

    #[test]
    fn empty_db_returns_zero_averages_and_empty_days() {
        let f = fresh_db();
        let t = cache_trend(f.path(), 30).unwrap();
        assert!(t.days.is_empty());
        assert_eq!(t.avg_7d, 0.0);
        assert_eq!(t.avg_30d, 0.0);
    }

    #[test]
    fn excludes_messages_outside_window() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // Recent
        insert_msg(&conn, "recent", &today_iso(-1), 100, 100);
        // Far in the past
        insert_msg(&conn, "old", "2024-01-01T12:00:00Z", 100, 9999);
        let t = cache_trend(f.path(), 30).unwrap();
        assert_eq!(t.days.len(), 1, "old row should be filtered out");
        assert!((t.avg_30d - 0.5).abs() < 1e-9);
    }
}
