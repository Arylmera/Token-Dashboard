//! Burn-rate projection.
//!
//! From the last `window_days` of assistant message spend (token-priced),
//! computes the average daily cost. The "days remaining" projection
//! dispatches on the user's plan:
//!
//! - **API plan**: subtract month-to-date spend from the configured monthly
//!   USD budget, divide by average daily cost.
//! - **Subscription** (Pro / Max / Team / etc.): subtract weekly-window
//!   sonnet-equivalent token usage from the plan cap, divide by the active
//!   window's per-day burn rate, then clamp to time-until-reset. Surfaces
//!   the more pressing of "hit the cap" vs "reach the next reset".
//!
//! Cost math reuses [`crate::pricing::cost_for`]; subscription window math
//! reuses [`crate::limits::compute_limits`]. The output is shaped for the
//! Overview burn-rate card.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::limits::{compute_limits, LimitWindow};
use crate::preferences;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::{get_plan, open_ro};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DailySpend {
    pub date: String,
    pub cost_usd: f64,
    pub tokens: i64,
}

/// What `days_remaining` is counting down toward, so the UI can label the
/// card appropriately.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CapMode {
    /// Subscription plan + weekly token cap available; days are how long
    /// until either the cap is exhausted or the window resets, whichever
    /// comes first.
    WeeklyTokens,
    /// Subscription plan without a projectable token cap; days are how
    /// long until the weekly window resets. Honest fallback that matches
    /// what subscription users actually care about.
    WeeklyReset,
    /// API plan with `budget_monthly_usd` configured.
    UsdMonthly,
    /// No projection available — API plan with no budget, or subscription
    /// plan with no anchor / reset known.
    None,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BurnRate {
    pub window_days: u32,
    pub avg_daily_cost_usd: f64,
    pub avg_daily_tokens: i64,
    pub plan: String,
    pub cap_mode: CapMode,
    /// `None` when the user has not configured `budget_monthly_usd`.
    pub monthly_budget_usd: Option<f64>,
    /// Spend since the first of the current month (UTC).
    pub mtd_cost_usd: f64,
    /// Subscription-only: sonnet-equivalent weekly token cap.
    pub weekly_cap_tokens: Option<i64>,
    /// Subscription-only: sonnet-equivalent tokens used in the active
    /// weekly window.
    pub weekly_used_tokens: Option<i64>,
    /// Subscription-only: ISO timestamp when the weekly window resets.
    pub weekly_resets_at: Option<String>,
    /// Days until the cap is exhausted at the current burn rate, clamped
    /// (for subscription) to days-until-reset. `None` when no cap is
    /// configured or the burn rate is zero.
    pub days_remaining: Option<f64>,
    /// ISO date (`YYYY-MM-DD`) the cap is projected to be exhausted.
    pub projected_exhaustion_date: Option<String>,
    pub daily_series: Vec<DailySpend>,
}

/// Compute the burn-rate projection from the on-disk DB at `db`.
pub fn burn_rate<P: AsRef<Path>>(db: P, window_days: u32) -> rusqlite::Result<BurnRate> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let plan = get_plan(db).unwrap_or_else(|_| "max".to_string());
    let budgets = preferences::get_budgets(db)?;
    let window = window_days.max(1);

    let daily_series = aggregate_daily(&conn, &pricing, window)?;
    let total_cost: f64 = daily_series.iter().map(|d| d.cost_usd).sum();
    let total_tokens: i64 = daily_series.iter().map(|d| d.tokens).sum();
    let divisor = window as f64;
    let avg_daily_cost_usd = total_cost / divisor;
    let avg_daily_tokens = ((total_tokens as f64) / divisor) as i64;

    let mtd_cost_usd = mtd_cost(&conn, &pricing)?;

    // Default outputs; both branches below fill them in when applicable.
    let mut cap_mode = CapMode::None;
    let mut days_remaining: Option<f64> = None;
    let mut projected_exhaustion_date: Option<String> = None;
    let mut weekly_cap_tokens: Option<i64> = None;
    let mut weekly_used_tokens: Option<i64> = None;
    let mut weekly_resets_at: Option<String> = None;

    // Subscription plans: project against the weekly window. Order of
    // preference:
    //   1. WeeklyTokens — we have cap + anchor + recent usage, so we can
    //      give a real "you'll hit the cap in N days" answer.
    //   2. WeeklyReset — no projectable cap, but we know when the window
    //      resets. That's the actual constraint subscription users care
    //      about (they get a fresh cap on reset). Counting down to it is
    //      honest and useful.
    //   3. Fall through to USD-budget math only if no weekly info exists.
    if plan != "api" {
        if let Ok(snap) = compute_limits(db, &pricing) {
            weekly_cap_tokens = snap.weekly.cap;
            weekly_used_tokens = Some(snap.weekly.used);
            weekly_resets_at = snap.weekly.resets_at.clone();
            if let (Some(days), date) = subscription_days_remaining(&conn, &snap.weekly) {
                days_remaining = Some(days);
                projected_exhaustion_date = date;
                cap_mode = CapMode::WeeklyTokens;
            } else if let Some(reset_at) = snap.weekly.resets_at.as_deref() {
                let days_to_reset: Option<f64> = conn
                    .query_row(
                        "SELECT julianday(?1) - julianday('now')",
                        params![reset_at],
                        |r| r.get(0),
                    )
                    .ok()
                    .filter(|d: &f64| *d > 0.0);
                if let Some(days) = days_to_reset {
                    days_remaining = Some(days);
                    projected_exhaustion_date = Some(reset_at[..10].to_string());
                    cap_mode = CapMode::WeeklyReset;
                }
            }
        }
    }

    // API plan (or subscription with no weekly info) falls back to USD math.
    if matches!(cap_mode, CapMode::None) {
        if let Some(budget) = budgets.monthly {
            if avg_daily_cost_usd > 0.0 {
                let remaining_usd = (budget - mtd_cost_usd).max(0.0);
                let days = remaining_usd / avg_daily_cost_usd;
                projected_exhaustion_date = exhaust_date(&conn, days);
                days_remaining = Some(days);
                cap_mode = CapMode::UsdMonthly;
            }
        }
    }

    Ok(BurnRate {
        window_days: window,
        avg_daily_cost_usd,
        avg_daily_tokens,
        plan,
        cap_mode,
        monthly_budget_usd: budgets.monthly,
        mtd_cost_usd,
        weekly_cap_tokens,
        weekly_used_tokens,
        weekly_resets_at,
        days_remaining,
        projected_exhaustion_date,
        daily_series,
    })
}

/// Subscription-plan days-remaining. Tries two paths in order:
///
/// 1. **Token math** (JSONL source): we have a cap and a used count, so
///    `days_to_cap = remaining_tokens / (used / hours_since_anchor)`.
/// 2. **Percent math** (OAuth source): no cap, but Anthropic's
///    rate-limit headers give us `pct_used` for the active window. At the
///    current rate, project when `pct_used` hits 100%. This is the path
///    that catches "you'll throttle before the weekly reset" for users
///    whose plan has no hardcoded cap in `pricing.json`.
///
/// Both paths clamp to days-until-reset so we never project past the
/// window boundary, and return `None` when we don't have enough signal.
fn subscription_days_remaining(
    conn: &Connection,
    weekly: &LimitWindow,
) -> (Option<f64>, Option<String>) {
    let Some(anchor) = weekly.anchor.as_deref() else {
        return (None, None);
    };
    // SQLite julianday handles ISO timestamps directly. Use it everywhere
    // so we stay aligned with the rest of the codebase's date handling
    // (no chrono dep on core).
    let days_since_anchor: f64 = conn
        .query_row(
            "SELECT julianday('now') - julianday(?1)",
            params![anchor],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    if days_since_anchor <= 0.0 {
        return (None, None);
    }
    // Floor at 1 hour to avoid a fresh window producing absurd burn rates.
    let elapsed = days_since_anchor.max(1.0 / 24.0);

    let days_to_cap: Option<f64> = match weekly.cap {
        // Path 1: token math (JSONL source)
        Some(cap) if cap > 0 && weekly.used > 0 => {
            let daily_burn_tokens = weekly.used as f64 / elapsed;
            if daily_burn_tokens > 0.0 {
                let remaining_tokens = (cap - weekly.used).max(0) as f64;
                Some(remaining_tokens / daily_burn_tokens)
            } else {
                None
            }
        }
        // Path 2: percent math (OAuth source). pct_used arrives in 0.0..1.0
        // and ticks up faster the harder you push.
        _ if weekly.pct_used > 0.0 && weekly.pct_used < 1.0 => {
            let daily_pct_burn = weekly.pct_used / elapsed;
            if daily_pct_burn > 0.0 {
                let remaining_pct = (1.0 - weekly.pct_used).max(0.0);
                Some(remaining_pct / daily_pct_burn)
            } else {
                None
            }
        }
        _ => None,
    };

    let Some(days_to_cap) = days_to_cap else {
        return (None, None);
    };

    let days_to_reset = weekly
        .resets_at
        .as_deref()
        .and_then(|reset_at| {
            conn.query_row(
                "SELECT julianday(?1) - julianday('now')",
                params![reset_at],
                |r| r.get::<_, f64>(0),
            )
            .ok()
        })
        .filter(|d| *d > 0.0);

    let days = match days_to_reset {
        Some(reset) => days_to_cap.min(reset),
        None => days_to_cap,
    };
    if !days.is_finite() || days < 0.0 {
        return (None, None);
    }
    (Some(days), exhaust_date(conn, days))
}

fn exhaust_date(conn: &Connection, days: f64) -> Option<String> {
    if !days.is_finite() {
        return None;
    }
    let offset = format!("+{} days", days as i64);
    conn.query_row("SELECT date('now', ?1)", params![offset], |r| r.get(0))
        .ok()
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

    fn set_plan(conn: &Connection, plan: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('plan', ?1)",
            params![plan],
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
    fn days_remaining_subtracts_mtd_spend_on_api_plan() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // The USD-budget projection only applies on API plan.
        set_plan(&conn, "api");
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
        assert_eq!(br.cap_mode, CapMode::UsdMonthly);
    }

    #[test]
    fn no_budget_returns_none_remaining_on_api_plan() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_plan(&conn, "api");
        insert_assistant(&conn, "u1", &date_offset(-1), "claude-opus-4-7", 1_000_000);
        drop(conn);
        let br = burn_rate(f.path(), 7).unwrap();
        assert!(br.days_remaining.is_none());
        assert!(br.projected_exhaustion_date.is_none());
        assert!(br.monthly_budget_usd.is_none());
        assert_eq!(br.cap_mode, CapMode::None);
    }

    #[test]
    fn zero_spend_returns_none_remaining_even_with_budget() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_plan(&conn, "api");
        set_monthly_budget(&conn, 100.0);
        drop(conn);
        let br = burn_rate(f.path(), 7).unwrap();
        assert_eq!(br.avg_daily_cost_usd, 0.0);
        assert!(br.days_remaining.is_none());
        assert_eq!(br.cap_mode, CapMode::None);
    }

    #[test]
    fn subscription_projects_against_weekly_cap() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_plan(&conn, "max");
        // Drop a sonnet-flavoured message recently so limits::compute_limits
        // returns a non-idle weekly window with positive used tokens. The
        // five-hour anchor falls out of the first assistant message in the
        // last 5h; sonnet weight = 1 so used = output tokens.
        insert_assistant(
            &conn,
            "u-fresh",
            &format!("{}T12:00:00Z", date_offset(0)),
            "claude-sonnet-4-6",
            1_000_000,
        );
        // Older daily rows over the burn window so avg_daily_cost_usd > 0
        // (not strictly required for subscription branch, but exercises the
        // dual data paths).
        for d in 1..6 {
            insert_assistant(
                &conn,
                &format!("u-{d}"),
                &format!("{}T08:00:00Z", date_offset(-(d as i64))),
                "claude-sonnet-4-6",
                500_000,
            );
        }
        drop(conn);

        let br = burn_rate(f.path(), 7).unwrap();
        assert_eq!(br.plan, "max");
        // Either WeeklyTokens (if pricing has a Max cap) or None (if pricing
        // doesn't ship one for Max) — both are valid, but we should NOT
        // accidentally fall into UsdMonthly without a budget.
        assert!(matches!(br.cap_mode, CapMode::WeeklyTokens | CapMode::None));
        if br.cap_mode == CapMode::WeeklyTokens {
            let days = br.days_remaining.expect("subscription days_remaining set");
            assert!(days.is_finite() && days >= 0.0, "days={days}");
            assert!(br.weekly_cap_tokens.is_some());
            assert!(br.weekly_used_tokens.unwrap_or(0) > 0);
            assert!(br.projected_exhaustion_date.is_some());
        }
    }
}
