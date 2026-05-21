//! Session-cost anomaly detection.
//!
//! For each project, sum per-session cost over the last `days` days, then
//! compute the rolling mean + population stdev across that project's
//! sessions. Any session whose Z-score exceeds `k` is flagged.
//!
//! The candidate session is included in its own baseline (drags the mean
//! toward the outlier, slightly shrinks Z); acceptable for a coarse first
//! pass. A project needs at least 5 sessions in the window to produce any
//! anomaly — otherwise the sample is too small to trust.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::pricing::{cost_for, Pricing, Usage};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Anomaly {
    pub session_id: String,
    pub project_slug: String,
    pub cost_usd: f64,
    pub baseline_mean: f64,
    pub baseline_stdev: f64,
    pub z_score: f64,
    pub first_seen: String,
}

const MIN_SESSIONS: usize = 5;

/// Detect cost outliers across the last `days` days, flagging any session
/// whose cost is more than `k` standard deviations above its project's
/// rolling mean. Sorted by Z-score descending.
pub fn detect(conn: &Connection, days: u32, k: f64) -> rusqlite::Result<Vec<Anomaly>> {
    let cutoff = cutoff_iso(conn, days)?;
    let pricing = Pricing::embedded();

    let mut stmt = conn.prepare(
        "SELECT session_id, project_slug, model, MIN(timestamp), \
                SUM(input_tokens), SUM(output_tokens), \
                SUM(cache_read_tokens), SUM(cache_create_5m_tokens), \
                SUM(cache_create_1h_tokens) \
         FROM messages \
         WHERE type='assistant' AND timestamp >= ?1 \
         GROUP BY session_id, model",
    )?;

    // (project, total_cost, first_seen)
    let mut per_session: HashMap<String, (String, f64, String)> = HashMap::new();
    let rows = stmt.query_map(params![cutoff], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
        ))
    })?;
    for row in rows {
        let (session_id, project, model, ts, inp, out, cr, c5, c1) = row?;
        let cost = cost_for(
            model.as_deref().unwrap_or(""),
            &Usage {
                input_tokens: inp,
                output_tokens: out,
                cache_read_tokens: cr,
                cache_create_5m_tokens: c5,
                cache_create_1h_tokens: c1,
            },
            &pricing,
        )
        .usd
        .unwrap_or(0.0);
        let entry = per_session
            .entry(session_id)
            .or_insert_with(|| (project.clone(), 0.0, ts.clone()));
        entry.1 += cost;
        if ts < entry.2 {
            entry.2 = ts;
        }
    }

    let mut by_proj: HashMap<String, Vec<(String, f64, String)>> = HashMap::new();
    for (sid, (project, cost, ts)) in per_session {
        by_proj.entry(project).or_default().push((sid, cost, ts));
    }

    let mut out = Vec::new();
    for (project, sessions) in by_proj {
        if sessions.len() < MIN_SESSIONS {
            continue;
        }
        let n = sessions.len() as f64;
        let mean: f64 = sessions.iter().map(|s| s.1).sum::<f64>() / n;
        let var: f64 = sessions.iter().map(|s| (s.1 - mean).powi(2)).sum::<f64>() / n;
        let stdev = var.sqrt();
        if stdev == 0.0 {
            continue;
        }
        for (sid, cost, ts) in sessions {
            let z = (cost - mean) / stdev;
            if z > k {
                out.push(Anomaly {
                    session_id: sid,
                    project_slug: project.clone(),
                    cost_usd: round4(cost),
                    baseline_mean: round4(mean),
                    baseline_stdev: round4(stdev),
                    z_score: round2(z),
                    first_seen: ts,
                });
            }
        }
    }
    out.sort_by(|a, b| {
        b.z_score
            .partial_cmp(&a.z_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// Path-based wrapper used by the HTTP handler.
pub fn detect_db<P: AsRef<Path>>(db: P, days: u32, k: f64) -> rusqlite::Result<Vec<Anomaly>> {
    let conn = Connection::open(db.as_ref())?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    detect(&conn, days, k)
}

fn cutoff_iso(conn: &Connection, days: u32) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', ?1))",
        params![format!("-{} days", days)],
        |r| r.get(0),
    )
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().unwrap();
        init_db(f.path()).unwrap();
        f
    }

    fn insert(conn: &Connection, uuid: &str, sid: &str, project: &str, output: i64) {
        // Pin timestamps to "now - 1 day" so detect()'s 30-day cutoff
        // always captures them regardless of when the test runs.
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, ?2, ?3, 'assistant', \
                     strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', '-1 days')), \
                     'claude-opus-4-7', 0, ?4, 0, 0, 0)",
            params![uuid, sid, project, output],
        )
        .unwrap();
    }

    #[test]
    fn flags_only_outliers() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        // Population z-score for a single outlier among n−1 identical
        // baseline sessions is exactly sqrt(n−1). Need n ≥ 11 to clear
        // the k=3.0 threshold; use 12 (11 baseline + 1 outlier) for
        // comfortable margin (z ≈ 3.32).
        for i in 0..11 {
            insert(&c, &format!("u{i}"), &format!("s{i}"), "A", 1_000_000);
        }
        insert(&c, "uX", "sX", "A", 20_000_000);

        let rows = detect(&c, 30, 3.0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "sX");
        assert_eq!(rows[0].project_slug, "A");
        assert!(rows[0].z_score > 3.0, "z={}", rows[0].z_score);
    }

    #[test]
    fn returns_empty_when_baseline_too_small() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        insert(&c, "u", "s", "A", 1_000);
        let rows = detect(&c, 30, 3.0).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn returns_empty_when_no_variance() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        for i in 0..6 {
            insert(&c, &format!("u{i}"), &format!("s{i}"), "A", 1_000_000);
        }
        let rows = detect(&c, 30, 3.0).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn detect_db_wrapper_works() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        for i in 0..11 {
            insert(&c, &format!("u{i}"), &format!("s{i}"), "A", 1_000_000);
        }
        insert(&c, "uX", "sX", "A", 20_000_000);
        drop(c);

        let rows = detect_db(f.path(), 30, 3.0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "sX");
    }
}
