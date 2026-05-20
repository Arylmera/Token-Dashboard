//! Monthly budget threshold alerts.
//!
//! Watches month-to-date spend against the configured monthly budget and
//! flags newly-crossed thresholds (default: 50/80/100%). State is persisted
//! in the `plan` table under a single JSON value so each threshold fires
//! at most once per month; mutes are honoured immediately.
//!
//! The OS-notification side of this feature is intentionally deferred to a
//! follow-up (needs `tauri-plugin-notification` + per-platform capability
//! grants). The in-app banner reads `newly_crossed` from `/api/budget-alerts`.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::preferences;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

const CONFIG_KEY: &str = "budget_alerts_config";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlertsState {
    /// `YYYY-MM` of the month whose thresholds we already fired for.
    /// New month resets `fired` automatically.
    pub month: String,
    pub fired: Vec<u32>,
}

impl Default for AlertsState {
    fn default() -> Self {
        Self {
            month: String::new(),
            fired: Vec::new(),
        }
    }
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
    pub mtd_cost_usd: f64,
    pub monthly_budget_usd: Option<f64>,
    pub percent: f64,
    pub thresholds: Vec<u32>,
    pub muted: Vec<u32>,
    pub newly_crossed: Vec<u32>,
    pub fired_this_month: Vec<u32>,
    pub month: String,
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

/// Inspect the current month's spend against the configured monthly budget,
/// flag any newly-crossed thresholds, and persist the updated state so each
/// threshold fires at most once per month.
pub fn check<P: AsRef<Path>>(db: P) -> rusqlite::Result<AlertResult> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let monthly_budget_usd = preferences::get_budgets(db)?.monthly;
    let mut cfg = get_config(db)?;

    let month: String = conn
        .query_row("SELECT strftime('%Y-%m', 'now')", [], |r| r.get(0))
        .unwrap_or_else(|_| String::new());

    // Reset `fired` whenever we roll into a new month so thresholds can re-fire.
    if cfg.state.month != month {
        cfg.state.month = month.clone();
        cfg.state.fired.clear();
    }

    let mtd_cost_usd = mtd_cost(&conn, &pricing)?;
    let percent = match monthly_budget_usd {
        Some(b) if b > 0.0 => (mtd_cost_usd / b) * 100.0,
        _ => 0.0,
    };

    let mut newly_crossed = Vec::new();
    if monthly_budget_usd.is_some() {
        for t in cfg.thresholds.iter().copied() {
            if cfg.muted.contains(&t) {
                continue;
            }
            if percent >= t as f64 && !cfg.state.fired.contains(&t) {
                newly_crossed.push(t);
                cfg.state.fired.push(t);
            }
        }
        if !newly_crossed.is_empty() {
            set_config(db, &cfg)?;
        }
    }

    Ok(AlertResult {
        mtd_cost_usd,
        monthly_budget_usd,
        percent,
        thresholds: cfg.thresholds.clone(),
        muted: cfg.muted.clone(),
        newly_crossed,
        fired_this_month: cfg.state.fired.clone(),
        month,
    })
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
