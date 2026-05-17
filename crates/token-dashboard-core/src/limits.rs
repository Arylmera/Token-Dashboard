//! Plan-limits computation: sonnet-equivalent token usage in the 5h
//! session window and the rolling weekly window, paired with the
//! per-plan caps in `pricing.json` (or the user's calibrated overrides).
//!
//! The frontend's "Plan limits remaining" card on Overview consumes the
//! shape this module emits; the Settings calibrator reads `used` to
//! back-solve a cap from a percentage shown in Anthropic's statusbar.
//!
//! Window semantics:
//! - 5h: anchored. If the user set `limits_five_hour_reset_at` and it is
//!   still in the future, we honour it (anchor = reset - 5h). A stale
//!   reset_at (already past) is treated as expired and we fall back to
//!   the first assistant message in the last 5h; with no recent activity
//!   the window is idle (anchor = null) and the frontend renders the
//!   idle sub-label.
//! - Weekly: when `limits_weekly_reset_at` is set we roll it forward by
//!   7-day multiples until it is in the future (Anthropic's weekly reset
//!   is a recurring wall-clock schedule). Otherwise rolling over the
//!   last 7 days.

use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::preferences;
use crate::pricing::{tier_from_name, Pricing};
use crate::queries;

#[derive(Debug, Clone, Serialize)]
pub struct LimitWindow {
    /// Plan cap, sonnet-equivalent tokens. `None` when the plan has no
    /// configured cap (e.g. `api`) or pricing has no entry for the plan.
    /// Always `None` for `source = "server"` since Anthropic doesn't
    /// expose absolute caps over the API.
    pub cap: Option<i64>,
    /// Sonnet-equivalent tokens consumed in the window. Always `0` for
    /// `source = "server"` (the headers only carry a percentage).
    pub used: i64,
    /// 0.0..1.0. For `source = "jsonl"` this is `used / cap`, clamped;
    /// for `source = "server"` it's the verbatim utilization header.
    pub pct_used: f64,
    pub pct_remaining: f64,
    pub resets_at: Option<String>,
    /// ISO timestamp the window opens from. `None` signals "idle — no
    /// active session" to the frontend (it inspects `"anchor" in win`).
    pub anchor: Option<String>,
    /// True when the cap came from a user-calibrated override rather
    /// than the embedded pricing defaults. Always `false` for `source
    /// = "server"`.
    pub calibrated: bool,
    /// Where this window's numbers came from. `"jsonl"` = local
    /// transcript sum vs configured cap. `"server"` = Anthropic
    /// rate-limit headers via the OAuth sync. The frontend uses this
    /// to decide which sub-label to render.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LimitsMetaOut {
    pub last_verified: Option<String>,
    pub source_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LimitsSnapshot {
    pub plan: String,
    pub meta: LimitsMetaOut,
    pub five_hour: LimitWindow,
    pub weekly: LimitWindow,
}

/// Compute the live 5h + weekly snapshot for the dashboard. The
/// connection is opened read-only; callers responsible for thread/blocking.
///
/// Dispatches on the `limits_source` preference. When `"oauth"`,
/// returns the cached server snapshot from preferences verbatim — no
/// JSONL access. When `"jsonl"` (default), sums local transcript
/// tokens against the configured cap.
pub fn compute_limits<P: AsRef<Path>>(
    db: P,
    pricing: &Pricing,
) -> rusqlite::Result<LimitsSnapshot> {
    let source = preferences::get_limits_source(db.as_ref())?;
    if source == "oauth" {
        return compute_limits_from_server(db);
    }
    let plan = queries::get_plan(db.as_ref())?;
    let reset_5h = preferences::get_limit_reset_at(db.as_ref(), "limits_five_hour_reset_at")?;
    let reset_wk = preferences::get_limit_reset_at(db.as_ref(), "limits_weekly_reset_at")?;
    let cap_5h_over = preferences::get_limit_cap_override(db.as_ref(), "limits_5h_cap_override")?;
    let cap_wk_over =
        preferences::get_limit_cap_override(db.as_ref(), "limits_weekly_cap_override")?;

    let plan_caps = pricing.limits.get(&plan).cloned().unwrap_or_default();
    let cap_5h = cap_5h_over.or(plan_caps.five_hour);
    let cap_wk = cap_wk_over.or(plan_caps.weekly);

    let conn = queries::open_ro(db.as_ref())?;

    let (anchor_5h, resets_5h) = resolve_5h_window(&conn, reset_5h.as_deref())?;
    let used_5h = if let Some(ref a) = anchor_5h {
        used_since(&conn, a, pricing)?
    } else {
        0
    };

    let (anchor_wk, resets_wk) = resolve_weekly_window(&conn, reset_wk.as_deref())?;
    let used_wk = used_since(&conn, &anchor_wk, pricing)?;

    Ok(LimitsSnapshot {
        plan,
        meta: LimitsMetaOut {
            last_verified: pricing.limits_meta.last_verified.clone(),
            source_note: pricing.limits_meta.source_note.clone(),
        },
        five_hour: build_window(used_5h, cap_5h, resets_5h, anchor_5h, cap_5h_over.is_some()),
        weekly: build_window(
            used_wk,
            cap_wk,
            resets_wk,
            Some(anchor_wk),
            cap_wk_over.is_some(),
        ),
    })
}

fn build_window(
    used: i64,
    cap: Option<i64>,
    resets_at: Option<String>,
    anchor: Option<String>,
    calibrated: bool,
) -> LimitWindow {
    let (pct_used, pct_remaining) = match cap {
        Some(c) if c > 0 => {
            let u = (used as f64 / c as f64).clamp(0.0, 1.0);
            (u, 1.0 - u)
        }
        _ => (0.0, 0.0),
    };
    LimitWindow {
        cap,
        used,
        pct_used,
        pct_remaining,
        resets_at,
        anchor,
        calibrated,
        source: "jsonl".into(),
    }
}

/// Build a server-sourced LimitsSnapshot from the cached OAuth-sync
/// snapshot. Reads only from the `plan` (k/v) table — does not touch
/// the `messages` table.
fn compute_limits_from_server<P: AsRef<Path>>(db: P) -> rusqlite::Result<LimitsSnapshot> {
    let plan = queries::get_plan(db.as_ref())?;
    let snap = preferences::get_limits_server_snapshot(db.as_ref())?;
    let conn = rusqlite::Connection::open(db.as_ref())?;
    let reset_5h = drop_if_past(
        &conn,
        preferences::get_limit_reset_at(db.as_ref(), "limits_five_hour_reset_at")?,
    )?;
    let reset_wk = drop_if_past(
        &conn,
        preferences::get_limit_reset_at(db.as_ref(), "limits_weekly_reset_at")?,
    )?;
    Ok(LimitsSnapshot {
        plan,
        meta: LimitsMetaOut {
            last_verified: snap.synced_at.clone(),
            source_note: Some(
                "Live values from Anthropic rate-limit headers (Claude subscription).".into(),
            ),
        },
        five_hour: server_window(snap.five_hour_utilization, reset_5h),
        weekly: server_window(snap.weekly_utilization, reset_wk),
    })
}

/// Treat any reset stamp that is already in the past as absent. The OAuth
/// sync skips writing the header when Anthropic omits it; that left
/// previous future-pointing stamps lingering in the DB and the UI kept
/// counting down to a window that had already elapsed.
fn drop_if_past(
    conn: &rusqlite::Connection,
    resets_at: Option<String>,
) -> rusqlite::Result<Option<String>> {
    let Some(r) = resets_at else { return Ok(None) };
    let in_future: i64 = conn.query_row(
        "SELECT CASE WHEN datetime(?) > datetime('now') THEN 1 ELSE 0 END",
        params![r],
        |row| row.get(0),
    )?;
    Ok(if in_future == 1 { Some(r) } else { None })
}

fn server_window(util: Option<f64>, resets_at: Option<String>) -> LimitWindow {
    let pct_used = util.unwrap_or(0.0).clamp(0.0, 1.0);
    let pct_remaining = if util.is_some() { 1.0 - pct_used } else { 0.0 };
    // `anchor = Some(...)` is the "active session" signal for the
    // frontend. Only assert that signal when the server reports actual
    // utilization AND we still have a future reset to count down to —
    // a zero-util sync with no reset header means the window is idle.
    let anchor = if util.is_some() && (pct_used > 0.0 || resets_at.is_some()) {
        resets_at.clone().or_else(|| Some("server".into()))
    } else {
        None
    };
    LimitWindow {
        cap: None,
        used: 0,
        pct_used,
        pct_remaining,
        resets_at,
        anchor,
        calibrated: false,
        source: "server".into(),
    }
}

/// Returns `(anchor, resets_at)`. `anchor = None` signals idle.
fn resolve_5h_window(
    conn: &rusqlite::Connection,
    reset_at: Option<&str>,
) -> rusqlite::Result<(Option<String>, Option<String>)> {
    if let Some(r) = reset_at {
        // Honour the user-set reset only while it is still in the future.
        // A stale reset_at means the window already elapsed; fall through
        // to message-driven anchoring so the dashboard rolls forward.
        let in_future: i64 = conn.query_row(
            "SELECT CASE WHEN datetime(?) > datetime('now') THEN 1 ELSE 0 END",
            params![r],
            |row| row.get(0),
        )?;
        if in_future == 1 {
            let anchor: String =
                conn.query_row("SELECT datetime(?, '-5 hours')", params![r], |row| {
                    row.get(0)
                })?;
            return Ok((Some(anchor), Some(r.to_string())));
        }
    }
    let first: Option<String> = conn
        .query_row(
            "SELECT MIN(timestamp) FROM messages \
             WHERE type='assistant' AND timestamp >= datetime('now', '-5 hours')",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    match first {
        Some(t) => {
            let resets: String =
                conn.query_row("SELECT datetime(?, '+5 hours')", params![t], |row| {
                    row.get(0)
                })?;
            Ok((Some(t), Some(resets)))
        }
        None => Ok((None, None)),
    }
}

/// Weekly window is always defined: rolling last-7-days when no
/// `reset_at` is set, anchored when it is. A stale `reset_at` is rolled
/// forward by 7-day multiples until it lands in the future, matching
/// Anthropic's recurring weekly reset schedule. Returns `(anchor, resets_at)`.
fn resolve_weekly_window(
    conn: &rusqlite::Connection,
    reset_at: Option<&str>,
) -> rusqlite::Result<(String, Option<String>)> {
    if let Some(r) = reset_at {
        let rolled: String = conn.query_row(
            "WITH RECURSIVE roll(ts) AS ( \
                SELECT datetime(?) \
                UNION ALL \
                SELECT datetime(ts, '+7 days') FROM roll \
                WHERE datetime(ts) <= datetime('now') \
             ) \
             SELECT ts FROM roll WHERE datetime(ts) > datetime('now') LIMIT 1",
            params![r],
            |row| row.get(0),
        )?;
        let anchor: String =
            conn.query_row("SELECT datetime(?, '-7 days')", params![rolled], |row| {
                row.get(0)
            })?;
        return Ok((anchor, Some(rolled)));
    }
    let anchor: String =
        conn.query_row("SELECT datetime('now', '-7 days')", [], |row| row.get(0))?;
    Ok((anchor, None))
}

/// Sum sonnet-equivalent billable tokens emitted by assistant messages
/// since `anchor`. Billable = input + output + cache_create_5m +
/// cache_create_1h (cache reads are not billed by Anthropic for the
/// quota window). Each model's contribution is scaled by the tier
/// weight in pricing.json (opus 5x, sonnet 1x, haiku 0.33x).
fn used_since(
    conn: &rusqlite::Connection,
    anchor: &str,
    pricing: &Pricing,
) -> rusqlite::Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT model, \
                SUM(input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) \
         FROM messages \
         WHERE type='assistant' AND timestamp >= ? AND model IS NOT NULL \
         GROUP BY model",
    )?;
    let mut total: f64 = 0.0;
    let mut rows = stmt.query(params![anchor])?;
    while let Some(row) = rows.next()? {
        let model: String = row.get(0)?;
        let billable: i64 = row.get::<_, Option<i64>>(1)?.unwrap_or(0);
        if billable <= 0 {
            continue;
        }
        let weight = tier_from_name(&model)
            .and_then(|t| pricing.tier_weight.get(t).copied())
            .unwrap_or(1.0);
        total += billable as f64 * weight;
    }
    Ok(total.round() as i64)
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

    fn insert_assistant(
        conn: &Connection,
        ts: &str,
        model: &str,
        input: i64,
        output: i64,
        cache_5m: i64,
    ) {
        conn.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_create_5m_tokens) \
             VALUES (?,?,?,?,?,?,?,?,?)",
            params![
                format!("u-{}-{}", ts, model),
                "s1",
                "proj",
                "assistant",
                ts,
                model,
                input,
                output,
                cache_5m,
            ],
        )
        .unwrap();
    }

    #[test]
    fn used_since_weights_by_tier() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        // 100 billable opus tokens, 100 billable sonnet tokens.
        insert_assistant(&conn, "2026-05-10T10:00:00Z", "claude-opus-4-7", 50, 30, 20);
        insert_assistant(
            &conn,
            "2026-05-10T10:00:01Z",
            "claude-sonnet-4-6",
            60,
            40,
            0,
        );
        drop(conn);
        let conn = queries::open_ro(f.path()).unwrap();
        let pricing = Pricing::embedded();
        let n = used_since(&conn, "2026-05-10T00:00:00Z", &pricing).unwrap();
        // opus 100 * 5 + sonnet 100 * 1 = 600
        assert_eq!(n, 600);
    }

    #[test]
    fn five_hour_idle_when_no_recent_activity() {
        let f = fresh_db();
        let pricing = Pricing::embedded();
        // No reset_at, no messages → idle.
        let snap = compute_limits(f.path(), &pricing).unwrap();
        assert!(snap.five_hour.anchor.is_none());
        assert_eq!(snap.five_hour.used, 0);
    }

    #[test]
    fn cap_override_marks_calibrated() {
        let f = fresh_db();
        // These cases all exercise the legacy JSONL dispatch — the
        // default flipped to "oauth" once the OAuth UI shipped, so
        // pin the source explicitly per-test instead of relying on
        // the global default.
        preferences::set_limits_source(f.path(), "jsonl").unwrap();
        queries::set_plan(f.path(), "pro").unwrap();
        preferences::set_limit_cap_override(f.path(), "limits_5h_cap_override", Some(123_456))
            .unwrap();
        let pricing = Pricing::embedded();
        let snap = compute_limits(f.path(), &pricing).unwrap();
        assert_eq!(snap.plan, "pro");
        assert_eq!(snap.five_hour.cap, Some(123_456));
        assert!(snap.five_hour.calibrated);
        assert!(!snap.weekly.calibrated);
        assert_eq!(snap.weekly.cap, Some(90_000_000));
    }

    #[test]
    fn stale_five_hour_reset_falls_back_to_idle() {
        let f = fresh_db();
        preferences::set_limits_source(f.path(), "jsonl").unwrap();
        // reset_at set in the past → window already elapsed.
        preferences::set_limit_reset_at(
            f.path(),
            "limits_five_hour_reset_at",
            Some("2026-05-10T10:00:00Z"),
        )
        .unwrap();
        let pricing = Pricing::embedded();
        let snap = compute_limits(f.path(), &pricing).unwrap();
        // No recent messages and reset_at stale → idle, not stuck.
        assert!(snap.five_hour.anchor.is_none(), "expected idle 5h window");
        assert_eq!(snap.five_hour.used, 0);
        assert!(snap.five_hour.resets_at.is_none());
    }

    #[test]
    fn stale_weekly_reset_rolls_forward() {
        let f = fresh_db();
        preferences::set_limits_source(f.path(), "jsonl").unwrap();
        // reset_at set 3 weeks ago → should roll forward to a future time.
        let conn = Connection::open(f.path()).unwrap();
        let past_reset: String = conn
            .query_row("SELECT datetime('now', '-21 days')", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        preferences::set_limit_reset_at(f.path(), "limits_weekly_reset_at", Some(&past_reset))
            .unwrap();
        let pricing = Pricing::embedded();
        let snap = compute_limits(f.path(), &pricing).unwrap();
        let next_reset = snap.weekly.resets_at.expect("rolled reset_at");
        // The rolled reset must be in the future.
        let conn = queries::open_ro(f.path()).unwrap();
        let future: i64 = conn
            .query_row(
                "SELECT CASE WHEN datetime(?) > datetime('now') THEN 1 ELSE 0 END",
                params![next_reset.clone()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(future, 1, "rolled weekly reset {next_reset} not in future");
    }

    #[test]
    fn oauth_source_returns_server_snapshot() {
        let f = fresh_db();
        preferences::set_limits_source(f.path(), "oauth").unwrap();
        preferences::set_limits_server_snapshot(
            f.path(),
            &preferences::LimitsServerSnapshot {
                five_hour_utilization: Some(0.42),
                five_hour_status: Some("allowed".into()),
                weekly_utilization: Some(0.18),
                weekly_status: Some("allowed".into()),
                synced_at: Some("2026-05-13T12:00:00Z".into()),
            },
        )
        .unwrap();
        preferences::set_limit_reset_at(
            f.path(),
            "limits_five_hour_reset_at",
            Some("2030-01-01T00:00:00Z"),
        )
        .unwrap();
        let pricing = Pricing::embedded();
        let snap = compute_limits(f.path(), &pricing).unwrap();
        assert_eq!(snap.five_hour.source, "server");
        assert_eq!(snap.weekly.source, "server");
        assert!(snap.five_hour.cap.is_none());
        assert_eq!(snap.five_hour.used, 0);
        assert!((snap.five_hour.pct_used - 0.42).abs() < 1e-9);
        assert!((snap.weekly.pct_used - 0.18).abs() < 1e-9);
        assert!(snap.five_hour.anchor.is_some());
        assert_eq!(
            snap.five_hour.resets_at.as_deref(),
            Some("2030-01-01T00:00:00Z")
        );
        assert_eq!(
            snap.meta.last_verified.as_deref(),
            Some("2026-05-13T12:00:00Z")
        );
    }

    #[test]
    fn oauth_source_with_no_snapshot_is_idle() {
        let f = fresh_db();
        preferences::set_limits_source(f.path(), "oauth").unwrap();
        let pricing = Pricing::embedded();
        let snap = compute_limits(f.path(), &pricing).unwrap();
        assert_eq!(snap.five_hour.source, "server");
        assert!(snap.five_hour.anchor.is_none(), "idle when no util");
        assert_eq!(snap.five_hour.pct_used, 0.0);
    }

    #[test]
    fn api_plan_has_no_caps() {
        let f = fresh_db();
        let pricing = Pricing::embedded();
        let snap = compute_limits(f.path(), &pricing).unwrap();
        assert_eq!(snap.plan, "api");
        assert!(snap.five_hour.cap.is_none());
        assert!(snap.weekly.cap.is_none());
    }
}
