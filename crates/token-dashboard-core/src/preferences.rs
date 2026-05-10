//! User preferences (key/value, persisted in the existing `plan` table).
//!
//! Direct port of `token_dashboard/preferences.py`. Each setting is a row
//! in the `plan` table (k/v text). Defaults match python:
//!
//! - badge_metric: "tokens"
//! - badge_window_mode: "remaining"
//! - badge_dock_enabled: true
//! - badge_menubar_enabled: true
//! - limits_enabled: false
//! - glass_enabled: false
//! - glass_opacity: 25
//! - budget_*: null when unset
//! - limits_*_reset_at: null when unset; canonicalised to `…Z` form on write

use std::path::Path;

use rusqlite::Connection;

pub const BADGE_METRICS: &[&str] = &["tokens", "cost", "burn", "5h", "weekly"];

/// Metric keys the widget window can render. Order in this slice is the
/// canonical display order when rendering the widget; the stored
/// preference is a csv subset (capped at 6).
pub const WIDGET_METRICS: &[&str] = &[
    "today_live",
    "today_graph",
    "burn_rate",
    "range_1d",
    "range_7d",
    "range_30d",
    "range_90d",
    "range_all",
    "input_tokens",
    "output_tokens",
    "cache_hit",
    "cache_x_cost",
    "five_h_limit",
];
pub const DEFAULT_WIDGET_METRICS: &[&str] = &["today_live", "burn_rate", "five_h_limit"];
pub const WIDGET_METRICS_MAX: usize = 6;
pub const DEFAULT_BADGE_METRIC: &str = "tokens";
pub const BADGE_WINDOW_MODES: &[&str] = &["remaining", "used"];
pub const DEFAULT_BADGE_WINDOW_MODE: &str = "remaining";
pub const DEFAULT_GLASS_OPACITY: i64 = 25;

pub const BUDGET_KEYS: &[&str] = &[
    "budget_daily_usd",
    "budget_weekly_usd",
    "budget_monthly_usd",
];
pub const LIMIT_RESET_KEYS: &[&str] = &["limits_five_hour_reset_at", "limits_weekly_reset_at"];
pub const LIMIT_CAP_KEYS: &[&str] = &["limits_5h_cap_override", "limits_weekly_cap_override"];

fn open<P: AsRef<Path>>(db: P) -> rusqlite::Result<Connection> {
    let c = Connection::open(db.as_ref())?;
    c.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(c)
}

fn read_str<P: AsRef<Path>>(db: P, key: &str) -> rusqlite::Result<Option<String>> {
    let c = open(db)?;
    match c.query_row("SELECT v FROM plan WHERE k=?", [key], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(s) => Ok(Some(s)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_str<P: AsRef<Path>>(db: P, key: &str, value: &str) -> rusqlite::Result<()> {
    let c = open(db)?;
    c.execute(
        "INSERT OR REPLACE INTO plan (k, v) VALUES (?, ?)",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

fn delete_key<P: AsRef<Path>>(db: P, key: &str) -> rusqlite::Result<()> {
    let c = open(db)?;
    c.execute("DELETE FROM plan WHERE k=?", [key])?;
    Ok(())
}

pub fn get_badge_metric<P: AsRef<Path>>(db: P) -> rusqlite::Result<String> {
    Ok(read_str(db, "badge_metric")?
        .filter(|v| BADGE_METRICS.contains(&v.as_str()))
        .unwrap_or_else(|| DEFAULT_BADGE_METRIC.into()))
}

pub fn set_badge_metric<P: AsRef<Path>>(db: P, raw: &str) -> rusqlite::Result<String> {
    let v = if BADGE_METRICS.contains(&raw) {
        raw.to_string()
    } else {
        DEFAULT_BADGE_METRIC.to_string()
    };
    write_str(db, "badge_metric", &v)?;
    Ok(v)
}

pub fn get_badge_window_mode<P: AsRef<Path>>(db: P) -> rusqlite::Result<String> {
    Ok(read_str(db, "badge_window_mode")?
        .filter(|v| BADGE_WINDOW_MODES.contains(&v.as_str()))
        .unwrap_or_else(|| DEFAULT_BADGE_WINDOW_MODE.into()))
}

pub fn set_badge_window_mode<P: AsRef<Path>>(db: P, raw: &str) -> rusqlite::Result<String> {
    let v = if BADGE_WINDOW_MODES.contains(&raw) {
        raw.to_string()
    } else {
        DEFAULT_BADGE_WINDOW_MODE.to_string()
    };
    write_str(db, "badge_window_mode", &v)?;
    Ok(v)
}

fn get_bool<P: AsRef<Path>>(db: P, key: &str, default: bool) -> rusqlite::Result<bool> {
    match read_str(db, key)? {
        Some(v) => Ok(v == "1"),
        None => Ok(default),
    }
}

fn set_bool<P: AsRef<Path>>(db: P, key: &str, enabled: bool) -> rusqlite::Result<bool> {
    write_str(db, key, if enabled { "1" } else { "0" })?;
    Ok(enabled)
}

pub fn get_badge_dock_enabled<P: AsRef<Path>>(db: P) -> rusqlite::Result<bool> {
    get_bool(db, "badge_dock_enabled", true)
}
pub fn set_badge_dock_enabled<P: AsRef<Path>>(db: P, v: bool) -> rusqlite::Result<bool> {
    set_bool(db, "badge_dock_enabled", v)
}
pub fn get_badge_menubar_enabled<P: AsRef<Path>>(db: P) -> rusqlite::Result<bool> {
    get_bool(db, "badge_menubar_enabled", true)
}
pub fn set_badge_menubar_enabled<P: AsRef<Path>>(db: P, v: bool) -> rusqlite::Result<bool> {
    set_bool(db, "badge_menubar_enabled", v)
}
pub fn get_limits_enabled<P: AsRef<Path>>(db: P) -> rusqlite::Result<bool> {
    get_bool(db, "limits_enabled", false)
}
pub fn set_limits_enabled<P: AsRef<Path>>(db: P, v: bool) -> rusqlite::Result<bool> {
    set_bool(db, "limits_enabled", v)
}

pub fn get_advanced_mode<P: AsRef<Path>>(db: P) -> rusqlite::Result<bool> {
    get_bool(db, "advanced_mode", false)
}
pub fn set_advanced_mode<P: AsRef<Path>>(db: P, v: bool) -> rusqlite::Result<bool> {
    set_bool(db, "advanced_mode", v)
}

/// Theme id chosen in the UI. Stored verbatim as an opaque string so the
/// backend doesn't have to track the frontend's theme catalog. Empty/missing
/// returns None so the UI can fall back to its built-in default.
pub fn get_theme<P: AsRef<Path>>(db: P) -> rusqlite::Result<Option<String>> {
    Ok(read_str(db, "theme")?.filter(|s| !s.is_empty()))
}
pub fn set_theme<P: AsRef<Path>>(db: P, raw: &str) -> rusqlite::Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        delete_key(db, "theme")?;
        Ok(None)
    } else {
        write_str(db, "theme", trimmed)?;
        Ok(Some(trimmed.to_string()))
    }
}

/// Read the widget-metrics preference as a deduped, whitelisted, ordered
/// list. Falls back to the default selection if unset/invalid.
pub fn get_widget_metrics<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<String>> {
    let raw = read_str(db, "widget_metrics")?;
    let parsed: Vec<String> = match raw {
        Some(s) => {
            let mut seen = std::collections::HashSet::new();
            s.split(',')
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .filter(|t| WIDGET_METRICS.contains(t))
                .filter(|t| seen.insert(t.to_string()))
                .take(WIDGET_METRICS_MAX)
                .map(String::from)
                .collect()
        }
        None => Vec::new(),
    };
    if parsed.is_empty() {
        Ok(DEFAULT_WIDGET_METRICS.iter().map(|s| s.to_string()).collect())
    } else {
        Ok(parsed)
    }
}

/// Persist a deduped, whitelisted, length-capped widget-metrics list.
/// Returns the value as stored.
pub fn set_widget_metrics<P: AsRef<Path>>(
    db: P,
    raw: &[String],
) -> rusqlite::Result<Vec<String>> {
    let mut seen = std::collections::HashSet::new();
    let cleaned: Vec<String> = raw
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|t| !t.is_empty())
        .filter(|t| WIDGET_METRICS.contains(&t.as_str()))
        .filter(|t| seen.insert(t.clone()))
        .take(WIDGET_METRICS_MAX)
        .collect();
    write_str(db, "widget_metrics", &cleaned.join(","))?;
    Ok(cleaned)
}

pub fn get_glass_enabled<P: AsRef<Path>>(db: P) -> rusqlite::Result<bool> {
    Ok(read_str(db, "glass_enabled")?.as_deref() == Some("1"))
}
pub fn set_glass_enabled<P: AsRef<Path>>(db: P, v: bool) -> rusqlite::Result<bool> {
    write_str(db, "glass_enabled", if v { "1" } else { "0" })?;
    Ok(v)
}

/// Whether the floating widget window was open at last shutdown. The
/// Tauri shell uses this to re-open the widget on next launch so the
/// user doesn't have to re-summon it from the tray each time.
pub fn get_widget_open<P: AsRef<Path>>(db: P) -> rusqlite::Result<bool> {
    get_bool(db, "widget_open", false)
}
pub fn set_widget_open<P: AsRef<Path>>(db: P, v: bool) -> rusqlite::Result<bool> {
    set_bool(db, "widget_open", v)
}

pub fn get_glass_opacity<P: AsRef<Path>>(db: P) -> rusqlite::Result<i64> {
    Ok(read_str(db, "glass_opacity")?
        .and_then(|s| s.parse::<i64>().ok())
        .map(|n| n.clamp(0, 100))
        .unwrap_or(DEFAULT_GLASS_OPACITY))
}
pub fn set_glass_opacity<P: AsRef<Path>>(db: P, v: i64) -> rusqlite::Result<i64> {
    let n = v.clamp(0, 100);
    write_str(db, "glass_opacity", &n.to_string())?;
    Ok(n)
}

/// Optional Anthropic API key for the limits-sync probe. Empty string
/// values are normalised to None on both read and write.
pub fn get_anthropic_api_key<P: AsRef<Path>>(db: P) -> rusqlite::Result<Option<String>> {
    Ok(read_str(db, "anthropic_api_key")?.filter(|s| !s.is_empty()))
}
pub fn set_anthropic_api_key<P: AsRef<Path>>(
    db: P,
    raw: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let trimmed = raw.map(|s| s.trim()).filter(|s| !s.is_empty());
    match trimmed {
        Some(v) => {
            write_str(db, "anthropic_api_key", v)?;
            Ok(Some(v.to_string()))
        }
        None => {
            delete_key(db, "anthropic_api_key")?;
            Ok(None)
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Budgets {
    pub daily: Option<f64>,
    pub weekly: Option<f64>,
    pub monthly: Option<f64>,
}

pub fn get_budgets<P: AsRef<Path>>(db: P) -> rusqlite::Result<Budgets> {
    let mut out = Budgets::default();
    let c = open(db)?;
    let mut stmt = c.prepare(
        "SELECT k, v FROM plan WHERE k IN ('budget_daily_usd', 'budget_weekly_usd', 'budget_monthly_usd')",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let k: String = r.get(0)?;
        let v: String = r.get(1)?;
        let parsed = v.parse::<f64>().ok().filter(|f| *f > 0.0);
        match k.as_str() {
            "budget_daily_usd" => out.daily = parsed,
            "budget_weekly_usd" => out.weekly = parsed,
            "budget_monthly_usd" => out.monthly = parsed,
            _ => {}
        }
    }
    Ok(out)
}

/// Persist a budget cap. Pass None or 0 to clear it. Returns the
/// resulting value (or None if cleared).
pub fn set_budget<P: AsRef<Path>>(
    db: P,
    key: &str,
    amount: Option<f64>,
) -> rusqlite::Result<Option<f64>> {
    if !BUDGET_KEYS.contains(&key) {
        return Ok(None);
    }
    match amount.filter(|v| *v > 0.0) {
        Some(v) => {
            write_str(db, key, &v.to_string())?;
            Ok(Some(v))
        }
        None => {
            delete_key(db, key)?;
            Ok(None)
        }
    }
}

/// Read a stored ISO `…Z` timestamp for one of the limit-reset keys.
pub fn get_limit_reset_at<P: AsRef<Path>>(db: P, key: &str) -> rusqlite::Result<Option<String>> {
    if !LIMIT_RESET_KEYS.contains(&key) {
        return Ok(None);
    }
    Ok(read_str(db, key)?.filter(|s| !s.is_empty()))
}

/// Persist or clear a limit-reset timestamp. The python helper canonicalises
/// to `…Z` UTC form; we keep the input verbatim here (callers already pass
/// canonical strings — full ISO normalisation lands with the limits-sync
/// port that needs it).
pub fn set_limit_reset_at<P: AsRef<Path>>(
    db: P,
    key: &str,
    value: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    if !LIMIT_RESET_KEYS.contains(&key) {
        return Ok(None);
    }
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => {
            write_str(db, key, v)?;
            Ok(Some(v.to_string()))
        }
        None => {
            delete_key(db, key)?;
            Ok(None)
        }
    }
}

pub fn get_limit_cap_override<P: AsRef<Path>>(db: P, key: &str) -> rusqlite::Result<Option<i64>> {
    if !LIMIT_CAP_KEYS.contains(&key) {
        return Ok(None);
    }
    Ok(read_str(db, key)?
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0))
}
pub fn set_limit_cap_override<P: AsRef<Path>>(
    db: P,
    key: &str,
    value: Option<i64>,
) -> rusqlite::Result<Option<i64>> {
    if !LIMIT_CAP_KEYS.contains(&key) {
        return Ok(None);
    }
    match value.filter(|n| *n > 0) {
        Some(n) => {
            write_str(db, key, &n.to_string())?;
            Ok(Some(n))
        }
        None => {
            delete_key(db, key)?;
            Ok(None)
        }
    }
}

#[derive(Debug, Default)]
pub struct LimitsSyncMeta {
    pub last_sync_at: Option<String>,
    pub last_sync_status: Option<String>,
}

pub fn get_limits_sync_meta<P: AsRef<Path>>(db: P) -> rusqlite::Result<LimitsSyncMeta> {
    let mut out = LimitsSyncMeta::default();
    let c = open(db)?;
    let mut stmt = c.prepare(
        "SELECT k, v FROM plan WHERE k IN ('limits_last_sync_at', 'limits_last_sync_status')",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let k: String = r.get(0)?;
        let v: String = r.get(1)?;
        match k.as_str() {
            "limits_last_sync_at" => out.last_sync_at = Some(v),
            "limits_last_sync_status" => out.last_sync_status = Some(v),
            _ => {}
        }
    }
    Ok(out)
}
