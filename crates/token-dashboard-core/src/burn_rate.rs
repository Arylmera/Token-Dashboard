//! Burn-rate projection.
//!
//! From the last `window_days` of assistant message spend (token-priced),
//! computes the average daily cost and projects how many days remain until
//! the configured monthly budget is exhausted, accounting for month-to-date
//! spend that already counts against the budget.
//!
//! Cost math reuses [`crate::pricing::cost_for`]; budget reuses
//! [`crate::preferences::get_budgets`]. The output is shaped for the
//! Overview burn-rate card.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::preferences;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DailySpend {
    pub date: String,
    pub cost_usd: f64,
    pub tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BurnRate {
    pub window_days: u32,
    pub avg_daily_cost_usd: f64,
    pub avg_daily_tokens: i64,
    /// `None` when the user has not configured `budget_monthly_usd`.
    pub monthly_budget_usd: Option<f64>,
    /// Spend since the first of the current month (UTC).
    pub mtd_cost_usd: f64,
    /// Days until the monthly budget is exhausted at the current burn rate.
    /// `None` when no budget is set or burn rate is zero.
    pub days_remaining: Option<f64>,
    /// ISO date (`YYYY-MM-DD`) the budget is projected to be exhausted.
    pub projected_exhaustion_date: Option<String>,
    pub daily_series: Vec<DailySpend>,
}

/// Compute the burn-rate projection from the on-disk DB at `db`.
pub fn burn_rate<P: AsRef<Path>>(db: P, window_days: u32) -> rusqlite::Result<BurnRate> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let budgets = preferences::get_budgets(db)?;
    let window = window_days.max(1);

    let daily_series = aggregate_daily(&conn, &pricing, window)?;
    let total_cost: f64 = daily_series.iter().map(|d| d.cost_usd).sum();
    let total_tokens: i64 = daily_series.iter().map(|d| d.tokens).sum();
    let divisor = window as f64;
    let avg_daily_cost_usd = total_cost / divisor;
    let avg_daily_tokens = ((total_tokens as f64) / divisor) as i64;

    let mtd_cost_usd = mtd_cost(&conn, &pricing)?;

    let (days_remaining, projected_exhaustion_date) = match budgets.monthly {
        Some(b) if avg_daily_cost_usd > 0.0 => {
            let remaining_usd = (b - mtd_cost_usd).max(0.0);
            let days = remaining_usd / avg_daily_cost_usd;
            let offset = format!("+{} days", days as i64);
            let date: Option<String> = conn
                .query_row("SELECT date('now', ?1)", params![offset], |r| r.get(0))
                .ok();
            (Some(days), date)
        }
        _ => (None, None),
    };

    Ok(BurnRate {
        window_days: window,
        avg_daily_cost_usd,
        avg_daily_tokens,
        monthly_budget_usd: budgets.monthly,
        mtd_cost_usd,
        days_remaining,
        projected_exhaustion_date,
        daily_series,
    })
}

fn aggregate_daily(
    conn: &Connection,
    pricing: &Pricing,
    window: u32,
) -> rusqlite::Result<Vec<DailySpend>> {
    let offset = format!("-{} days", window as i64);
    let mut stmt = conn.prepare(
        "SELECT substr(timestamp, 1, 10) AS day, model, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' \
           AND substr(timestamp, 1, 10) >= date('now', ?1) \
         GROUP BY day, model \
         ORDER BY day",
    )?;
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
    let mut by_day: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    for row in rows {
        let (day, model, inp, out, cr, c5, c1) = row?;
        let usage = Usage {
            input_tokens: inp,
            output_tokens: out,
            cache_read_tokens: cr,
            cache_create_5m_tokens: c5,
            cache_create_1h_tokens: c1,
        };
        let cost = match model.as_deref() {
            Some(m) => cost_for(m, &usage, pricing).usd.unwrap_or(0.0),
            None => 0.0,
        };
        let entry = by_day.entry(day).or_insert((0.0, 0));
        entry.0 += cost;
        entry.1 += inp + out + cr + c5 + c1;
    }
    Ok(by_day
        .into_iter()
        .map(|(d, (c, t))| DailySpend {
            date: d,
            cost_usd: c,
            tokens: t,
        })
        .collect())
}

fn mtd_cost(conn: &Connection, pricing: &Pricing) -> rusqlite::Result<f64> {
    let mut stmt = conn.prepare(
        "SELECT model, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' \
           AND substr(timestamp, 1, 10) >= strftime('%Y-%m-01', 'now') \
         GROUP BY model",
    )?;
    let mut total = 0.0;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
        ))
    })?;
    for row in rows {
        let (model, inp, out, cr, c5, c1) = row?;
        let usage = Usage {
            input_tokens: inp,
            output_tokens: out,
            cache_read_tokens: cr,
            cache_create_5m_tokens: c5,
            cache_create_1h_tokens: c1,
        };
        if let Some(m) = model {
            total += cost_for(&m, &usage, pricing).usd.unwrap_or(0.0);
        }
    }
    Ok(total)
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

    fn date_offset(days: i64) -> String {
        let c = Connection::open_in_memory().unwrap();
        c.query_row(
            "SELECT date('now', ?1)",
            params![format!("{} days", days)],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
    }

    fn insert_assistant(conn: &Connection, uuid: &str, timestamp: &str, model: &str, output: i64) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's', 'p', 'assistant', ?2, ?3, 0, ?4, 0, 0, 0)",
            params![uuid, timestamp, model, output],
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
    fn averages_cost_over_window() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // 7 days x 1M output tokens on opus-4-7 ($25/M output) = $25/day.
        for d in 0..7 {
            insert_assistant(
                &conn,
                &format!("u{d}"),
                &format!("{}T12:00:00Z", date_offset(-(d as i64))),
                "claude-opus-4-7",
                1_000_000,
            );
        }
        drop(conn);
        let br = burn_rate(f.path(), 7).unwrap();
        let expected = (1.0 / 1_000_000.0)
            * cost_for(
                "claude-opus-4-7",
                &Usage {
                    output_tokens: 1_000_000,
                    ..Default::default()
                },
                &Pricing::embedded(),
            )
            .usd
            .unwrap()
            * 1_000_000.0;
        assert!(
            (br.avg_daily_cost_usd - expected).abs() < 0.01,
            "avg_daily_cost_usd={} expected~{}",
            br.avg_daily_cost_usd,
            expected
        );
        assert_eq!(br.daily_series.len(), 7);
    }

    #[test]
    fn days_remaining_subtracts_mtd_spend() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // 5 daily rows: each row's cost = price-per-output-token * 1M.
        for d in 0..5 {
            insert_assistant(
                &conn,
                &format!("u{d}"),
                &format!("{}T12:00:00Z", date_offset(-(d as i64))),
                "claude-opus-4-7",
                1_000_000,
            );
        }
        let per_day = cost_for(
            "claude-opus-4-7",
            &Usage {
                output_tokens: 1_000_000,
                ..Default::default()
            },
            &Pricing::embedded(),
        )
        .usd
        .unwrap();
        let budget = per_day * 50.0; // generous budget so days_remaining is comfortably positive
        set_monthly_budget(&conn, budget);
        drop(conn);

        let br = burn_rate(f.path(), 7).unwrap();
        let expected_mtd = per_day * 5.0;
        let expected_avg = expected_mtd / 7.0;
        let expected_days = (budget - expected_mtd) / expected_avg;
        let days = br.days_remaining.expect("days_remaining set");
        assert!(
            (br.mtd_cost_usd - expected_mtd).abs() < 0.01,
            "mtd_cost_usd={}",
            br.mtd_cost_usd
        );
        assert!(
            (days - expected_days).abs() < 0.5,
            "days_remaining={days} expected~{expected_days}"
        );
        assert!(br.projected_exhaustion_date.is_some());
    }

    #[test]
    fn no_budget_returns_none_remaining() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(&conn, "u1", &date_offset(-1), "claude-opus-4-7", 1_000_000);
        drop(conn);
        let br = burn_rate(f.path(), 7).unwrap();
        assert!(br.days_remaining.is_none());
        assert!(br.projected_exhaustion_date.is_none());
        assert!(br.monthly_budget_usd.is_none());
    }

    #[test]
    fn zero_spend_returns_none_remaining_even_with_budget() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_monthly_budget(&conn, 100.0);
        drop(conn);
        let br = burn_rate(f.path(), 7).unwrap();
        assert_eq!(br.avg_daily_cost_usd, 0.0);
        assert!(br.days_remaining.is_none());
    }
}
