//! Stuck-loop detector.
//!
//! Walks `tool_calls` ordered by `(session_id, timestamp)` and groups
//! consecutive runs of the same `(tool_name, target)`. A run of length
//! ≥ `min_run` is reported as a [`StuckRun`] — the strongest signal
//! that a session got stuck retrying the same tool against the same
//! target. Non-consecutive repeats (e.g. interleaved with other calls)
//! are intentionally not flagged on this pass: those usually mean an
//! intentional retry with a fix in between.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct StuckRun {
    pub session_id: String,
    pub tool_name: String,
    pub target: String,
    pub count: u32,
    pub errors: u32,
    pub first_seen: String,
    pub last_seen: String,
}

fn cutoff_iso(days: u32) -> String {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let secs = now_secs - (days as i64) * 86_400;
    iso_from_unix(secs)
}

fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400);
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    days += 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Group consecutive identical `(tool_name, target)` rows per session
/// within the trailing `days` window, returning every run whose length
/// reaches `min_run`. Sorted by count desc.
pub fn detect(conn: &Connection, min_run: u32, days: u32) -> rusqlite::Result<Vec<StuckRun>> {
    let cutoff = cutoff_iso(days);
    let mut stmt = conn.prepare(
        "SELECT session_id, tool_name, COALESCE(target, ''), is_error, timestamp \
         FROM tool_calls \
         WHERE timestamp >= ?1 \
         ORDER BY session_id, timestamp, id",
    )?;
    let rows: Vec<(String, String, String, u32, String)> = stmt
        .query_map(rusqlite::params![cutoff], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)? as u32,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out: Vec<StuckRun> = Vec::new();
    let mut cur: Option<StuckRun> = None;
    fn flush(out: &mut Vec<StuckRun>, run: Option<StuckRun>, min_run: u32) {
        if let Some(r) = run {
            if r.count >= min_run {
                out.push(r);
            }
        }
    }
    for (session_id, tool, target, is_error, ts) in rows {
        let matches = cur.as_ref().is_some_and(|r| {
            r.session_id == session_id && r.tool_name == tool && r.target == target
        });
        if matches {
            let r = cur.as_mut().unwrap();
            r.count += 1;
            r.errors += is_error;
            r.last_seen = ts;
        } else {
            flush(&mut out, cur.take(), min_run);
            cur = Some(StuckRun {
                session_id,
                tool_name: tool,
                target,
                count: 1,
                errors: is_error,
                first_seen: ts.clone(),
                last_seen: ts,
            });
        }
    }
    flush(&mut out, cur, min_run);
    out.sort_by_key(|r| std::cmp::Reverse(r.count));
    Ok(out)
}

/// Path-based convenience wrapper for HTTP handlers.
pub fn detect_path<P: AsRef<Path>>(
    db: P,
    min_run: u32,
    days: u32,
) -> rusqlite::Result<Vec<StuckRun>> {
    let conn = Connection::open(db.as_ref())?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    detect(&conn, min_run, days)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn fresh() -> (NamedTempFile, Connection) {
        let f = NamedTempFile::new().expect("tempfile");
        crate::db::init_db(f.path()).expect("init");
        let c = Connection::open(f.path()).expect("open");
        (f, c)
    }

    fn seed(c: &Connection) {
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
             input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES ('m1','s','p','assistant','2026-05-20T10:00:00Z','x',0,0,0,0,0)",
            [],
        )
        .unwrap();
        for i in 0..5 {
            c.execute(
                "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, is_error, timestamp) \
                 VALUES ('m1','s','p','Bash','npm test',?,0,1,?)",
                rusqlite::params![format!("t{i}"), format!("2026-05-20T10:00:0{}Z", i)],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, is_error, timestamp) \
             VALUES ('m1','s','p','Read','x.rs','tr',0,0,'2026-05-20T10:00:10Z')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn detects_run_of_three_or_more_identical_calls() {
        let (_f, c) = fresh();
        seed(&c);
        let runs = detect(&c, 3, 100_000).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].tool_name, "Bash");
        assert_eq!(runs[0].target, "npm test");
        assert_eq!(runs[0].count, 5);
        assert_eq!(runs[0].errors, 5);
        assert_eq!(runs[0].session_id, "s");
    }

    #[test]
    fn ignores_runs_below_min_run() {
        let (_f, c) = fresh();
        seed(&c);
        let runs = detect(&c, 6, 100_000).unwrap();
        assert!(runs.is_empty());
    }

    #[test]
    fn groups_per_session() {
        let (_f, c) = fresh();
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
             input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES ('m1','sA','p','assistant','2026-05-20T10:00:00Z','x',0,0,0,0,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
             input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES ('m2','sB','p','assistant','2026-05-20T11:00:00Z','x',0,0,0,0,0)",
            [],
        )
        .unwrap();
        for i in 0..3 {
            c.execute(
                "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, is_error, timestamp) \
                 VALUES ('m1','sA','p','Bash','x',?,0,0,?)",
                rusqlite::params![format!("a{i}"), format!("2026-05-20T10:00:0{}Z", i)],
            )
            .unwrap();
        }
        for i in 0..4 {
            c.execute(
                "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, use_id, result_tokens, is_error, timestamp) \
                 VALUES ('m2','sB','p','Bash','x',?,0,1,?)",
                rusqlite::params![format!("b{i}"), format!("2026-05-20T11:00:0{}Z", i)],
            )
            .unwrap();
        }
        let runs = detect(&c, 3, 100_000).unwrap();
        assert_eq!(runs.len(), 2);
        // Sorted by count desc — sB's run of 4 comes first.
        assert_eq!(runs[0].session_id, "sB");
        assert_eq!(runs[0].count, 4);
        assert_eq!(runs[0].errors, 4);
        assert_eq!(runs[1].session_id, "sA");
        assert_eq!(runs[1].count, 3);
        assert_eq!(runs[1].errors, 0);
    }
}
