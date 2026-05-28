//! Budget threshold alerts.
//!
//! Two regimes depending on the active plan:
//!
//! * **API plan** — watches month-to-date USD spend against the configured
//!   monthly budget and flags newly-crossed thresholds. State keyed by
//!   `YYYY-MM`, resets on month rollover.
//! * **Subscription plan (Pro/Max/Team/…)** — USD budgets don't apply.
//!   Watches the server-synced *weekly* utilization (from Anthropic
//!   rate-limit headers) and the *5h window* utilization independently.
//!   Each window keeps its own fired list keyed by the current reset
//!   timestamp, so thresholds re-fire automatically when a fresh window
//!   opens. Monthly USD alerts are suppressed.
//!
//! Mutes are honoured immediately and apply across all three windows.
//! The OS-notification side is wired through the SSE bus in `scan.rs`;
//! the in-app banner reads `newly_crossed*` from `/api/budget-alerts`.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::preferences;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::{get_plan, open_ro};

const CONFIG_KEY: &str = "budget_alerts_config";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AlertsState {
    /// `YYYY-MM` of the month whose monthly-USD thresholds we already
    /// fired for. New month resets `fired` automatically. Only used
    /// on the API plan.
    pub month: String,
    pub fired: Vec<u32>,
    /// Subscription mode: reset timestamp of the weekly window whose
    /// thresholds were fired. When the stored key differs from the
    /// current `limits_weekly_reset_at`, `weekly_fired` is cleared.
    #[serde(default)]
    pub weekly_window: String,
    #[serde(default)]
    pub weekly_fired: Vec<u32>,
    /// Same shape as the weekly fields, but for the 5h window keyed
    /// off `limits_five_hour_reset_at`.
    #[serde(default)]
    pub five_hour_window: String,
    #[serde(default)]
    pub five_hour_fired: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlertsConfig {
    pub thresholds: Vec<u32>,
    pub muted: Vec<u32>,
    pub state: AlertsState,
}

impl Default for AlertsConfig {
    fn default() -> Self {
        Self {
            thresholds: vec![50, 80, 100],
            muted: vec![],
            state: AlertsState::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AlertResult {
    /// Active plan key (`"api"`, `"max"`, `"pro"`, …). Drives which
    /// alert regime fired.
    pub plan: String,
    /// True when the subscription regime is active. Mirrors `plan != "api"`.
    pub subscription_mode: bool,
    /// Configured thresholds and mutes (shared across all windows).
    pub thresholds: Vec<u32>,
    pub muted: Vec<u32>,

    // --- Monthly USD regime (API plan only) ---
    pub mtd_cost_usd: f64,
    pub monthly_budget_usd: Option<f64>,
    pub percent: f64,
    pub newly_crossed: Vec<u32>,
    pub fired_this_month: Vec<u32>,
    pub month: String,

    // --- Subscription regime: weekly window ---
    /// 0–100. `None` when no weekly server snapshot is available.
    pub weekly_percent: Option<f64>,
    pub weekly_resets_at: Option<String>,
    pub newly_crossed_weekly: Vec<u32>,
    pub fired_this_weekly: Vec<u32>,

    // --- Subscription regime: 5h window ---
    pub five_hour_percent: Option<f64>,
    pub five_hour_resets_at: Option<String>,
    pub newly_crossed_5h: Vec<u32>,
    pub fired_this_5h: Vec<u32>,
}

/// Read the persisted alerts config, falling back to defaults.
pub fn get_config<P: AsRef<Path>>(db: P) -> rusqlite::Result<AlertsConfig> {
    let c = open_ro(db)?;
    let raw: Option<String> = c
        .query_row(
            "SELECT v FROM plan WHERE k = ?1",
            params![CONFIG_KEY],
            |r| r.get(0),
        )
        .ok();
    match raw {
        Some(s) => serde_json::from_str(&s).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e,
            )))
        }),
        None => Ok(AlertsConfig::default()),
    }
}

/// Persist the alerts config.
pub fn set_config<P: AsRef<Path>>(db: P, cfg: &AlertsConfig) -> rusqlite::Result<()> {
    let c = open_ro(db)?;
    let s = serde_json::to_string(cfg).unwrap_or_else(|_| "{}".into());
    c.execute(
        "INSERT OR REPLACE INTO plan (k, v) VALUES (?1, ?2)",
        params![CONFIG_KEY, s],
    )?;
    Ok(())
}

/// Check whichever alert regime is active for the current plan, flag any
/// newly-crossed thresholds, and persist updated state so each threshold
/// fires at most once per window. See module docs for the two regimes.
pub fn check<P: AsRef<Path>>(db: P) -> rusqlite::Result<AlertResult> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let mut cfg = get_config(db)?;
    let plan = get_plan(db).unwrap_or_else(|_| "api".to_string());
    let subscription_mode = plan != "api";

    let month: String = conn
        .query_row("SELECT strftime('%Y-%m', 'now')", [], |r| r.get(0))
        .unwrap_or_else(|_| String::new());

    let monthly_budget_usd = preferences::get_budgets(db)?.monthly;
    let mtd_cost_usd = mtd_cost(&conn, &pricing)?;
    let percent = match monthly_budget_usd {
        Some(b) if b > 0.0 => (mtd_cost_usd / b) * 100.0,
        _ => 0.0,
    };

    let mut dirty = false;
    let mut newly_crossed_monthly = Vec::new();
    let mut newly_crossed_weekly = Vec::new();
    let mut newly_crossed_5h = Vec::new();
    let mut weekly_percent: Option<f64> = None;
    let mut weekly_resets_at: Option<String> = None;
    let mut five_hour_percent: Option<f64> = None;
    let mut five_hour_resets_at: Option<String> = None;

    if subscription_mode {
        // Subscription regime: monthly USD budgets don't apply. Reset the
        // month state so any prior API-mode fired entries don't leak.
        if !cfg.state.fired.is_empty() {
            cfg.state.fired.clear();
            dirty = true;
        }
        cfg.state.month = month.clone();

        // Evaluate against the same 5h/weekly utilization the dashboard
        // displays. `compute_limits` dispatches on `limits_source`:
        // the OAuth snapshot when synced, the local JSONL estimate
        // otherwise. An absent `anchor` means the window has no data
        // (idle / never synced) — skip it, matching the prior
        // "no server snapshot → don't fire" behavior.
        let limits = crate::limits::compute_limits(db, &pricing)?;

        if limits.weekly.anchor.is_some() {
            let pct = util_to_percent(limits.weekly.pct_used);
            weekly_percent = Some(pct);
            weekly_resets_at = limits.weekly.resets_at.clone();
            evaluate_window(
                &mut WindowState {
                    key: &mut cfg.state.weekly_window,
                    fired: &mut cfg.state.weekly_fired,
                },
                weekly_resets_at.as_deref().unwrap_or(""),
                pct,
                &cfg.thresholds,
                &cfg.muted,
                &mut newly_crossed_weekly,
                &mut dirty,
            );
        }

        if limits.five_hour.anchor.is_some() {
            let pct = util_to_percent(limits.five_hour.pct_used);
            five_hour_percent = Some(pct);
            five_hour_resets_at = limits.five_hour.resets_at.clone();
            evaluate_window(
                &mut WindowState {
                    key: &mut cfg.state.five_hour_window,
                    fired: &mut cfg.state.five_hour_fired,
                },
                five_hour_resets_at.as_deref().unwrap_or(""),
                pct,
                &cfg.thresholds,
                &cfg.muted,
                &mut newly_crossed_5h,
                &mut dirty,
            );
        }
    } else if monthly_budget_usd.is_some() {
        evaluate_window(
            &mut WindowState {
                key: &mut cfg.state.month,
                fired: &mut cfg.state.fired,
            },
            &month,
            percent,
            &cfg.thresholds,
            &cfg.muted,
            &mut newly_crossed_monthly,
            &mut dirty,
        );
    } else if cfg.state.month != month {
        // No budget configured — keep month state aligned so a future
        // budget edit starts with a clean fired list.
        cfg.state.month = month.clone();
        cfg.state.fired.clear();
        dirty = true;
    }

    if dirty {
        set_config(db, &cfg)?;
    }

    Ok(AlertResult {
        plan,
        subscription_mode,
        thresholds: cfg.thresholds.clone(),
        muted: cfg.muted.clone(),
        mtd_cost_usd,
        monthly_budget_usd,
        percent,
        newly_crossed: newly_crossed_monthly,
        fired_this_month: cfg.state.fired.clone(),
        month,
        weekly_percent,
        weekly_resets_at,
        newly_crossed_weekly,
        fired_this_weekly: cfg.state.weekly_fired.clone(),
        five_hour_percent,
        five_hour_resets_at,
        newly_crossed_5h,
        fired_this_5h: cfg.state.five_hour_fired.clone(),
    })
}

/// Mutable view over one window's persisted state. Lets `evaluate_window`
/// rotate the window key + fired list without taking a mutable borrow on
/// the whole `AlertsConfig`.
struct WindowState<'a> {
    key: &'a mut String,
    fired: &'a mut Vec<u32>,
}

fn util_to_percent(util: f64) -> f64 {
    (util * 100.0).clamp(0.0, 100.0)
}

/// Score `percent` against `thresholds` for one window. If the stored
/// window key has changed, the fired list is cleared first (new window
/// = thresholds become eligible again). Crossings are appended to
/// `newly_crossed`; `dirty` is set whenever persisted state mutated.
fn evaluate_window(
    state: &mut WindowState<'_>,
    current_key: &str,
    percent: f64,
    thresholds: &[u32],
    muted: &[u32],
    newly_crossed: &mut Vec<u32>,
    dirty: &mut bool,
) {
    if state.key != current_key {
        *state.key = current_key.to_string();
        state.fired.clear();
        *dirty = true;
    }
    for t in thresholds.iter().copied() {
        if muted.contains(&t) {
            continue;
        }
        if percent >= t as f64 && !state.fired.contains(&t) {
            newly_crossed.push(t);
            state.fired.push(t);
            *dirty = true;
        }
    }
}

fn mtd_cost(conn: &rusqlite::Connection, pricing: &Pricing) -> rusqlite::Result<f64> {
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

    fn insert_assistant(conn: &Connection, uuid: &str, model: &str, output: i64) {
        // Always insert as today (this month) for MTD calcs.
        let today: String = conn
            .query_row("SELECT date('now')", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's', 'p', 'assistant', ?2, ?3, 0, ?4, 0, 0, 0)",
            params![uuid, format!("{today}T12:00:00Z"), model, output],
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
    fn defaults_to_50_80_100_when_unconfigured() {
        let f = fresh_db();
        let cfg = get_config(f.path()).unwrap();
        assert_eq!(cfg.thresholds, vec![50, 80, 100]);
        assert!(cfg.muted.is_empty());
        assert!(cfg.state.fired.is_empty());
    }

    #[test]
    fn no_budget_returns_zero_percent_and_no_crossings() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(&conn, "u1", "claude-opus-4-7", 10_000_000);
        drop(conn);
        let r = check(f.path()).unwrap();
        assert_eq!(r.percent, 0.0);
        assert!(r.newly_crossed.is_empty());
        assert!(r.monthly_budget_usd.is_none());
    }

    #[test]
    fn fires_crossed_thresholds_once_per_month() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // Cost of 1M opus output tokens
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
        // Insert enough output to comfortably exceed 100% of a small budget.
        insert_assistant(&conn, "u1", "claude-opus-4-7", 10_000_000);
        set_monthly_budget(&conn, per_m * 5.0); // 10M output spent on a budget of 5M output → 200%
        drop(conn);

        let r1 = check(f.path()).unwrap();
        assert_eq!(
            r1.newly_crossed,
            vec![50, 80, 100],
            "first check should fire all"
        );
        assert!(r1.percent >= 100.0, "percent={}", r1.percent);

        let r2 = check(f.path()).unwrap();
        assert!(
            r2.newly_crossed.is_empty(),
            "second check should re-fire none"
        );
        assert_eq!(r2.fired_this_month, vec![50, 80, 100]);
    }

    #[test]
    fn muted_threshold_does_not_fire() {
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
        insert_assistant(&conn, "u1", "claude-opus-4-7", 10_000_000);
        set_monthly_budget(&conn, per_m * 5.0);
        drop(conn);

        let mut cfg = get_config(f.path()).unwrap();
        cfg.muted = vec![80];
        set_config(f.path(), &cfg).unwrap();

        let r = check(f.path()).unwrap();
        assert!(!r.newly_crossed.contains(&80));
        assert!(r.newly_crossed.contains(&50));
        assert!(r.newly_crossed.contains(&100));
    }

    fn set_server_util(conn: &Connection, key: &str, util: f64) {
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES (?1, ?2)",
            params![key, util.to_string()],
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
    fn subscription_mode_fires_on_weekly_and_5h_thresholds() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_plan(&conn, "max");
        set_server_util(&conn, "limits_weekly_pct_server", 0.85);
        set_server_util(&conn, "limits_5h_pct_server", 0.55);
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_weekly_reset_at', '2099-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_five_hour_reset_at', '2099-01-01T05:00:00Z')",
            [],
        )
        .unwrap();
        drop(conn);

        let r = check(f.path()).unwrap();
        assert!(r.subscription_mode);
        assert_eq!(r.newly_crossed_weekly, vec![50, 80]);
        assert_eq!(r.newly_crossed_5h, vec![50]);
        // Monthly USD alerts suppressed in subscription mode.
        assert!(r.newly_crossed.is_empty());

        // Second call doesn't re-fire.
        let r2 = check(f.path()).unwrap();
        assert!(r2.newly_crossed_weekly.is_empty());
        assert!(r2.newly_crossed_5h.is_empty());
    }

    #[test]
    fn subscription_falls_back_to_jsonl_when_no_server_snapshot() {
        // No OAuth sync has happened, so the server snapshot is empty.
        // Alerts must still fire off the locally-computed 5h utilization
        // that the dashboard already displays.
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_plan(&conn, "max");
        // A single in-window assistant message worth 600 billable sonnet
        // tokens (tier weight 1).
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES ('u1', 's', 'p', 'assistant', datetime('now'), \
              'claude-sonnet-4-6', 0, 600, 0, 0, 0)",
            [],
        )
        .unwrap();
        drop(conn);
        // Force the JSONL source and pin the 5h cap so 600/1000 = 60%.
        crate::preferences::set_limits_source(f.path(), "jsonl").unwrap();
        crate::preferences::set_limit_cap_override(f.path(), "limits_5h_cap_override", Some(1000))
            .unwrap();

        let r = check(f.path()).unwrap();
        assert!(r.subscription_mode);
        assert_eq!(r.five_hour_percent, Some(60.0));
        assert_eq!(r.newly_crossed_5h, vec![50]);
    }

    #[test]
    fn subscription_new_window_resets_fired() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        set_plan(&conn, "max");
        set_server_util(&conn, "limits_weekly_pct_server", 0.85);
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_weekly_reset_at', '2099-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        drop(conn);

        let r1 = check(f.path()).unwrap();
        assert_eq!(r1.newly_crossed_weekly, vec![50, 80]);

        // Roll the weekly window — fired list should clear.
        let conn = Connection::open(f.path()).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_weekly_reset_at', '2099-02-01T00:00:00Z')",
            [],
        )
        .unwrap();
        drop(conn);
        let r2 = check(f.path()).unwrap();
        assert_eq!(r2.newly_crossed_weekly, vec![50, 80]);
    }

    #[test]
    fn rolling_into_new_month_resets_fired() {
        let f = fresh_db();
        // Seed an already-fired state from a prior month.
        let stale_cfg = AlertsConfig {
            thresholds: vec![50, 80, 100],
            muted: vec![],
            state: AlertsState {
                month: "2020-01".into(),
                fired: vec![50, 80, 100],
                ..AlertsState::default()
            },
        };
        set_config(f.path(), &stale_cfg).unwrap();

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
        insert_assistant(&conn, "u1", "claude-opus-4-7", 10_000_000);
        set_monthly_budget(&conn, per_m * 5.0);
        drop(conn);

        let r = check(f.path()).unwrap();
        assert_ne!(r.month, "2020-01");
        // Fresh month → fired list reset, so all thresholds re-fire.
        assert_eq!(r.newly_crossed, vec![50, 80, 100]);
    }
}
