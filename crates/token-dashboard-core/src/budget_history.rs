//! Past-month budget summaries.
//!
//! For each of the last `months` months, aggregates total assistant spend
//! and computes percentage vs the **current** configured monthly budget.
//! We don't track historical budget changes (yet), so `budget_at_time`
//! is informational and reflects the present cap; revising history is a
//! follow-up if the user starts changing budgets often.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::params;
use serde::Serialize;

use crate::preferences;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MonthRow {
    /// `YYYY-MM`.
    pub month: String,
    pub total_cost_usd: f64,
    pub total_tokens: i64,
    /// The user's current monthly budget — repeated on every row for the UI's
    /// convenience. `None` when unset.
    pub budget_at_time: Option<f64>,
    /// `total_cost_usd / budget_at_time * 100`. `None` when no budget is set.
    pub percent: Option<f64>,
    /// Highest configured threshold the month's percent reached. Pulls
    /// thresholds from the persisted alerts config (defaults 50/80/100).
    /// `None` when no budget or when no threshold was reached.
    pub max_threshold_fired: Option<u32>,
}

/// Per-month totals for the trailing `months` calendar months (including
/// the current one). Sorted ascending by month so the UI can render
/// oldest → newest as a typical timeline.
pub fn history<P: AsRef<Path>>(db: P, months: u32) -> rusqlite::Result<Vec<MonthRow>> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    // USD budgets don't apply on subscription plans (Pro/Max/Team/etc.) —
    // hide them in History so the % and threshold columns don't pretend
    // to constrain spend they don't actually cap.
    let plan = crate::queries::get_plan(db).unwrap_or_else(|_| "api".to_string());
    let budget_at_time = if plan == "api" {
        preferences::get_budgets(db)?.monthly
    } else {
        None
    };
    let thresholds = crate::budget_alerts::get_config(db)
        .map(|c| {
            let mut t = c.thresholds;
            t.sort();
            t
        })
        .unwrap_or_else(|_| vec![50, 80, 100]);

    let offset = format!("-{} months", months.max(1) as i64);
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', timestamp) AS m, model, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' \
           AND timestamp >= date('now', ?1) \
         GROUP BY m, model",
    )?;

    let mut by_month: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    let rows = stmt.query_map(params![offset], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    for row in rows {
        let (m, model, inp, out, cr, c5, c1) = row?;
        let tokens = inp + out + cr + c5 + c1;
        let usage = Usage {
            input_tokens: inp,
            output_tokens: out,
            cache_read_tokens: cr,
            cache_create_5m_tokens: c5,
            cache_create_1h_tokens: c1,
        };
        let cost = match model.as_deref() {
            Some(m) => cost_for(m, &usage, &pricing).usd.unwrap_or(0.0),
            None => 0.0,
        };
        let entry = by_month.entry(m).or_insert((0.0, 0));
        entry.0 += cost;
        entry.1 += tokens;
    }

    let mut out: Vec<MonthRow> = by_month
        .into_iter()
        .map(|(month, (cost, tokens))| {
            let (percent, max_threshold_fired) = match budget_at_time {
                Some(b) if b > 0.0 => {
                    let pct = (cost / b) * 100.0;
                    let max = thresholds.iter().rev().find(|t| pct >= **t as f64).copied();
                    (Some(pct), max)
                }
                _ => (None, None),
            };
            MonthRow {
                month,
                total_cost_usd: cost,
                total_tokens: tokens,
                budget_at_time,
                percent,
                max_threshold_fired,
            }
        })
        .collect();
    // BTreeMap iteration is already sorted ascending; clamp to `months` rows.
    if out.len() > months as usize {
        let drop = out.len() - months as usize;
        out.drain(0..drop);
    }
    Ok(out)
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

    fn insert_assistant(conn: &Connection, uuid: &str, timestamp: &str, output: i64) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's', 'p', 'assistant', ?2, 'claude-opus-4-7', 0, ?3, 0, 0, 0)",
            params![uuid, timestamp, output],
        )
        .unwrap();
    }

    fn set_monthly_budget(conn: &Connection, usd: f64) {
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('budget_monthly_usd', ?1)",
            params![usd.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn aggregates_per_month() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // Current month + previous month
        let cur_month: String = conn
            .query_row("SELECT strftime('%Y-%m', 'now')", [], |r| r.get(0))
            .unwrap();
        let prev_month: String = conn
            .query_row("SELECT strftime('%Y-%m', 'now', '-1 months')", [], |r| {
                r.get(0)
            })
            .unwrap();
        insert_assistant(&conn, "a", &format!("{cur_month}-15T12:00:00Z"), 1_000_000);
        insert_assistant(&conn, "b", &format!("{prev_month}-15T12:00:00Z"), 2_000_000);
        drop(conn);
        let rows = history(f.path(), 6).unwrap();
        assert!(rows.iter().any(|r| r.month == cur_month));
        assert!(rows.iter().any(|r| r.month == prev_month));
    }

    #[test]
    fn percent_and_threshold_use_current_budget() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        let per_m = cost_for(
            "claude-opus-4-7",
            &Usage {
                output_tokens: 1_000_000,
                ..Default::default()
            },
            &Pricing::embedded(),
        )
        .usd
        .unwrap();
        let cur_month: String = conn
            .query_row("SELECT strftime('%Y-%m', 'now')", [], |r| r.get(0))
            .unwrap();
        insert_assistant(&conn, "a", &format!("{cur_month}-15T12:00:00Z"), 1_000_000);
        // Budget = 2x this month's cost → ~50%, should fire the 50 threshold.
        set_monthly_budget(&conn, per_m * 2.0);
        drop(conn);
        let rows = history(f.path(), 3).unwrap();
        let row = rows.iter().find(|r| r.month == cur_month).unwrap();
        assert!(row.percent.is_some());
        assert!((row.percent.unwrap() - 50.0).abs() < 1.0);
        assert_eq!(row.max_threshold_fired, Some(50));
    }

    #[test]
    fn no_budget_means_no_threshold() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        let cur_month: String = conn
            .query_row("SELECT strftime('%Y-%m', 'now')", [], |r| r.get(0))
            .unwrap();
        insert_assistant(&conn, "a", &format!("{cur_month}-15T12:00:00Z"), 1_000_000);
        drop(conn);
        let rows = history(f.path(), 3).unwrap();
        let row = rows.iter().find(|r| r.month == cur_month).unwrap();
        assert!(row.percent.is_none());
        assert!(row.max_threshold_fired.is_none());
    }
}
